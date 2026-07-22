// functions/api/transactions.js — Cloudflare Pages Function
import { fromRequest, jsonResponse, optionsResponse } from './_auth.js';
import { getTx, getAllTxs, saveTx, getUser, saveUser, getRates,
         generateRef, getTier, addNotif, pushAdminNotif, sendTelegram, sendEmail,
         getKycTier, isKycSufficient } from './_db.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const url        = new URL(request.url);
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const pathParts  = url.pathname.split('/').filter(Boolean);
  const ref        = pathParts[pathParts.length - 1];
  const isRef      = ref && ref.startsWith('GR-');

  // ── GET single TX (public track) ─────────────────────────────
  if (request.method === 'GET' && isRef) {
    const tx = await getTx(ref.toUpperCase(), env);
    if (!tx) return jsonResponse({ error: 'Transaction not found' }, 404);
    const { receiptBase64, ...safe } = tx;
    return jsonResponse({ success: true, transaction: safe });
  }

  // ── GET list ─────────────────────────────────────────────────
  if (request.method === 'GET') {
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);
    let list = await getAllTxs(env);
    if (claim.role !== 'admin') list = list.filter(t => t.userId === claim.id);
    list.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const status = url.searchParams.get('status');
    const limit  = url.searchParams.get('limit');
    if (status) list = list.filter(t => t.status === status);
    if (limit)  list = list.slice(0, parseInt(limit));
    return jsonResponse({ success: true, count: list.length, transactions: list });
  }

  // ── POST: submit transaction ──────────────────────────────────
  if (request.method === 'POST') {
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);
    // Compliance status enforcement
    if (claim.status === 'suspended' || claim.status === 'blocked') {
      return jsonResponse({ error: 'Your account is suspended. Contact support@gamremit.com', status: 'suspended' }, 403);
    }
    if (claim.status === 'frozen') {
      return jsonResponse({ error: 'Your account is frozen. You cannot make transactions. Contact support@gamremit.com', status: 'frozen', frozen: true }, 403);
    }
    if (claim.status === 'closed') {
      return jsonResponse({ error: 'This account has been permanently closed.', status: 'closed' }, 403);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const required = ['sendAmount','sendCurrency','receiveCurrency','recipientName','bankName','accountNumber','senderAccountBank','senderAccountNumber'];
    const missing  = required.filter(f => !body[f]);
    if (missing.length) return jsonResponse({ error: `Missing: ${missing.join(', ')}` }, 400);

    const amount = parseFloat(body.sendAmount);
    if (!amount || amount <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);

    // ── KYC Tier check ────────────────────────────────────────────
    // Convert amount to GMD equivalent for tier check
    const from = (body.sendCurrency || '').toUpperCase();
    const to   = (body.receiveCurrency || '').toUpperCase();

    // Get amount in GMD for tier calculation — uses the SAME admin-editable
    // rates shown in the Rates panel of admin.html (and now also used by
    // the deposit-limit check in webhooks/circle.js), so inbound and
    // outbound KYC tier checks never drift apart from each other.
    const rates = await getRates(env);
    const rateFor = (pair, fallback) => (rates[pair]?.active ? rates[pair].rate : fallback);
    let amountInGMD = amount;
    if (from === 'NGN')  amountInGMD = amount * rateFor('NGN-GMD', 0.0806);
    if (from === 'USD')  amountInGMD = amount * rateFor('USD-GMD', 61.50);
    if (from === 'USDC') amountInGMD = amount * rateFor('USDC-GMD', 61.73);
    const requiredKycTier = getKycTier(amountInGMD);
    const user = await getUser(claim.email, env);
    const userKycTierLevel = user?.kycTierLevel || 0;

    if (claim.kycStatus !== 'approved') {
      return jsonResponse({
        error: 'KYC verification required before sending transfers.',
        kycRequired: true,
        requiredTier: requiredKycTier.tier,
        requiredTierLabel: requiredKycTier.label,
        amountInGMD: Math.round(amountInGMD),
        redirectUrl: '/kyc.html'
      }, 403);
    }

    // User is KYC approved but check if their tier covers the amount
    if (!isKycSufficient(userKycTierLevel, amountInGMD)) {
      return jsonResponse({
        error: `Your KYC level (Tier ${userKycTierLevel}) does not cover this amount. You need ${requiredKycTier.label} to send ${Math.round(amountInGMD).toLocaleString()} GMD equivalent.`,
        tierUpgradeRequired: true,
        currentTier: userKycTierLevel,
        requiredTier: requiredKycTier.tier,
        requiredTierLabel: requiredKycTier.label,
        amountInGMD: Math.round(amountInGMD),
        redirectUrl: '/kyc.html'
      }, 403);
    }

    const r     = rates[`${from}-${to}`];
    if (!r || !r.active) return jsonResponse({ error: `Rate ${from}-${to} not available` }, 400);

    const tier         = getTier(amount, from, to);
    const effectiveRate= parseFloat((r.rate * (1 - tier.fee / 100)).toFixed(6));
    const receiveAmount= parseFloat((amount * effectiveRate).toFixed(6));

    // user already fetched above for KYC tier check
    const txRef   = generateRef();

    const tx = {
      reference: txRef, userId: claim.id, userEmail: claim.email,
      userName: user ? `${user.firstName} ${user.lastName}` : claim.email,
      status: 'pending',
      sendAmount: amount, sendCurrency: from,
      receiveCurrency: to, receiveAmount, effectiveRate,
      baseRate: r.rate, feePercent: tier.fee, tierLabel: tier.label,
      fromBank: body.senderAccountBank, fromAccount: body.senderAccountNumber,
      recipientName: body.recipientName, bankName: body.bankName,
      accountNumber: body.accountNumber,
      receiptBase64: body.receiptBase64 || null,
      receiptName: body.receiptName || null,
      adminNote: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: null, network: 'Arc Testnet · USDC Settlement'
    };

    await saveTx(tx, env);

    if (user) {
      user.totalTxCount = (user.totalTxCount || 0) + 1;
      await saveUser(user, env);
    }

    await pushAdminNotif({
      type: 'tx', title: tx.receiptBase64 ? '🧾 New Transfer + Receipt Uploaded' : '💸 New Transfer Submitted',
      body: `${tx.userName} sent ${amount.toLocaleString()} ${from} → ${to}. Ref: ${txRef}${tx.receiptBase64 ? ' · Receipt attached, needs verification' : ''}`,
      link: '/admin.html#transactions'
    }, env);

    await sendTelegram(
      `${tx.receiptBase64 ? '🧾 *New GamRemit Transfer — Receipt Uploaded*' : '💸 *New GamRemit Transfer*'}\n\n` +
      `👤 *User:* ${tx.userName} (${tx.userEmail})\n` +
      `💰 *Sends:* ${amount.toLocaleString()} ${from}\n` +
      `📥 *Receives:* ${receiveAmount.toLocaleString()} ${to}\n` +
      `🏦 *Bank:* ${tx.bankName} ${tx.accountNumber}\n` +
      `👤 *Recipient:* ${tx.recipientName}\n` +
      `🔖 *Ref:* \`${txRef}\`\n` +
      `${tx.receiptBase64 ? '🧾 *Receipt attached — verify against bank statement*\n' : ''}` +
      `🕐 *Time:* ${new Date().toLocaleString('en-GB',{timeZone:'Africa/Banjul'})}`, env
    );

    try {
      // No routine admin email here on purpose — every new transfer already
      // shows up via the bell notification above and in the admin panel's
      // Transactions tab, and Telegram already fires for free. Email quota
      // is reserved for KYC and large/flagged-transaction alerts.
    } catch (e) { console.error('[tx:notify-admin-email]', e.message); }

    await addNotif(claim.id, {
      type: 'tx', title: '✅ Transfer submitted',
      body: `Your transfer of ${amount.toLocaleString()} ${from} is pending review. Ref: ${txRef}`,
      link: '/app.html#track'
    }, env);

    const { receiptBase64: _r, ...safeTx } = tx;
    return jsonResponse({ success: true, transaction: safeTx }, 201);
  }

  // ── PATCH: admin updates status ───────────────────────────────
  if (request.method === 'PATCH' && isRef) {
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim)               return jsonResponse({ error: 'Unauthorized' }, 401);
    if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

    const tx = await getTx(ref.toUpperCase(), env);
    if (!tx) return jsonResponse({ error: 'Transaction not found' }, 404);

    let body;
    try { body = await request.json(); } catch { body = {}; }

    const { status, adminNote } = body;
    const valid = ['pending','processing','completed','rejected'];
    if (status && !valid.includes(status)) return jsonResponse({ error: 'Invalid status' }, 400);

    const prevStatus = tx.status;
    if (status)    tx.status    = status;
    if (adminNote !== undefined) tx.adminNote = adminNote;
    tx.updatedAt = new Date().toISOString();
    if (status === 'completed') tx.completedAt = new Date().toISOString();

    await saveTx(tx, env);

    if (status && status !== prevStatus) {
      const emoji = { pending:'⏳', processing:'🔄', completed:'✅', rejected:'❌' };
      await addNotif(tx.userId, {
        type: status === 'completed' ? 'success' : status === 'rejected' ? 'error' : 'info',
        title: `${emoji[status]} Transfer ${status}`,
        body: `Your transfer ${ref} is now ${status}.${adminNote ? ' Note: ' + adminNote : ''}`,
        link: '/app.html#track'
      }, env);
      await sendTelegram(
        `${emoji[status]} *Transfer ${status.toUpperCase()}*\nRef: \`${ref}\`\nUser: ${tx.userName}\n${prevStatus} → ${status}${adminNote ? '\nNote: '+adminNote:''}`, env
      );
    }

    const { receiptBase64: _r, ...safeTx } = tx;
    return jsonResponse({ success: true, transaction: safeTx });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
