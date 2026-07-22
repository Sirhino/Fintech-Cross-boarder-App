// POST /api/webhooks/circle
// Subscribe this URL in the Circle Developer Console (Wallets -> Webhook
// Subscriptions) so Circle calls it whenever a wallet's transaction
// changes state. We only act on INBOUND transfers (deposits) that reach
// COMPLETE — that's the moment USDC has genuinely landed in a user's
// wallet.
//
// Enforcement: every KYC tier (see KYC_TIERS in _db.js) already has a
// maxGMD ceiling for a single transfer. If a single deposit's GMD
// equivalent exceeds what the user's current approved tier allows,
// the account is auto-frozen immediately — no admin has to notice it
// first. Per your instructions: unfreezing is a manual admin action,
// done after a phone call to verify the customer (or after they
// complete a KYC tier upgrade).
import { jsonResponse } from '../_auth.js';
import {
  getUserByWalletId, saveUser, saveTx, getTxByCircleTxId, getKycTierByLevel, generateRef,
  appendAuditLog, addNotif, pushAdminNotif, sendTelegram, sendEmail, getRates,
} from '../_db.js';
import { verifyCircleWebhookSignature, getTokenSymbolById } from '../_circle.js';

const ADMIN_EMAIL = 'gamremit.arc@gmail.com';

// Uses the SAME admin-editable rate (USDC-GMD) shown and edited in the
// Rates panel of admin.html — not a hardcoded number. If the admin
// updates it there, this webhook picks up the new rate on the very next
// deposit, no redeploy needed.
async function toGMD(amount, env) {
  const rates = await getRates(env);
  const pair = rates['USDC-GMD'];
  const rate = pair?.active ? pair.rate : 61.73; // fallback only if the pair is missing/disabled
  return amount * rate;
}

