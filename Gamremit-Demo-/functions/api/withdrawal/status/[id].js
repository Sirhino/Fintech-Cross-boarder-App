// GET /api/withdrawal/status/:id  (id = the GR-xxxx reference)
//
// This endpoint does more than read a record — it's the reconciliation
// point between the two real custodial legs:
//   1. Circle (user's on-chain USDC -> GamRemit's Blockradar deposit address)
//   2. Blockradar (USDC -> fiat payout)
// Cloudflare Pages Functions have no background workers/cron in this
// project, so we check-and-advance lazily, on read. Every poll from the
// frontend is also a chance to move the withdrawal to its next real state.
import { jsonResponse, optionsResponse, fromRequest } from '../../_auth.js';
import { getTx, saveTx, addNotif, appendAuditLog, pushAdminNotif, sendTelegram } from '../../_db.js';
import { getCircleTransaction, CIRCLE_TERMINAL_STATES } from '../../_circle.js';
import { getQuote, executeWithdrawal } from '../_blockradar.js';

export async function onRequestGet({ request, env, params }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  let tx = await getTx(params.id, env);
  if (!tx) return jsonResponse({ error: 'Not found' }, 404);
  if (tx.userId !== payload.id && payload.role !== 'admin') {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  if (tx.status === 'transferring_onchain' && tx.circleTransactionId) {
    tx = await advanceOnchainLeg(tx, env);
  }

  return jsonResponse({
    reference: tx.reference,
    status: tx.status,
    sendAmount: tx.sendAmount,
    sendCurrency: tx.sendCurrency,
    receiveAmount: tx.receiveAmount,
    receiveCurrency: tx.receiveCurrency,
    providerRef: tx.providerRef,
    circleTransactionId: tx.circleTransactionId,
    failureReason: tx.failureReason || null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt || tx.createdAt,
  });
}

async function advanceOnchainLeg(tx, env) {
  let circleTx;
  try {
    circleTx = await getCircleTransaction(env, tx.circleTransactionId);
  } catch {
    return tx; // transient — leave state as-is, frontend will poll again
  }

  if (!CIRCLE_TERMINAL_STATES.includes(circleTx.state)) {
    return tx; // still INITIATED/QUEUED/SENT/CONFIRMED/etc — not our turn yet
  }

  if (circleTx.state !== 'COMPLETE') {
    // FAILED / DENIED / CANCELLED — the user's USDC never left (or reverted).
    // Nothing was disbursed; this is a true failure, not a partial state.
    tx.status = 'failed';
    tx.failureReason = `On-chain transfer ${circleTx.state.toLowerCase()}${circleTx.errorReason ? `: ${circleTx.errorReason}` : ''}`;
    tx.updatedAt = new Date().toISOString();
    await saveTx(tx, env);
    await appendAuditLog({
      userId: tx.userId, userEmail: tx.userEmail,
      actionType: 'withdrawal_onchain_transfer_failed_terminal',
      previousStatus: 'transferring_onchain', newStatus: 'failed',
      adminId: 'system', adminEmail: 'system',
      metadata: { reference: tx.reference, circleState: circleTx.state },
    }, env);
    await addNotif(tx.userId, {
      type: 'error', title: '❌ Withdrawal failed',
      body: `Your withdrawal ${tx.reference} could not be processed: ${tx.failureReason}`,
      link: '/withdraw.html',
    }, env);
    return tx;
  }

  // On-chain leg confirmed COMPLETE — the USDC has genuinely arrived in
  // GamRemit's Blockradar wallet. Only now do we trigger the fiat payout.
  try {
    const res = await getQuote(env, {
      assetId: tx.assetId,
      amount: tx.sendAmount,
      currency: tx.receiveCurrency,
      accountIdentifier: tx.accountNumber,
      institutionIdentifier: tx.institutionCode,
    });
    const q = res.data || {};

    const execRes = await executeWithdrawal(env, {
      assetId: tx.assetId,
      amount: String(tx.sendAmount),
      currency: tx.receiveCurrency,
      accountIdentifier: tx.accountNumber,
      institutionIdentifier: tx.institutionCode,
      reference: tx.reference,
      metadata: { userId: tx.userId, userEmail: tx.userEmail },
      note: `GamRemit withdrawal — ${tx.userEmail}`,
    });
    const d = execRes.data || {};

    tx.status = 'pending'; // Blockradar's own webhook now drives processing/completed/failed
    tx.providerRef = d.id;
    tx.receiveAmount = d.toAmount ?? q.toAmount ?? tx.receiveAmount;
    tx.networkFee = d.fee ?? q.fee ?? 0;
    tx.txHash = circleTx.txHash;
    tx.updatedAt = new Date().toISOString();
    await saveTx(tx, env);

    await appendAuditLog({
      userId: tx.userId, userEmail: tx.userEmail,
      actionType: 'withdrawal_fiat_payout_initiated',
      previousStatus: 'transferring_onchain', newStatus: 'pending',
      adminId: 'system', adminEmail: 'system',
      metadata: { reference: tx.reference, providerRef: d.id, txHash: circleTx.txHash },
    }, env);
  } catch (e) {
    // The USDC has landed in our wallet but Blockradar rejected the payout
    // (bad account, provider outage, etc). This is now an OPERATIONAL
    // problem, not the user's fault — flag it for manual admin follow-up
    // rather than silently marking it failed, since the funds are real
    // and sitting in GamRemit's wallet.
    tx.status = 'payout_failed_needs_review';
    tx.failureReason = e.message;
    tx.updatedAt = new Date().toISOString();
    await saveTx(tx, env);
    await appendAuditLog({
      userId: tx.userId, userEmail: tx.userEmail,
      actionType: 'withdrawal_fiat_payout_failed',
      previousStatus: 'transferring_onchain', newStatus: 'payout_failed_needs_review',
      adminId: 'system', adminEmail: 'system',
      reason: e.message,
      metadata: { reference: tx.reference },
    }, env);
    await pushAdminNotif({
      type: 'alert',
      title: '🚨 Funds landed, payout failed — needs manual review',
      body: `${tx.userEmail}'s ${tx.sendAmount} USDC arrived in our Blockradar wallet but the fiat payout to ${tx.receiveCurrency} failed: ${e.message}. Ref: ${tx.reference}`,
      link: `/admin.html?tx=${tx.reference}`,
    }, env);
    sendTelegram(
      `🚨 *STUCK WITHDRAWAL — needs manual review*\n👤 ${tx.userEmail}\n💵 ${tx.sendAmount} USDC landed in our wallet\n❌ Payout to ${tx.receiveCurrency} failed: ${e.message}\n🔖 Ref: ${tx.reference}`,
      env
    ).catch(() => {});
  }

  return tx;
}

export async function onRequestOptions() { return optionsResponse(); }
