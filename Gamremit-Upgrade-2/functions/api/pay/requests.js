// functions/api/pay/requests.js — Payment Request / Invoice module
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, addNotif, saveTx, generateRef } from '../_db.js';
import { getUsdcBalance, transferUsdc } from '../_circle.js';


// ── Helpers ───────────────────────────────────────────────────────
function genId() {
  return `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

async function getPrByCode(code, env) {
  if (!env?.DB) return null;
  const row = await env.DB.prepare('SELECT data FROM payment_requests WHERE code = ?').bind(code).first();
  return row ? JSON.parse(row.data) : null;
}
async function savePr(pr, env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    `INSERT INTO payment_requests (id, code, sender_id, recipient_id, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET recipient_id = excluded.recipient_id, data = excluded.data`
  ).bind(pr.id, pr.code, pr.creatorId, pr.payerInfo?.userId || pr.recipientUserId || null, JSON.stringify(pr)).run();
}
async function getSentPrs(userId, env) {
  if (!env?.DB) return [];
  const res = await env.DB.prepare('SELECT data FROM payment_requests WHERE sender_id = ?').bind(userId).all();
  return (res.results || []).map(r => JSON.parse(r.data));
}
async function getReceivedPrs(userId, env) {
  if (!env?.DB) return [];
  const res = await env.DB.prepare('SELECT data FROM payment_requests WHERE recipient_id = ?').bind(userId).all();
  return (res.results || []).map(r => JSON.parse(r.data));
}

// ── Router ────────────────────────────────────────────────────────
export async function onRequest({ request, env }) {
 try {
  if (request.method === 'OPTIONS') return optionsResponse();

  const url   = new URL(request.url);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  const code  = parts[parts.length - 1]; // /api/pay/requests/:code

  // Public: GET /api/pay/requests/:code — fetch a request to pay it
  if (request.method === 'GET' && code && code !== 'requests') {
    const pr = await getPrByCode(code, env);
    if (!pr) return jsonResponse({ error: 'Payment request not found' }, 404);
    return jsonResponse({ success: true, paymentRequest: pr });
  }

  const JWT_SECRET = env.JWT_SECRET;

  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // GET /api/pay/requests — list my payment requests
  if (request.method === 'GET') {
    const [sent, received] = await Promise.all([getSentPrs(user.id, env), getReceivedPrs(user.id, env)]);
    const all = [...sent, ...received].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return jsonResponse({ success: true, paymentRequests: all, sent, received });
  }

  // POST /api/pay/requests — create a payment request
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { amount, currency = 'USDC', description, recipientEmail } = body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
      return jsonResponse({ error: 'Valid amount required' }, 400);
    if (!description?.trim()) return jsonResponse({ error: 'Description required' }, 400);

    const id   = genId();
    const code = genCode();
    const pr   = {
      id, code,
      creatorId: user.id,
      creatorName: `${user.firstName} ${user.lastName}`,
      creatorEmail: user.email,
      amount: parseFloat(amount).toFixed(6),
      currency,
      description: description.trim(),
      recipientEmail: recipientEmail?.toLowerCase().trim() || null,
      status: 'pending',       // pending | paid | cancelled | expired
      payerInfo: null,
      paidAt: null,
      txHash: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), // 7 days
      shareLink: `/pay/${code}`,
    };

    // Store once — sender_id/recipient_id columns make it queryable from
    // either side without needing duplicate copies of the same record.
    let recipientUserId = null;
    if (recipientEmail) {
      const recipient = await getUser(recipientEmail.toLowerCase().trim(), env);
      if (recipient) {
        recipientUserId = recipient.id;
        await addNotif(recipient.id, {
          type: 'payment',
          title: '💸 Payment Request Received',
          body: `${user.firstName} ${user.lastName} requests ${amount} ${currency} — ${description}`,
          link: `/pay/${code}`
        }, env);
      }
    }
    pr.recipientUserId = recipientUserId;
    await env.DB.prepare(
      `INSERT INTO payment_requests (id, code, sender_id, recipient_id, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET recipient_id = excluded.recipient_id, data = excluded.data`
    ).bind(pr.id, pr.code, user.id, recipientUserId, JSON.stringify(pr)).run();

    return jsonResponse({ success: true, paymentRequest: pr, code, shareLink: pr.shareLink }, 201);
  }

  // PATCH /api/pay/requests/:code — pay a pending request from your own Circle wallet
  if (request.method === 'PATCH' && code && code !== 'requests') {
    const pr = await getPrByCode(code, env);
    if (!pr) return jsonResponse({ error: 'Not found' }, 404);
    if (pr.status !== 'pending') return jsonResponse({ error: `Request already ${pr.status}` }, 409);
    if (new Date(pr.expiresAt) < new Date()) return jsonResponse({ error: 'This payment request has expired' }, 410);
    if (pr.creatorId === user.id) return jsonResponse({ error: 'You cannot pay your own payment request' }, 400);
    if (String(pr.currency).toUpperCase() !== 'USDC') {
      return jsonResponse({ error: `Paying in ${pr.currency} isn't supported yet — only USDC requests can be paid from your wallet right now.` }, 400);
    }

    const payerWalletId = user.circleWalletId || user.walletId;
    if (!payerWalletId) return jsonResponse({ error: 'No Circle wallet found on your account yet.' }, 400);

    const creator = await getUser(pr.creatorEmail, env);
    const creatorAddress = creator?.walletAddress;
    if (!creatorAddress) {
      return jsonResponse({ error: 'The recipient has no wallet address on file yet — this request cannot be paid right now.' }, 400);
    }

    const amount = parseFloat(pr.amount);

    let balance;
    try {
      balance = await getUsdcBalance(payerWalletId, env);
    } catch (e) {
      return jsonResponse({ error: `Could not verify your balance: ${e.message}` }, 502);
    }
    if (amount > balance) {
      return jsonResponse({ error: `Insufficient USDC balance. You have ${balance} USDC, this request needs ${amount} USDC.` }, 400);
    }

    let circleTx;
    try {
      circleTx = await transferUsdc(env, { walletId: payerWalletId, destinationAddress: creatorAddress, amount });
    } catch (e) {
      return jsonResponse({ error: e.message || 'Payment could not be sent. Please try again.' }, e.status || 502);
    }

    const updated = {
      ...pr,
      status: 'paid',
      paidAt: new Date().toISOString(),
      payerInfo: {
        userId: user.id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email
      },
      circleTxId: circleTx?.id || null,
      txHash: circleTx?.txHash || null,
    };

    await savePr(updated, env);

    const ref = generateRef();
    await saveTx({
      reference: ref,
      userId: user.id,
      userEmail: user.email,
      type: 'payment_request_paid',
      sendAmount: amount,
      sendCurrency: 'USDC',
      recipientName: pr.creatorName,
      status: circleTx?.state === 'COMPLETE' ? 'completed' : 'processing',
      circleTxId: circleTx?.id || null,
      createdAt: updated.paidAt,
    }, env);

    // Notify creator
    await addNotif(pr.creatorId, {
      type: 'success',
      title: '✅ Payment Received',
      body: `${user.firstName} ${user.lastName} paid ${pr.amount} ${pr.currency} — ${pr.description}`,
      link: '/app.html#payreq'
    }, env);

    return jsonResponse({ success: true, paymentRequest: updated });
  }

  // DELETE /api/pay/requests/:code — cancel
  if (request.method === 'DELETE' && code && code !== 'requests') {
    const pr = await getPrByCode(code, env);
    if (!pr) return jsonResponse({ error: 'Not found' }, 404);
    if (pr.creatorId !== user.id) return jsonResponse({ error: 'Forbidden' }, 403);
    if (pr.status === 'paid') return jsonResponse({ error: 'Cannot cancel a paid request' }, 409);

    const updated = { ...pr, status: 'cancelled' };
    await savePr(updated, env);
    return jsonResponse({ success: true, message: 'Cancelled' });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
 } catch (e) {
  console.error('[pay:requests]', e.message);
  return jsonResponse({ error: e.message || 'Something went wrong. Please try again.' }, 502);
 }
}

export async function onRequestOptions() { return optionsResponse(); }
