// functions/api/transactions/[ref].js — handles /api/transactions/:ref
// This was missing: transactions.js is a flat file, which Cloudflare Pages
// Functions only routes to the EXACT path /api/transactions — never to
// sub-paths like /api/transactions/GR-ABC123-XYZ0. That's why every admin
// approve/reject/process click (PATCH /api/transactions/:ref) was 404ing
// silently. This file adds the missing dynamic-segment route.
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getTx, saveTx, addNotif, sendTelegram, sendEmail } from '../_db.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET;

  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const ref = (params.ref || '').toUpperCase();

  // ── GET single TX (public track by reference) ─────────────────
  if (request.method === 'GET') {
    const tx = await getTx(ref, env);
    if (!tx) return jsonResponse({ error: 'Transaction not found' }, 404);
    const { receiptBase64, ...safe } = tx;
    return jsonResponse({ success: true, transaction: safe });
  }

  // ── PATCH: admin updates status ───────────────────────────────
  if (request.method === 'PATCH') {
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim)                 return jsonResponse({ error: 'Unauthorized' }, 401);
    if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

    const tx = await getTx(ref, env);
    if (!tx) return jsonResponse({ error: 'Transaction not found' }, 404);

    let body;
    try { body = await request.json(); } catch { body = {}; }

    const { status, adminNote } = body;
    const valid = ['pending', 'processing', 'completed', 'rejected'];
    if (status && !valid.includes(status)) return jsonResponse({ error: 'Invalid status' }, 400);

    const prevStatus = tx.status;
    if (status) tx.status = status;
    if (adminNote !== undefined) tx.adminNote = adminNote;
    tx.updatedAt = new Date().toISOString();
    if (status === 'completed') tx.completedAt = new Date().toISOString();

    await saveTx(tx, env);

    if (status && status !== prevStatus) {
      const emoji = { pending: '⏳', processing: '🔄', completed: '✅', rejected: '❌' };
      await addNotif(tx.userId, {
        type: status === 'completed' ? 'success' : status === 'rejected' ? 'error' : 'info',
        title: `${emoji[status]} Transfer ${status}`,
        body: `Your transfer ${ref} is now ${status}.${adminNote ? ' Note: ' + adminNote : ''}`,
        link: '/app.html#track'
      }, env);
      await sendTelegram(
        `${emoji[status]} *Transfer ${status.toUpperCase()}*\nRef: \`${ref}\`\nUser: ${tx.userName}\n${prevStatus} → ${status}${adminNote ? '\nNote: ' + adminNote : ''}`, env
      );

      // Email the USER directly on approval or rejection — these are the
      // two outcomes someone is actively waiting to hear about.
      if (tx.userEmail && (status === 'completed' || status === 'rejected')) {
        try {
          const isApproved = status === 'completed';
          await sendEmail({
            to: tx.userEmail,
            subject: isApproved
              ? `✅ Your GamRemit transfer ${ref} was approved`
              : `❌ Your GamRemit transfer ${ref} was rejected`,
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:auto">
                <h2 style="color:${isApproved ? '#00D48C' : '#FF4D6A'}">
                  ${isApproved ? 'Transfer Approved ✅' : 'Transfer Rejected ❌'}
                </h2>
                <p style="font-size:14px;color:#333">Hi ${tx.userName || ''},</p>
                <p style="font-size:14px;color:#333">
                  ${isApproved
                    ? `Your transfer has been approved and is being processed.`
                    : `Unfortunately, your transfer could not be approved.`}
                </p>
                <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
                  <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${ref}</td></tr>
                  <tr><td style="padding:6px 0;color:#666">Sent</td><td style="padding:6px 0;font-weight:600">${tx.sendAmount?.toLocaleString?.() ?? tx.sendAmount} ${tx.sendCurrency}</td></tr>
                  <tr><td style="padding:6px 0;color:#666">Recipient Gets</td><td style="padding:6px 0;font-weight:600">${typeof tx.receiveAmount === 'number' ? tx.receiveAmount.toLocaleString() : tx.receiveAmount} ${tx.receiveCurrency}</td></tr>
                  ${!isApproved && adminNote ? `<tr><td style="padding:6px 0;color:#666">Reason</td><td style="padding:6px 0;font-weight:600;color:#FF4D6A">${adminNote}</td></tr>` : ''}
                </table>
                ${!isApproved ? `<p style="font-size:13px;color:#666;margin-top:16px">If you believe this was a mistake, or would like to resubmit with corrected details, please contact support or try again from your dashboard.</p>` : ''}
                <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/app.html#track" style="color:#1246F5">View in GamRemit →</a></p>
              </div>`
          }, env);
        } catch (e) { console.error('[tx:notify-user-email]', e.message); }
      }
    }

    const { receiptBase64: _r, ...safeTx } = tx;
    return jsonResponse({ success: true, transaction: safeTx });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
