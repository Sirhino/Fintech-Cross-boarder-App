// functions/api/pay/payroll.js — Bulk USDC payroll
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, addNotif } from '../_db.js';

async function kvGet(key, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return null;
  try {
    const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await r.json();
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
    const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await r.json();
    return d.result || [];
  } catch { return []; }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // GET /api/pay/payroll — list payroll batches
  if (request.method === 'GET') {
    const keys = await kvKeys(`payroll:${user.id}:*`, env);
    const batches = (await Promise.all(keys.map(k => kvGet(k, env)))).filter(Boolean);
    batches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

    // Validate each row
    const errors = [];
    recipients.forEach((r, i) => {
      if (!r.name?.trim()) errors.push(`Row ${i + 1}: name required`);
      if (!r.wallet || !/^0x[0-9a-fA-F]{40}$/.test(r.wallet)) errors.push(`Row ${i + 1}: invalid wallet address`);
      if (!r.amount || isNaN(parseFloat(r.amount)) || parseFloat(r.amount) <= 0) errors.push(`Row ${i + 1}: invalid amount`);
    });
    if (errors.length) return jsonResponse({ error: errors[0], errors }, 400);

    const totalAmount = recipients.reduce((s, r) => s + parseFloat(r.amount), 0);
    const batchId = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Simulate on-chain execution (Arc Testnet)
    // In production: call Circle developer-controlled wallets API to send batch transfers
    const processed = recipients.map(r => ({
      ...r,
      amount: parseFloat(r.amount).toFixed(6),
      status: 'sent',
      txHash: `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
      sentAt: new Date().toISOString()
    }));

    const batch = {
      id: batchId,
      title: title?.trim() || `Payroll ${new Date().toLocaleDateString('en-GB')}`,
      creatorId: user.id,
      creatorEmail: user.email,
      recipients: processed,
      totalRecipients: processed.length,
      totalAmount: totalAmount.toFixed(6),
      currency: 'USDC',
      status: scheduledFor ? 'scheduled' : 'completed',
      scheduledFor: scheduledFor || null,
      executedAt: scheduledFor ? null : new Date().toISOString(),
      createdAt: new Date().toISOString(),
      networkFee: (processed.length * 0.001).toFixed(6),
    };

    await kvSet(`payroll:${user.id}:${batchId}`, batch, env);

    return jsonResponse({ success: true, batch }, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
