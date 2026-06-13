import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import { getAllUsers, saveUser, addNotif } from '../../_db.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return optionsResponse();
  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);
  const userId = params.userId;
  if (request.method === 'PATCH') {
    const users = await getAllUsers(env);
    const user = users.find(u => u.id === userId);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    if (user.role === 'admin') return jsonResponse({ error: 'Cannot modify admin' }, 403);
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const prevStatus = user.status;
    const allowed = ['status', 'role', 'kycStatus'];
    allowed.forEach(k => { if (body[k] !== undefined) user[k] = body[k]; });
    await saveUser(user, env);
    if (body.status && body.status !== prevStatus) {
      const msgs = {
        active:  { type:'success', title:'✅ Account Approved!', body:'Your GamRemit account is now active. You can send money!' },
        blocked: { type:'error',   title:'🚫 Account Suspended', body:'Your account has been suspended. Contact support@gamremit.com' },
      };
      const notif = msgs[body.status];
      if (notif) await addNotif(user.id, { ...notif, link:'/app.html' }, env);
    }
    const { passwordHash: _, ...safe } = user;
    return jsonResponse({ success: true, user: safe });
  }
  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
