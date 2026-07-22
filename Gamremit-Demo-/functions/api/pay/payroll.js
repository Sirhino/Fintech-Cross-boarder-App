// functions/api/pay/payroll.js — Bulk USDC payroll
// Executes REAL on-chain Circle transfers, one per recipient, from the
// batch creator's own Circle wallet. Recipients may be given as a raw
// 0x address or a registered "name.arc" handle (resolved via arc_names).
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, addNotif, saveTx, generateRef, resolveWalletInput } from '../_db.js';
import { getUsdcBalance, transferUsdc } from '../_circle.js';

async function getPayrollBatches(userId, env) {
  if (!env?.DB) return [];
  const res = await env.DB.prepare('SELECT data FROM payroll WHERE user_id = ? ORDER BY id DESC').bind(userId).all();
  return (res.results || []).map(r => JSON.parse(r.data));
}
async function savePayrollBatch(userId, batchId, batch, env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    `INSERT INTO payroll (id, user_id, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).bind(batchId, userId, JSON.stringify(batch)).run();
}

export async function onRequest({ request, env }) {
 try {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // GET /api/pay/payroll — list payroll batches
  if (request.method === 'GET') {
    const batches = await getPayrollBatches(user.id, env);
    return jsonResponse({ success: true, batches });
  }

  // POST /api/pay/payroll — execute payroll batch
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { recipients, title, scheduledFor } = body;
    if (!Array.isArray(recipients) || recipients.length === 0)
      return jsonResponse({ error: 'Recipients array required' }, 400);
    if (recipients.length > 100)
      return jsonResponse({ error: 'Max 100 recipients per batch' }, 400);

    const walletId = user.circleWalletId || user.walletId;
    if (!walletId) return jsonResponse({ error: 'No Circle wallet found on your account yet.' }, 400);

    // Validate rows + resolve wallet/.arc name -> real 0x address up front,
    // before moving any money.
    const errors = [];
    const resolved = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const name = r.name?.trim();
      const amount = parseFloat(r.amount);
      if (!name) { errors.push(`Row ${i + 1}: name required`); continue; }
      if (!amount || isNaN(amount) || amount <= 0) { errors.push(`Row ${i + 1}: invalid amount`); continue; }
      const { address, error } = await resolveWalletInput(r.wallet, env);
      if (error) { errors.push(`Row ${i + 1} (${name}): ${error}`); continue; }
      resolved.push({ name, wallet: r.wallet, address, amount });
    }
    if (errors.length) return jsonResponse({ error: errors[0], errors }, 400);

    // Scheduled batches aren't executed now — save them as-is for a future
    // run (there's no cron/queue wired up yet to actually execute these).
    if (scheduledFor) {
      const batchId = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const totalAmount = resolved.reduce((s, r) => s + r.amount, 0);
      const batch = {
        id: batchId,
        title: title?.trim() || `Payroll ${new Date().toLocaleDateString('en-GB')}`,
        creatorId: user.id,
        creatorEmail: user.email,
        recipients: resolved.map(r => ({ ...r, status: 'scheduled', txHash: null, circleTxId: null, sentAt: null })),
        totalRecipients: resolved.length,
        totalAmount: totalAmount.toFixed(6),
        currency: 'USDC',
        status: 'scheduled',
        scheduledFor,
        executedAt: null,
        createdAt: new Date().toISOString(),
        networkFee: null,
      };
      await savePayrollBatch(user.id, batchId, batch, env);
      return jsonResponse({ success: true, batch }, 201);
    }

    // ── Real balance check before moving a single dollar ─────────────
    const totalAmount = resolved.reduce((s, r) => s + r.amount, 0);
    let balance;
    try {
      balance = await getUsdcBalance(walletId, env);
    } catch (e) {
      return jsonResponse({ error: `Could not verify your balance: ${e.message}` }, 502);
    }
    if (totalAmount > balance) {
      return jsonResponse({ error: `Insufficient USDC balance. You have ${balance} USDC, this payroll needs ${totalAmount.toFixed(6)} USDC.` }, 400);
    }

    // ── Execute real Circle transfers, one per recipient ──────────────
    // Sequential on purpose: each transfer needs its own fresh entity-secret
    // ciphertext (Circle rejects reuse), and this keeps a clean per-row
    // success/failure record if one recipient's transfer fails partway
    // through the batch — the rest still go out.
    const processed = [];
    for (const r of resolved) {
      try {
        const result = await transferUsdc(env, { walletId, destinationAddress: r.address, amount: r.amount });
        processed.push({
          name: r.name,
          wallet: r.wallet,
          address: r.address,
          amount: r.amount.toFixed(6),
          status: result?.state === 'COMPLETE' ? 'sent' : 'processing',
          circleTxId: result?.id || null,
          txHash: result?.txHash || null,
          sentAt: new Date().toISOString(),
        });
      } catch (e) {
        processed.push({
          name: r.name,
          wallet: r.wallet,
          address: r.address,
          amount: r.amount.toFixed(6),
          status: 'failed',
          error: e.message || 'Transfer failed',
          circleTxId: null,
          txHash: null,
          sentAt: new Date().toISOString(),
        });
      }
    }

    const failedCount = processed.filter(p => p.status === 'failed').length;
    const sentTotal = processed.filter(p => p.status !== 'failed').reduce((s, p) => s + parseFloat(p.amount), 0);
    const batchId = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const batch = {
      id: batchId,
      title: title?.trim() || `Payroll ${new Date().toLocaleDateString('en-GB')}`,
      creatorId: user.id,
      creatorEmail: user.email,
      recipients: processed,
      totalRecipients: processed.length,
      totalAmount: sentTotal.toFixed(6),
      currency: 'USDC',
      status: failedCount === 0 ? 'completed' : failedCount === processed.length ? 'failed' : 'completed_with_errors',
      scheduledFor: null,
      executedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      networkFee: (processed.length * 0.001).toFixed(6),
    };

    await savePayrollBatch(user.id, batchId, batch, env);

    const ref = generateRef();
    await saveTx({
      reference: ref,
      userId: user.id,
      userEmail: user.email,
      type: 'payroll',
      sendAmount: sentTotal,
      sendCurrency: 'USDC',
      status: batch.status,
      recipientName: `${processed.length} recipients`,
      createdAt: batch.createdAt,
    }, env);

    await addNotif(user.id, {
      type: failedCount === 0 ? 'success' : 'error',
      title: failedCount === 0 ? '✅ Payroll sent' : `⚠️ Payroll sent with ${failedCount} failure(s)`,
      body: `${batch.title}: ${processed.length - failedCount}/${processed.length} recipients paid, ${sentTotal.toFixed(2)} USDC total.`,
      link: '/app.html#payroll',
    }, env);

    return jsonResponse({ success: true, batch }, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
 } catch (e) {
  console.error('[payroll]', e.message);
  return jsonResponse({ error: e.message || 'Payroll failed unexpectedly' }, 502);
 }
}

export async function onRequestOptions() { return optionsResponse(); }
