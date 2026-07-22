// functions/api/wallet/beneficiaries.js — saved wallet recipients ("beneficiaries")
// Lets a user save a wallet address (or .arc name) they send to often, give
// it a label, and star/favorite it for quick access from the Send modal.
// Stored directly on the user record (user.walletBeneficiaries) — no schema
// migration needed, same pattern already used for user.arcNames.
//
// GET    /api/wallet/beneficiaries                -> list
// POST   /api/wallet/beneficiaries   { address, label } -> add
// PATCH  /api/wallet/beneficiaries?id=xxx  { label?, favorite? } -> update
// DELETE /api/wallet/beneficiaries?id=xxx          -> remove
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, resolveWalletInput } from '../_db.js';

async function loadUser(request, env) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return { err: jsonResponse({ error: 'Server misconfigured — contact support' }, 500) };
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return { err: jsonResponse({ error: 'Unauthorized' }, 401) };
  const user = await getUser(claim.email, env);
  if (!user) return { err: jsonResponse({ error: 'User not found' }, 404) };
  return { user };
}

export async function onRequestGet({ request, env }) {
  const { user, err } = await loadUser(request, env);
  if (err) return err;
  const list = (user.walletBeneficiaries || []).slice().sort((a, b) => (b.favorite === true) - (a.favorite === true));
  return jsonResponse({ success: true, beneficiaries: list });
}

export async function onRequestPost({ request, env }) {
  const { user, err } = await loadUser(request, env);
  if (err) return err;

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const rawInput = String(body.address || '').trim();
  if (!rawInput) return jsonResponse({ error: 'Wallet address or .arc name is required' }, 400);

  const { address, error } = await resolveWalletInput(rawInput, env);
  if (error) return jsonResponse({ error }, 400);
  if (address.toLowerCase() === (user.walletAddress || '').toLowerCase()) {
    return jsonResponse({ error: "You can't save your own wallet as a beneficiary" }, 400);
  }

  const list = user.walletBeneficiaries || [];
  const dupe = list.find(b => b.address.toLowerCase() === address.toLowerCase());
  if (dupe) return jsonResponse({ success: true, beneficiaries: list, note: 'Already saved' });

  const label = String(body.label || '').trim() || (rawInput.toLowerCase().endsWith('.arc') ? rawInput : `${address.slice(0, 6)}...${address.slice(-4)}`);

  list.unshift({
    id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    address,
    label,
    arcName: rawInput.toLowerCase().endsWith('.arc') || (!rawInput.startsWith('0x') && rawInput !== address) ? rawInput.toLowerCase().replace(/\.arc$/, '') + '.arc' : null,
    favorite: false,
    createdAt: new Date().toISOString(),
  });

  user.walletBeneficiaries = list.slice(0, 30); // keep it manageable
  await saveUser(user, env);
  return jsonResponse({ success: true, beneficiaries: user.walletBeneficiaries }, 201);
}

export async function onRequestPatch({ request, env }) {
  const { user, err } = await loadUser(request, env);
  if (err) return err;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const list = user.walletBeneficiaries || [];
  const entry = list.find(b => b.id === id);
  if (!entry) return jsonResponse({ error: 'Beneficiary not found' }, 404);

  if (typeof body.favorite === 'boolean') entry.favorite = body.favorite;
  if (typeof body.label === 'string' && body.label.trim()) entry.label = body.label.trim();

  user.walletBeneficiaries = list;
  await saveUser(user, env);
  return jsonResponse({ success: true, beneficiaries: list });
}

export async function onRequestDelete({ request, env }) {
  const { user, err } = await loadUser(request, env);
  if (err) return err;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  user.walletBeneficiaries = (user.walletBeneficiaries || []).filter(b => b.id !== id);
  await saveUser(user, env);
  return jsonResponse({ success: true, beneficiaries: user.walletBeneficiaries });
}

export async function onRequestOptions() { return optionsResponse(); }
