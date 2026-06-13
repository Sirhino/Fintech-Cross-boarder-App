// functions/api/auth/me.js — Cloudflare Pages Function
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, getNotifs, getAllUsers } from '../_db.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const withNotifs = url.searchParams.get('notifs') === '1';
  const markRead   = url.searchParams.get('markRead') === '1';

  // ── ADMIN ─────────────────────────────────────────────────────
  if (claim.role === 'admin') {
    const adminUser = {
      id: 'admin-001', email: 'admin@gamremit.com',
      firstName: 'GamRemit', lastName: 'Admin',
      phone: '+220000000', country: 'GM',
      role: 'admin', status: 'active', kycStatus: 'verified',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastLogin: new Date().toISOString(), avatar: 'GA'
    };
    const notifs = withNotifs ? await getNotifs('admin-001', env) : undefined;
    return jsonResponse({
      success: true, user: adminUser,
      ...(notifs !== undefined && { notifications: notifs, unread: notifs.filter(n=>!n.read).length })
    });
  }

  // ── REGULAR USER ──────────────────────────────────────────────
  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  // PATCH — update profile
  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const allowed = ['firstName','lastName','phone'];
    allowed.forEach(k => { if (body[k]) user[k] = body[k].trim(); });
    await saveUser(user, env);
    const { passwordHash: _, ...safe } = user;
    return jsonResponse({ success: true, user: safe });
  }

  let notifs = undefined;
  if (withNotifs) {
    notifs = await getNotifs(user.id, env);
    if (markRead) {
      notifs = notifs.map(n => ({ ...n, read: true }));
      const { kvSet } = await import('../_db.js');
    }
  }

  const { passwordHash: _, ...safeUser } = user;
  return jsonResponse({
    success: true, user: safeUser,
    ...(notifs !== undefined && { notifications: notifs, unread: notifs.filter(n=>!n.read).length })
  });
}

export async function onRequestOptions() { return optionsResponse(); }