// Catch-all for HEAD, OPTIONS, or any other method Circle uses to verify the endpoint
export async function onRequest({ request, env }) {
  if (request.method === 'POST') {
    return onRequestPost({ request, env });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// HEAD handler — Circle uses this to verify the endpoint is reachable
export async function onRequestHead() {
  return new Response(null, { status: 200 });
}

// GET handler for Circle's endpoint verification ping
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const keyId = request.headers.get('x-circle-key-id');
  const signatureB64 = request.headers.get('x-circle-signature');

  const verified = await verifyCircleWebhookSignature(env, { keyId, signatureB64, rawBody });
  if (!verified) {
    console.error('[webhook:circle] Signature verification failed — rejecting');
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const notification = payload?.notification;
  if (!notification) return jsonResponse({ ok: true, note: 'No notification payload' });

  const { transactionType, state, walletId, amounts, tokenId, txHash, id: circleTransactionId } = notification;

  // ── OUTBOUND: update a wallet_send tx we already saved synchronously ──
  // transferToken()'s immediate response is often still PENDING/INITIATED
  // at the moment wallet/send.js first calls saveTx — this is where that
  // record actually gets marked completed (or failed) once Circle confirms
  // it, so the History tab doesn't show a send stuck on "processing" forever.
  if (transactionType === 'OUTBOUND') {
    if (!['COMPLETE', 'FAILED', 'CANCELLED'].includes(state)) {
      return jsonResponse({ ok: true, note: 'Outbound event not in a final state yet' });
    }
    const existingTx = await getTxByCircleTxId(circleTransactionId, env);
    if (!existingTx) return jsonResponse({ ok: true, note: 'No matching wallet_send tx for this Circle transaction' });

    const newStatus = state === 'COMPLETE' ? 'completed' : 'failed';
    if (existingTx.status === newStatus) return jsonResponse({ ok: true, note: 'Already up to date' });

    existingTx.status = newStatus;
    existingTx.txHash = txHash || existingTx.txHash || null;
    await saveTx(existingTx, env);

    try {
      const user = await getUserByWalletId(walletId, env);
      if (user) {
        const label = newStatus === 'completed' ? '✅ confirmed' : '❌ failed';
        await addNotif(user.id, {
          type: newStatus === 'completed' ? 'success' : 'error',
          title: `${newStatus === 'completed' ? '✅' : '❌'} Send ${label}`,
          body: `Your transfer of ${existingTx.sendAmount} ${existingTx.sendCurrency} to ${existingTx.recipientName} is now ${newStatus}. Ref: ${existingTx.reference}`,
          link: '/app.html#history',
        }, env);
        await sendEmail({
          to: user.email,
          subject: `${newStatus === 'completed' ? '✅' : '❌'} Your ${existingTx.sendCurrency} transfer is ${newStatus}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto">
              <h2 style="color:#1246F5">Transfer ${newStatus === 'completed' ? 'Confirmed' : 'Failed'}</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0;font-weight:600">${existingTx.sendAmount} ${existingTx.sendCurrency}</td></tr>
                <tr><td style="padding:6px 0;color:#666">To</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${existingTx.recipientName}</td></tr>
                <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${existingTx.reference}</td></tr>
                ${txHash ? `<tr><td style="padding:6px 0;color:#666">Tx Hash</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${txHash}</td></tr>` : ''}
              </table>
              <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/app.html#history" style="color:#1246F5">View in GamRemit →</a></p>
            </div>`,
        }, env);
      }
    } catch (e) { console.error('[webhook:circle:outbound-notify]', e.message); }

    return jsonResponse({ ok: true, updated: newStatus });
  }

  // We only care about completed inbound transfers (deposits) past this point.
  if (transactionType !== 'INBOUND' || state !== 'COMPLETE') {
    return jsonResponse({ ok: true, note: 'Not an actionable deposit event' });
  }
  if (!walletId || !amounts?.length) return jsonResponse({ ok: true, note: 'Malformed deposit payload' });

  const user = await getUserByWalletId(walletId, env);
  if (!user) {
    // Not necessarily an error — could be a wallet outside our user base
    // (e.g. a treasury/ops wallet). Ack so Circle stops retrying.
    return jsonResponse({ ok: true, note: 'No matching user for this wallet' });
  }

  const amount = parseFloat(amounts[0]);
  if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ ok: true, note: 'Non-positive amount, ignored' });

  // Circle's webhook only gives us tokenId (an internal UUID), never a
  // symbol — resolve it so USDC and EURC deposits are labelled correctly
  // everywhere (transaction history, emails, GMD conversion). Falls back
  // to USDC if the lookup fails, preserving the old default behavior.
  const symbol = (await getTokenSymbolById(tokenId, env)) || 'USDC';

  const amountGMD = await toGMD(amount, env);

  // Record the deposit as a transaction either way, for a complete history.
  const reference = generateRef();
  const depositTx = {
    reference,
    userId: user.id,
    userEmail: user.email,
    type: 'deposit',
    status: 'completed',
    sendAmount: amount,
    sendCurrency: symbol,
    receiveAmount: amount,
    receiveCurrency: symbol,
    amountGMD: Math.round(amountGMD),
    circleTransactionId,
    txHash: txHash || null,
    createdAt: new Date().toISOString(),
  };
  await saveTx(depositTx, env);

  // ── Notify the user + admin that USDC/EURC has landed ──────────────
  // Fires on every completed inbound transfer, independent of whatever
  // the tier-limit check below decides to do with the account.
  try {
    await addNotif(user.id, {
      type: 'success',
      title: `💰 ${amount} ${symbol} received`,
      body: `Your wallet was just credited with ${amount} ${symbol}. Ref: ${reference}`,
      link: '/app.html#history',
    }, env);

    await sendEmail({
      to: user.email,
      subject: `💰 You received ${amount} ${symbol}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1246F5">Deposit Received</h2>
          <p style="font-size:14px;color:#333">Hi ${user.firstName || ''}, your GamRemit wallet was just credited.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0;font-weight:600">${amount} ${symbol}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${reference}</td></tr>
            ${txHash ? `<tr><td style="padding:6px 0;color:#666">Tx Hash</td><td style="padding:6px 0;font-weight:600;word-break:break-all">${txHash}</td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#666">Time</td><td style="padding:6px 0;font-weight:600">${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Banjul' })}</td></tr>
          </table>
          <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/app.html#history" style="color:#1246F5">View in GamRemit →</a></p>
        </div>`,
    }, env);

    await pushAdminNotif({
      type: 'tx',
      title: `💰 Deposit — ${amount} ${symbol}`,
      body: `${user.email} was credited ${amount} ${symbol} (~${Math.round(amountGMD).toLocaleString()} GMD). Ref: ${reference}`,
      link: `/admin.html?user=${user.id}`,
    }, env);

    // Admin gets an in-app bell notification for every deposit above, but
    // only an EMAIL for large ones — routine small deposits don't need
    // your inbox, they're already visible in the admin panel. Tune
    // LARGE_DEPOSIT_GMD_THRESHOLD as your volume grows.
    const LARGE_DEPOSIT_GMD_THRESHOLD = 25000; // ~ adjust to your risk comfort
    if (amountGMD >= LARGE_DEPOSIT_GMD_THRESHOLD) {
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `💰 Large deposit — ${user.email} (${amount} ${symbol})`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#1246F5">Large Deposit — Wallet Credited</h2>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:6px 0;color:#666">User</td><td style="padding:6px 0;font-weight:600">${user.email}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0;font-weight:600">${amount} ${symbol}</td></tr>
              <tr><td style="padding:6px 0;color:#666">GMD Equivalent</td><td style="padding:6px 0;font-weight:600">${Math.round(amountGMD).toLocaleString()} GMD</td></tr>
              <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0;font-weight:600">${reference}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Wallet ID</td><td style="padding:6px 0;font-weight:600">${walletId}</td></tr>
            </table>
            <p style="margin-top:20px"><a href="https://gamremitagent.pages.dev/admin.html?user=${user.id}" style="color:#1246F5">Review in Admin Panel →</a></p>
          </div>`,
      }, env);
    }
  } catch (e) { console.error('[webhook:circle:notify]', e.message); }

  return await checkDepositLimitAndMaybeFreeze(user, amountGMD, amount, reference, env);
}

