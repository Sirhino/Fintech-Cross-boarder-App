// functions/api/arc-names/index.js — .arc Name Registration
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser } from '../_db.js';

// ARC Name Registry contract on Arc Testnet (placeholder — replace with real deployed address)
const ARC_REGISTRY = '0x000000000000000000000000000000000000dEaD';

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$|^[a-z0-9]{3,32}$/;
const RESERVED   = ['gamremit', 'admin', 'support', 'circle', 'usdc', 'arc', 'testnet', 'nan', 'official'];

async function getArcName(name, env) {
  if (!env?.DB) return null;
  const row = await env.DB.prepare('SELECT data FROM arc_names WHERE name = ?').bind(name).first();
  return row ? JSON.parse(row.data) : null;
}
async function saveArcName(name, value, env) {
  if (!env?.DB) return;
  if (value === null) { await env.DB.prepare('DELETE FROM arc_names WHERE name = ?').bind(name).run(); return; }
  await env.DB.prepare(
    `INSERT INTO arc_names (name, data) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data`
  ).bind(name, JSON.stringify(value)).run();
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const url  = new URL(request.url);
  const name = url.searchParams.get('name')?.toLowerCase().trim().replace(/\.arc$/, '');

  // Public: GET /api/arc-names?name=foo — check availability
  if (request.method === 'GET' && name && !request.headers.get('Authorization')) {
    if (!NAME_REGEX.test(name)) return jsonResponse({ available: false, reason: 'Invalid name format' });
    if (RESERVED.includes(name)) return jsonResponse({ available: false, reason: 'Reserved name' });
    const existing = await getArcName(name, env);
    return jsonResponse({ available: !existing, name, fullName: `${name}.arc` });
  }

  const JWT_SECRET = env.JWT_SECRET;

  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // GET /api/arc-names — list my registered names
  if (request.method === 'GET' && !name) {
    const myNames = user.arcNames || [];
    return jsonResponse({ success: true, names: myNames });
  }

  // GET with name + auth — check availability (authenticated)
  if (request.method === 'GET' && name) {
    if (!NAME_REGEX.test(name)) return jsonResponse({ available: false, reason: 'Invalid name format (3–32 lowercase alphanumeric/hyphen)' });
    if (RESERVED.includes(name)) return jsonResponse({ available: false, reason: 'This name is reserved' });
    const existing = await getArcName(name, env);
    return jsonResponse({
      available: !existing,
      name,
      fullName: `${name}.arc`,
      owner: existing?.ownerEmail || null,
      registeredAt: existing?.registeredAt || null
    });
  }

  // POST /api/arc-names — register a .arc name
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const rawName = body.name?.toLowerCase().trim().replace(/\.arc$/, '');
    if (!rawName) return jsonResponse({ error: 'name required' }, 400);
    if (!NAME_REGEX.test(rawName)) return jsonResponse({ error: 'Invalid name: 3–32 lowercase letters, digits, or hyphens' }, 400);
    if (RESERVED.includes(rawName)) return jsonResponse({ error: 'This name is reserved' }, 400);

    const existing = await getArcName(rawName, env);
    if (existing) return jsonResponse({ error: `${rawName}.arc is already taken` }, 409);

    // Check user does not already have 3+ names (limit)
    if ((user.arcNames || []).length >= 3)
      return jsonResponse({ error: 'You can register up to 3 .arc names' }, 400);

    const walletAddress = user.walletAddress || body.walletAddress || null;
    if (!walletAddress) {
      return jsonResponse({ error: 'No wallet address found on your account yet. Please try again once your wallet finishes setting up.' }, 400);
    }

    const record = {
      name: rawName,
      fullName: `${rawName}.arc`,
      ownerId: user.id,
      ownerEmail: user.email,
      ownerName: `${user.firstName} ${user.lastName}`,
      walletAddress,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(), // 1 year
      primary: (user.arcNames || []).length === 0, // first name is primary
    };

    // Store globally + on user
    await saveArcName(rawName, record, env);
    user.arcNames = [...(user.arcNames || []), record];
    if (record.primary) user.primaryArcName = `${rawName}.arc`;
    await saveUser(user, env);

    return jsonResponse({ success: true, record }, 201);
  }

  // PATCH /api/arc-names — set a name as primary
  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const rawName = body.name?.toLowerCase().trim().replace(/\.arc$/, '');
    if (!rawName) return jsonResponse({ error: 'name required' }, 400);

    const myNames = user.arcNames || [];
    const idx = myNames.findIndex(n => n.name === rawName);
    if (idx === -1) return jsonResponse({ error: 'Name not found in your account' }, 404);

    user.arcNames = myNames.map(n => ({ ...n, primary: n.name === rawName }));
    user.primaryArcName = `${rawName}.arc`;
    await saveUser(user, env);

    return jsonResponse({ success: true, primaryArcName: user.primaryArcName });
  }

  // DELETE /api/arc-names?name=foo — release a .arc name
  if (request.method === 'DELETE' && name) {
    const myNames = user.arcNames || [];
    const idx = myNames.findIndex(n => n.name === name);
    if (idx === -1) return jsonResponse({ error: 'Name not found in your account' }, 404);

    // Remove from global registry + user
    await saveArcName(name, null, env);
    user.arcNames = myNames.filter(n => n.name !== name);
    if (user.primaryArcName === `${name}.arc`) {
      user.primaryArcName = user.arcNames[0]?.fullName || null;
      if (user.arcNames[0]) user.arcNames[0].primary = true;
    }
    await saveUser(user, env);

    return jsonResponse({ success: true, message: `${name}.arc released` });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
