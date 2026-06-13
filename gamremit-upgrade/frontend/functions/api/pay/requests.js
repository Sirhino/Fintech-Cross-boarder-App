// functions/api/pay/requests.js — Payment Request / Invoice module
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, addNotif, sendTelegram } from '../_db.js';

const JWT_SECRET_DEFAULT = 'gamremit-dev-secret';

// ── Helpers ───────────────────────────────────────────────────────
function genId() {
  return `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

async function kvGet(key, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return null;
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await res.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function kvSet(key, value, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return;
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
}

async function kvKeys(pattern, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return [];
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await res.json();
    return d.result || [];
  } catch { return []; }
}

// ── Router ────────────────────────────────────────────────────────
export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const url   = new URL(request.url);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  const code  = parts[parts.length - 1]; // /api/pay/requests/:code

  // Public: GET /api/pay/requests/:code — fetch a request to pay it
  if (request.method === 'GET' && code && code !== 'requests') {
    const pr = await kvGet(`pr:${code}`, env);
    if (!pr) return jsonResponse({ error: 'Payment request not found' }, 404);
    return jsonResponse({ success: true, paymentRequest: pr });
  }

  const JWT_SECRET = env.JWT_SECRET || JWT_SECRET_DEFAULT;
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // GET /api/pay/requests — list my payment requests
  if (request.method === 'GET') {
    const sentKeys     = await kvKeys(`pr:sent:${user.id}:*`, env);
    const receivedKeys = await kvKeys(`pr:recv:${user.id}:*`, env);

    const fetchAll = async keys => (await Promise.all(keys.map(k => kvGet(k, env)))).filter(Boolean);
    const [sent, received] = await Promise.all([fetchAll(sentKeys), fetchAll(receivedKeys)]);
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

    // Store by code (public lookup) + by creator
    await kvSet(`pr:${code}`, pr, env);
    await kvSet(`pr:sent:${user.id}:${id}`, pr, env);

    // Notify recipient if email provided
    if (recipientEmail) {
      const recipient = await getUser(recipientEmail.toLowerCase().trim(), env);
      if (recipient) {
        await addNotif(recipient.id, {
          type: 'payment',
          title: '💸 Payment Request Received',
          body: `${user.firstName} ${user.lastName} requests ${amount} ${currency} — ${description}`,
          link: `/pay/${code}`
        }, env);
        await kvSet(`pr:recv:${recipient.id}:${id}`, pr, env);
      }
    }

    return jsonResponse({ success: true, paymentRequest: pr, code, shareLink: pr.shareLink }, 201);
  }

  // PATCH /api/pay/requests/:code — mark as paid
  if (request.method === 'PATCH' && code && code !== 'requests') {
    const pr = await kvGet(`pr:${code}`, env);
    if (!pr) return jsonResponse({ error: 'Not found' }, 404);
    if (pr.status !== 'pending') return jsonResponse({ error: `Request already ${pr.status}` }, 409);

    let body = {};
    try { body = await request.json(); } catch {}

    const updated = {
      ...pr,
      status: 'paid',
      paidAt: new Date().toISOString(),
      payerInfo: {
        userId: user.id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email
      },
      txHash: body.txHash || null
    };

    await kvSet(`pr:${code}`, updated, env);
    await kvSet(`pr:sent:${pr.creatorId}:${pr.id}`, updated, env);
    await kvSet(`pr:recv:${user.id}:${pr.id}`, updated, env);

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
    const pr = await kvGet(`pr:${code}`, env);
    if (!pr) return jsonResponse({ error: 'Not found' }, 404);
    if (pr.creatorId !== user.id) return jsonResponse({ error: 'Forbidden' }, 403);
    if (pr.status === 'paid') return jsonResponse({ error: 'Cannot cancel a paid request' }, 409);

    const updated = { ...pr, status: 'cancelled' };
    await kvSet(`pr:${code}`, updated, env);
    await kvSet(`pr:sent:${user.id}:${pr.id}`, updated, env);
    return jsonResponse({ success: true, message: 'Cancelled' });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
