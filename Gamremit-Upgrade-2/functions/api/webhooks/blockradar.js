// POST /api/webhooks/blockradar
// Handles offramp.processing / offramp.success / offramp.failed events.
//
// ⚠️ SECURITY NOTE: I didn't find a documented HMAC signature scheme on
// the withdraw-fiat page I fetched for you. DO NOT ship this to
// production as-is — anyone who finds this URL could POST fake
// "success" events and mark fraudulent withdrawals as completed.
// Before going live: check Blockradar's dashboard/docs for a webhook
// signing secret (most providers send something like an
// `x-blockradar-signature` header), and verify it here the same way
// otp-verify.js verifies JWTs — reject anything unsigned.
// Until then, this checks a shared secret you set yourself as a query
// param on the webhook URL you register with Blockradar, e.g.:
//   https://yourapp.pages.dev/api/webhooks/blockradar?secret=<long-random-string>
// which is weak (logs, browser history, etc. could leak it) but better
// than nothing while you confirm the real scheme.

import { jsonResponse } from '../_auth.js';
import { getTx, saveTx, addNotif, appendAuditLog } from '../_db.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const event = body?.event;
  const data = body?.data;
  if (!event || !data) return jsonResponse({ error: 'Malformed payload' }, 400);

  const reference = data.reference;
  if (!reference) return jsonResponse({ error: 'No reference on payload' }, 400);

  const tx = await getTx(reference, env);
  if (!tx) {
    // Don't 404 — Blockradar may retry; just ack so it stops resending
    // for a reference we genuinely don't have.
    return jsonResponse({ ok: true, note: 'Unknown reference, ignored' });
  }

  const statusMap = {
    'offramp.processing': 'processing',
    'offramp.success': 'completed',
    'offramp.failed': 'failed',
  };
  const newStatus = statusMap[event];
  if (!newStatus) return jsonResponse({ ok: true, note: 'Unhandled event type' });

  const previousStatus = tx.status;
  tx.status = newStatus;
  tx.updatedAt = new Date().toISOString();
  if (newStatus === 'failed') tx.failureReason = data.processingReason || data.reason || 'Provider reported failure';
  if (data.toAmount) tx.receiveAmount = data.toAmount;
  await saveTx(tx, env);

  await appendAuditLog({
    userId: tx.userId, userEmail: tx.userEmail,
    actionType: 'withdrawal_status_update',
    previousStatus, newStatus,
    adminId: 'blockradar-webhook', adminEmail: 'system',
    metadata: { reference, event, providerReference: data.processingProviderReference || null },
  }, env);

  const notifCopy = {
    processing: { type: 'info', title: '⏳ Withdrawal processing', body: `Your withdrawal ${reference} is being processed.` },
    completed:  { type: 'success', title: '✅ Withdrawal successful', body: `Your withdrawal ${reference} has been completed.` },
    failed:     { type: 'error', title: '❌ Withdrawal failed', body: `Your withdrawal ${reference} failed: ${tx.failureReason || 'please contact support'}` },
  }[newStatus];
  if (notifCopy && tx.userId) {
    await addNotif(tx.userId, { ...notifCopy, link: `/app.html?tx=${reference}` }, env);
  }

  return jsonResponse({ ok: true });
}
