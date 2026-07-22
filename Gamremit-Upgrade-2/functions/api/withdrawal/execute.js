// POST /api/withdrawal/execute
// body: { quoteId, recipientName }
//
// REAL FLOW (no demo/ledger fakery):
//   1. Validate the stashed quote.
//   2. Check the user's ACTUAL on-chain USDC balance via Circle.
//   3. Transfer USDC on-chain from the user's Circle wallet to GamRemit's
//      Blockradar deposit address.
//   4. Save the withdrawal as 'transferring_onchain' — Blockradar's fiat
//      payout is NOT triggered yet. status/[id].js polls the Circle
//      transaction; once it reaches COMPLETE, it kicks off the Blockradar
//      quote+execute call. This two-leg model is required because the
//      user's own funds (held in their Circle wallet) and Blockradar's
//      payout wallet are two separate custodial systems — there's no way
//      to disburse fiat against money that hasn't actually arrived yet.
import { jsonResponse, optionsResponse, fromRequest } from '../_auth.js';
import { getUser, saveTx, addNotif, pushAdminNotif, generateRef, appendAuditLog, sendTelegram, assessWithdrawalRisk, autoFlagForReview } from '../_db.js';
import { getUsdcBalance, transferUsdc } from '../_circle.js';

export async function onRequestPost({ request, env }) {
 try {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { quoteId, recipientName } = body || {};
  if (!quoteId) return jsonResponse({ error: 'quoteId is required' }, 400);

  const quoteRaw = await env.GAMREMIT_KV.get(`br:quote:${quoteId}`);
  if (!quoteRaw) return jsonResponse({ error: 'Quote expired — please request a new quote' }, 410);
  const quote = JSON.parse(quoteRaw);
  if (quote.userId !== payload.id) return jsonResponse({ error: 'Forbidden' }, 403);

  const user = await getUser(payload.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  if (user.status === 'suspended' || user.status === 'frozen' || user.status === 'closed') {
    return jsonResponse({ error: 'Your account cannot make withdrawals right now. Contact support@gamremit.com' }, 403);
  }
  if (user.kycStatus !== 'approved') {
    return jsonResponse({ error: 'KYC approval is required before withdrawing. Please complete verification first.' }, 403);
  }
  const walletId = user.circleWalletId || user.walletId;
  if (!walletId) {
    return jsonResponse({ error: 'No wallet found on your account. Please set up your wallet first.' }, 400);
  }
  if (!env.BLOCKRADAR_DEPOSIT_ADDRESS) {
    return jsonResponse({ error: 'Withdrawals are temporarily unavailable. Please try again shortly.' }, 503);
  }

  // ── Real balance check — no fake numbers ──────────────────────────
  let balance;
  try {
    balance = await getUsdcBalance(walletId, env);
  } catch (e) {
    return jsonResponse({ error: `Could not verify your balance: ${e.message}` }, 502);
  }
  if (balance < quote.usdcAmount) {
    return jsonResponse({ error: `Insufficient USDC balance. You have ${balance} USDC, this withdrawal needs ${quote.usdcAmount} USDC.` }, 400);
  }

  // ── Fraud signals — checked before a single dollar moves ──────────
  const risk = await assessWithdrawalRisk(user, quote.usdcAmount, quote.currency, env);
  if (risk.level === 'critical') {
    await autoFlagForReview(
      user,
      `Withdrawal blocked at execution: ${risk.score}/100 risk score (${risk.signals.map(s => s.code).join(', ')})`,
      risk.signals,
      env
    );
    await appendAuditLog({
      userId: payload.id, userEmail: payload.email,
      actionType: 'withdrawal_blocked_high_risk',
      adminId: 'system-auto-fraud', adminEmail: 'system-auto-fraud',
      metadata: { amount: quote.usdcAmount, currency: quote.currency, riskScore: risk.score, signals: risk.signals },
    }, env);
    return jsonResponse({
      error: 'This withdrawal has been held for review. Our team has been notified and will reach out shortly. Contact support@gamremit.com if urgent.',
    }, 423);
  }
  if (risk.level === 'high') {
    // Don't block — but flag the account and make sure a human sees this
    // specific withdrawal, since it's proceeding despite elevated risk.
    await autoFlagForReview(
      user,
      `Elevated-risk withdrawal allowed but flagged: ${risk.score}/100 (${risk.signals.map(s => s.code).join(', ')})`,
      risk.signals,
      env
    );
  }

  const reference = generateRef();

  // ── Step 1 of 2: move the user's real USDC on-chain ───────────────
  let circleTx;
  try {
    circleTx = await transferUsdc(env, {
      walletId,
      destinationAddress: env.BLOCKRADAR_DEPOSIT_ADDRESS,
      amount: quote.usdcAmount,
    });
  } catch (e) {
    await appendAuditLog({
      userId: payload.id, userEmail: payload.email,
      actionType: 'withdrawal_onchain_transfer_failed',
      adminId: 'system', adminEmail: 'system',
      reason: e.message,
      metadata: { reference, amount: quote.usdcAmount, currency: quote.currency },
    }, env);
    return jsonResponse({ error: e.message || 'On-chain transfer failed' }, e.status || 502);
  }

  const tx = {
    reference,
    userId: payload.id,
    userEmail: payload.email,
    type: 'withdrawal',
    status: 'transferring_onchain', // -> pending -> processing -> completed/failed
    sendAmount: quote.usdcAmount,
    sendCurrency: 'USDC',
    receiveCurrency: quote.currency,
    receiveAmount: null,
    recipientName: recipientName || null,
    bankName: quote.institutionCode,
    accountNumber: quote.accountNumber,
    institutionCode: quote.institutionCode,
    assetId: quote.assetId,
    circleTransactionId: circleTx.id,
    circleWalletId: walletId,
    networkFee: 0,
    riskScore: risk.score,
    riskLevel: risk.level,
    createdAt: new Date().toISOString(),
  };
  await saveTx(tx, env);

  await appendAuditLog({
    userId: payload.id, userEmail: payload.email,
    actionType: 'withdrawal_onchain_transfer_initiated',
    adminId: 'system', adminEmail: 'system',
    metadata: { reference, circleTransactionId: circleTx.id, amount: quote.usdcAmount, currency: quote.currency },
  }, env);

  await addNotif(payload.id, {
    type: 'info',
    title: '🏦 Withdrawal started',
    body: `${quote.usdcAmount} USDC withdrawal to ${quote.currency} is in progress. Ref: ${reference}`,
    link: `/withdraw.html`,
  }, env);

  await pushAdminNotif({
    type: 'tx',
    title: '🏦 New withdrawal (on-chain leg started)',
    body: `${payload.email} withdrawing ${quote.usdcAmount} USDC → ${quote.currency} (${reference})`,
    link: `/admin.html?tx=${reference}`,
  }, env);

  sendTelegram(
    `🏦 *Withdrawal started*\n👤 ${payload.email}\n💵 ${quote.usdcAmount} USDC → ${quote.currency}\n🔖 Ref: ${reference}\n⛓️ Circle tx: ${circleTx.id}`,
    env
  ).catch(() => {});

  await env.GAMREMIT_KV.delete(`br:quote:${quoteId}`);

  return jsonResponse({
    reference,
    status: 'transferring_onchain',
    circleTransactionId: circleTx.id,
  });
 } catch (e) {
  console.error('[withdrawal:execute]', e.message);
  return jsonResponse({ error: e.message || 'Withdrawal could not be started. Please try again.' }, e.status || 502);
 }
}
export async function onRequestOptions() { return optionsResponse(); }
