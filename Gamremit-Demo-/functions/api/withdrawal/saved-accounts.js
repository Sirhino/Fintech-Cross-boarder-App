// GET  /api/withdrawal/saved-accounts          -> list current user's saved accounts
// POST /api/withdrawal/saved-accounts           body: { accountNumber, institutionCode, institutionName, currency, accountName, label? }
// DELETE /api/withdrawal/saved-accounts?id=xxx
import { jsonResponse, optionsResponse, fromRequest } from '../_auth.js';

async function getSavedAccounts(userId, env) {
  const row = await env.DB.prepare('SELECT data FROM saved_accounts WHERE user_id = ?').bind(userId).first();
  return row ? JSON.parse(row.data) : [];
}
async function setSavedAccounts(userId, accounts, env) {
  await env.DB.prepare(
    `INSERT INTO saved_accounts (user_id, data) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data`
  ).bind(userId, JSON.stringify(accounts)).run();
}

export async function onRequestGet({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  const accounts = (await getSavedAccounts(payload.id, env)).sort((a, b) => (b.favorite === true) - (a.favorite === true));
  return jsonResponse({ accounts });
}

export async function onRequestPost({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { accountNumber, institutionCode, institutionName, currency, accountName, label } = body || {};
  if (!accountNumber || !institutionCode || !currency || !accountName) {
    return jsonResponse({ error: 'accountNumber, institutionCode, currency and accountName are required' }, 400);
  }

  const accounts = await getSavedAccounts(payload.id, env);

  const dupe = accounts.find(a => a.accountNumber === accountNumber && a.institutionCode === institutionCode);
  if (dupe) return jsonResponse({ accounts, note: 'Already saved' });

  accounts.unshift({
    id: `ba_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    accountNumber, institutionCode, institutionName: institutionName || institutionCode,
    currency, accountName, label: label || institutionName || institutionCode,
    favorite: false,
    createdAt: new Date().toISOString(),
  });

  await setSavedAccounts(payload.id, accounts.slice(0, 20), env);
  return jsonResponse({ accounts });
}

export async function onRequestPatch({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const accounts = await getSavedAccounts(payload.id, env);
  const entry = accounts.find(a => a.id === id);
  if (!entry) return jsonResponse({ error: 'Account not found' }, 404);

  if (typeof body.favorite === 'boolean') entry.favorite = body.favorite;
  if (typeof body.label === 'string' && body.label.trim()) entry.label = body.label.trim();

  await setSavedAccounts(payload.id, accounts, env);
  return jsonResponse({ accounts });
}

export async function onRequestDelete({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  const accounts = (await getSavedAccounts(payload.id, env)).filter(a => a.id !== id);
  await setSavedAccounts(payload.id, accounts, env);
  return jsonResponse({ accounts });
}

export async function onRequestOptions() { return optionsResponse(); }
