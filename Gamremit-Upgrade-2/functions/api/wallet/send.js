// functions/api/wallet/send.js — send USDC or EURC from the user's Circle wallet
// to any address on Arc Testnet.
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveTx, generateRef, addNotif, pushAdminNotif, sendEmail, resolveWalletInput } from '../_db.js';
import { transferToken, getAllBalances } from '../_circle.js';

const ADMIN_EMAIL = 'gamremit.arc@gmail.com';

export async function onRequestPost({ request, env }) {
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

    const user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    const walletId = user.circleWalletId || user.walletId;
    if (!walletId) return jsonResponse({ error: 'No Circle wallet on this account yet' }, 400);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { symbol, destinationAddress: rawDestination, amount } = body;
    const sym = String(symbol || 'USDC').toUpperCase();
    if (!['USDC', 'EURC'].includes(sym)) return jsonResponse({ error: 'Only USDC and EURC are supported right now' }, 400);
    const { address: destinationAddress, error: resolveErr } = await resolveWalletInput(rawDestination, env);
    if (resolveErr) return jsonResponse({ error: resolveErr }, 400);
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt) || amt <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);

    const balances = await getAllBalances(walletId, env);
    const bal = balances.find(b => b.symbol === sym)?.amount ?? 0;
    if (amt > bal) return jsonResponse({ error: `Insufficient ${sym} balance. You have ${bal} ${sym}.` }, 400);

    const result = await transferToken(env, { walletId, destinationAddress, amount: amt, symbol: sym });

    const ref = generateRef();
    const tx = {
      reference: ref,
      userId: user.id,
      userName: `${user.firstName} ${user.lastName}`,
      type: 'wallet_send',
      sendAmount: amt,
      sendCurrency: sym,
      receiveAmount: amt,
      receiveCurrency: sym,
      recipientName: destinationAddress,
      status: result?.state === 'COMPLETE' ? 'completed' : 'processing',
      circleTxId: result?.id || null,
      createdAt: new Date().toISOString(),
    };
    await saveTx(tx, env);

    const shortAddr = `${destinationAddress.slice(0,6)}...${destinationAddress.slice(-4)}`;

    await addNotif(user.id, {
      type: 'info',
      title: `📤 Sent ${amt} ${sym}`,
      body: `You sent ${amt} ${sym} to ${shortAddr}`,
      link: '/app.html#history'
    }, env);

    try {
      await sendEmail({
        to: user.email,
        subject: `📤 You sent ${amt} ${sym}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#1246F5">Withdrawal Sent</h2>
            <p style="font-size:14px;color:#333">Hi ${user.firstName || ''}, your GamRemit wallet just sent out ${sym}.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0;font-weight:600">${amt} ${sym}</td></tr>
              <tr><td style="padding:6px 0;color:#666">To</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${destinationAddress}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${ref}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Status</td><td style="padding:6px 0;font-weight:600">${tx.status}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Time</td><td style="padding:6px 0;font-weight:600">${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Banjul' })}</td></tr>
            </table>
            <p style="font-size:12px;color:#999;margin-top:10px">If you didn't authorize this, contact support@gamremit.com immediately.</p>
            <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/app.html#history" style="color:#1246F5">View in GamRemit →</a></p>
          </div>`,
      }, env);

      await pushAdminNotif({
        type: 'tx',
        title: `📤 Wallet send — ${amt} ${sym}`,
        body: `${user.email} sent ${amt} ${sym} to ${shortAddr}. Ref: ${ref}`,
        link: `/admin.html?user=${user.id}`,
      }, env);

      // Admin gets the in-app bell for every send, but only an EMAIL for
      // large ones — same reasoning as deposits. Tune this as volume grows.
      const LARGE_SEND_AMOUNT_THRESHOLD = 500; // in token units (USDC/EURC ≈ USD/EUR)
      if (Number(amt) >= LARGE_SEND_AMOUNT_THRESHOLD) {
        await sendEmail({
          to: ADMIN_EMAIL,
          subject: `📤 Large outbound send — ${user.email} (${amt} ${sym})`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto">
              <h2 style="color:#1246F5">Large Wallet Debit</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 0;color:#666">User</td><td style="padding:6px 0;font-weight:600">${user.email}</td></tr>
                <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0;font-weight:600">${amt} ${sym}</td></tr>
                <tr><td style="padding:6px 0;color:#666">Destination</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${destinationAddress}</td></tr>
                <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${ref}</td></tr>
                <tr><td style="padding:6px 0;color:#666">Status</td><td style="padding:6px 0;font-weight:600">${tx.status}</td></tr>
              </table>
              <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/admin.html?user=${user.id}" style="color:#1246F5">Review in Admin Panel →</a></p>
            </div>`,
        }, env);
      }
    } catch (e) { console.error('[wallet:send:notify]', e.message); }

    return jsonResponse({ success: true, reference: ref, circleTx: result }, 201);
  } catch (e) {
    console.error('[wallet:send]', e.message);
    return jsonResponse({ error: e.message || 'Send failed unexpectedly' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