async function checkDepositLimitAndMaybeFreeze(user, amountGMD, amountUsdc, reference, env) {
  const userTier = getKycTierByLevel(user.kycTierLevel || 0);

  if (amountGMD <= userTier.maxGMD) {
    return jsonResponse({ ok: true, note: 'Within tier limit', tier: userTier.tier });
  }

  // ── Breach: deposit exceeds what this user's approved tier covers ──
  if (['frozen', 'suspended', 'closed'].includes(user.status)) {
    // Already restricted — don't double-log, just note it.
    return jsonResponse({ ok: true, note: 'Already restricted, deposit logged only' });
  }

  const previousStatus = user.status;
  user.status = 'frozen';
  await saveUser(user, env);

  const reason = `Deposit of ${amountUsdc} USDC (~${Math.round(amountGMD)} GMD) exceeds ${userTier.label} limit of ${userTier.maxGMD.toLocaleString()} GMD per transfer`;

  await appendAuditLog({
    userId: user.id, userEmail: user.email,
    actionType: 'AUTO_FREEZE_DEPOSIT_LIMIT',
    previousStatus, newStatus: 'frozen',
    reason,
    adminId: 'system-auto-fraud', adminEmail: 'system-auto-fraud',
    metadata: { reference, amountUsdc, amountGMD: Math.round(amountGMD), userTier: userTier.tier, userTierLabel: userTier.label, tierLimitGMD: userTier.maxGMD },
  }, env);

  await addNotif(user.id, {
    type: 'error',
    title: '🔒 Account frozen',
    body: `Your account has been frozen because a deposit exceeded your current KYC tier limit (${userTier.label}, max ${userTier.maxGMD.toLocaleString()} GMD per transfer). Call support or upgrade your KYC tier to resolve this.`,
    link: '/kyc.html',
  }, env);

  await pushAdminNotif({
    type: 'alert',
    title: '🔒 Account auto-frozen — deposit exceeded KYC limit',
    body: `${user.email}: ${reason}. Ref: ${reference}`,
    link: `/admin.html?user=${user.id}`,
  }, env);

  sendTelegram(
    `🔒 *Account auto-frozen — deposit limit breach*\n👤 ${user.email}\n💵 ${reason}\n🔖 Ref: ${reference}\n\nUnfreeze manually after phone verification, or once the customer upgrades their KYC tier.`,
    env
  ).catch(() => {});

  return jsonResponse({ ok: true, frozen: true, reason });
}
