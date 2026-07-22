import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import { getAllUsers, saveUser, addNotif, appendAuditLog } from '../../_db.js';

// Statuses owned by the compliance system (admin/compliance/[[path]].js).
// This endpoint is for the simple "approve/reject new registration" flow
// only — it must never be a side door around freeze/suspend, since that
// would defeat the whole point of having an audited compliance trail.
const COMPLIANCE_OWNED_STATUSES = ['frozen', 'suspended', 'under_review', 'closed'];

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return optionsResponse();
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
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

    if (body.status && COMPLIANCE_OWNED_STATUSES.includes(user.status)) {
      return jsonResponse({
        error: `This account is ${user.status} under the compliance system — use Freeze/Suspend/Unflag actions in the Compliance panel instead, so the action is reasoned and audited.`,
      }, 409);
    }
    if (body.status && COMPLIANCE_OWNED_STATUSES.includes(body.status)) {
      return jsonResponse({
        error: `Use the Compliance panel to set a "${body.status}" status — that path requires a reason and is audit-logged.`,
      }, 409);
    }

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

      await appendAuditLog({
        userId: user.id, userEmail: user.email,
        actionType: 'REGISTRATION_STATUS_CHANGE',
        previousStatus: prevStatus, newStatus: body.status,
        adminId: claim.id, adminEmail: claim.email,
        ipAddress: request.headers.get('cf-connecting-ip') || null,
      }, env);
    }

    const { passwordHash: _, ...safe } = user;
    return jsonResponse({ success: true, user: safe });
  }
  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
