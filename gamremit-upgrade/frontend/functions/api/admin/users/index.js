// functions/api/admin/users.js — Cloudflare Pages Function
import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import { getAllUsers, getUser, saveUser, getAllTxs, addNotif } from '../../_db.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim)               return jsonResponse({ error: 'Unauthorized' }, 401);
  if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

  const url      = new URL(request.url);
  const pathParts= url.pathname.split('/').filter(Boolean);
  const userId   = pathParts[pathParts.length - 1];
  const isUser   = userId && userId.startsWith('usr-');

  // ── GET: dashboard stats ──────────────────────────────────────
  if (request.method === 'GET' && url.searchParams.get('stats') === '1') {
    const [users, txs] = await Promise.all([getAllUsers(env), getAllTxs(env)]);
    const nonAdmin = users.filter(u => u.role !== 'admin');
    const vol = txs.filter(t=>t.status==='completed').reduce((s,t)=>s+t.sendAmount,0);
    return jsonResponse({ success: true, stats: {
      totalUsers:              nonAdmin.length,
      pendingUsers:            nonAdmin.filter(u=>u.status==='pending').length,
      activeUsers:             nonAdmin.filter(u=>u.status==='active').length,
      blockedUsers:            nonAdmin.filter(u=>u.status==='blocked').length,
      totalTransactions:       txs.length,
      pendingTransactions:     txs.filter(t=>t.status==='pending').length,
      processingTransactions:  txs.filter(t=>t.status==='processing').length,
      completedTransactions:   txs.filter(t=>t.status==='completed').length,
      rejectedTransactions:    txs.filter(t=>t.status==='rejected').length,
      totalVolume:             parseFloat(vol.toFixed(2))
    }});
  }

  // ── GET: list users ───────────────────────────────────────────
  if (request.method === 'GET' && !isUser) {
    let users = await getAllUsers(env);
    users = users.map(({ passwordHash, ...u }) => u);
    const status = url.searchParams.get('status');
    const role   = url.searchParams.get('role');
    if (status) users = users.filter(u => u.status === status);
    if (role)   users = users.filter(u => u.role   === role);
    users.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    return jsonResponse({ success: true, count: users.length, users });
  }

  // ── PATCH: update user status / role ──────────────────────────
  if (request.method === 'PATCH' && isUser) {
    const users = await getAllUsers(env);
    const user  = users.find(u => u.id === userId);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    if (user.role === 'admin') return jsonResponse({ error: 'Cannot modify admin' }, 403);

    let body;
    try { body = await request.json(); } catch { body = {}; }

    const prevStatus = user.status;
    const allowed = ['status','role','kycStatus'];
    allowed.forEach(k => { if (body[k] !== undefined) user[k] = body[k]; });
    await saveUser(user, env);

    if (body.status && body.status !== prevStatus) {
      const msgs = {
        active:  { type:'success', title:'✅ Account Approved!', body:'Your GamRemit account is now active. You can send money!' },
        blocked: { type:'error',   title:'🚫 Account Suspended', body:'Your account has been suspended. Contact support@gamremit.com' },
        pending: { type:'info',    title:'⏳ Account Under Review', body:'Your account is under review.' }
      };
      const notif = msgs[body.status];
      if (notif) await addNotif(user.id, { ...notif, link:'/app.html' }, env);
    }

    const { passwordHash: _, ...safe } = user;
    return jsonResponse({ success: true, user: safe });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
