// functions/api/admin/compliance.js
// Account Risk & Compliance Management Module
import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import {
  getUser, getAllUsers, saveUser, getAllTxs,
  addNotif, sendTelegram,
  appendAuditLog, getAuditLogsForUser, getAllAuditLogs,
  getComplianceNotes, addComplianceNote, editComplianceNote,
  calculateRiskScore, ACCOUNT_STATUSES
} from '../../_db.js';

// ── Valid status transitions ──────────────────────────────────────
const TRANSITIONS = {
  freeze:    { from: ['active','under_review','pending'], to: 'frozen',       action: 'FREEZE'    },
  unfreeze:  { from: ['frozen'],                          to: 'active',        action: 'UNFREEZE'  },
  suspend:   { from: ['active','frozen','under_review'],  to: 'suspended',     action: 'SUSPEND'   },
  reinstate: { from: ['suspended'],                       to: 'active',        action: 'REINSTATE' },
  flag:      { from: ['active','pending','frozen'],       to: 'under_review',  action: 'FLAG'      },
  unflag:    { from: ['under_review'],                    to: 'active',        action: 'UNFLAG'    },
  close:     { from: ['active','frozen','suspended'],     to: 'closed',        action: 'CLOSE'     },
};

function requireAdmin(claim) {
  if (!claim) return 'Unauthorized';
  if (claim.role !== 'admin') return 'Admin only';
  return null;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET;

  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  const authErr = requireAdmin(claim);
  if (authErr) return jsonResponse({ error: authErr }, authErr === 'Unauthorized' ? 401 : 403);

  try {
    const url   = new URL(request.url);
    const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    // /api/admin/compliance/:action  OR  /api/admin/compliance/notes/:userId  OR  /api/admin/compliance/audit
    const segment1 = parts[parts.length - 2]; // 'compliance', 'notes', 'audit', userId, etc.
    const segment2 = parts[parts.length - 1]; // action or userId or 'audit'

  // ── GET /api/admin/compliance/audit ──────────────────────────
  if (request.method === 'GET' && segment2 === 'audit') {
    const userId = url.searchParams.get('userId');
    const limit  = parseInt(url.searchParams.get('limit') || '100');
    const logs   = userId
      ? await getAuditLogsForUser(userId, env, limit)
      : (await getAllAuditLogs(env, limit)).logs;
    return jsonResponse({ success: true, count: logs.length, logs });
  }

  // ── GET /api/admin/compliance/risk ───────────────────────────
  if (request.method === 'GET' && segment2 === 'risk') {
    const users = (await getAllUsers(env)).filter(u => u.role !== 'admin');
    const txs   = await getAllTxs(env);
    const riskProfiles = await Promise.all(
      users.map(async u => {
        const risk = await calculateRiskScore(u, txs, env);
        return {
          id: u.id, email: u.email, name: `${u.firstName} ${u.lastName}`,
          status: u.status, kycStatus: u.kycStatus,
          ...risk,
          createdAt: u.createdAt, lastLogin: u.lastLogin,
        };
      })
    );
    // Sort by risk score descending
    riskProfiles.sort((a, b) => b.score - a.score);

    const stats = {
      critical: riskProfiles.filter(r => r.level === 'critical').length,
      high:     riskProfiles.filter(r => r.level === 'high').length,
      medium:   riskProfiles.filter(r => r.level === 'medium').length,
      low:      riskProfiles.filter(r => r.level === 'low').length,
      frozen:   users.filter(u => u.status === 'frozen').length,
      suspended:users.filter(u => u.status === 'suspended').length,
      underReview: users.filter(u => u.status === 'under_review').length,
    };

    return jsonResponse({ success: true, stats, profiles: riskProfiles });
  }

  // ── GET /api/admin/compliance/notes/:userId ──────────────────
  if (request.method === 'GET' && segment1 === 'notes') {
    const userId = segment2;
    const notes  = await getComplianceNotes(userId, env);
    return jsonResponse({ success: true, notes });
  }

  // ── POST /api/admin/compliance/notes/:userId ─────────────────
  if (request.method === 'POST' && segment1 === 'notes') {
    const userId = segment2;
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.content?.trim()) return jsonResponse({ error: 'Note content required' }, 400);

    const note = await addComplianceNote(userId, {
      content:   body.content.trim(),
      adminId:   claim.id,
      adminEmail:claim.email,
      adminName: body.adminName || claim.email,
    }, env);

    // Audit log
    await appendAuditLog({
      userId, actionType: 'NOTE_ADDED',
      reason: body.content.slice(0, 100),
      adminId: claim.id, adminEmail: claim.email,
      ipAddress: request.headers.get('cf-connecting-ip') || null,
    }, env);

    return jsonResponse({ success: true, note }, 201);
  }

  // ── PATCH /api/admin/compliance/notes/:userId — edit note ────
  if (request.method === 'PATCH' && segment1 === 'notes') {
    const userId = segment2;
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.noteId || !body.content?.trim()) return jsonResponse({ error: 'noteId and content required' }, 400);

    const updated = await editComplianceNote(userId, body.noteId, body.content.trim(), claim.email, env);
    if (!updated) return jsonResponse({ error: 'Note not found' }, 404);

    await appendAuditLog({
      userId, actionType: 'NOTE_EDITED',
      reason: `Note edited: ${body.content.slice(0, 80)}`,
      adminId: claim.id, adminEmail: claim.email,
      ipAddress: request.headers.get('cf-connecting-ip') || null,
    }, env);

    return jsonResponse({ success: true, note: updated });
  }

  // ── POST /api/admin/compliance/:action — status action ───────
  if (request.method === 'POST' && TRANSITIONS[segment2]) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { userId, reason } = body;
    if (!userId)       return jsonResponse({ error: 'userId required' }, 400);
    if (!reason?.trim()) return jsonResponse({ error: 'Reason required for compliance actions' }, 400);

    const transition = TRANSITIONS[segment2];
    const users = await getAllUsers(env);
    const user  = users.find(u => u.id === userId);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    if (user.role === 'admin') return jsonResponse({ error: 'Cannot apply compliance actions to admins' }, 403);

    const normalizedStatus = user.status === 'blocked' ? 'suspended' : user.status;
    if (!transition.from.includes(normalizedStatus)) {
      return jsonResponse({
        error: `Cannot ${segment2} a ${normalizedStatus} account. Valid from: ${transition.from.join(', ')}`
      }, 409);
    }

    const prevStatus = user.status;
    user.status = transition.to;
    user.complianceLastAction = {
      action:    transition.action,
      reason:    reason.trim(),
      adminId:   claim.id,
      adminEmail:claim.email,
      timestamp: new Date().toISOString(),
    };

    // Track compliance history
    if (!user.complianceHistory) user.complianceHistory = {};
    if (transition.to === 'frozen')    user.complianceHistory.wasFrozen    = true;
    if (transition.to === 'suspended') user.complianceHistory.wasSuspended = true;

    await saveUser(user, env);

    // Immutable audit log entry
    const auditEntry = await appendAuditLog({
      userId:         user.id,
      userEmail:      user.email,
      actionType:     transition.action,
      previousStatus: prevStatus,
      newStatus:      transition.to,
      reason:         reason.trim(),
      adminId:        claim.id,
      adminEmail:     claim.email,
      ipAddress:      request.headers.get('cf-connecting-ip') || null,
      metadata: { userName: `${user.firstName} ${user.lastName}` },
    }, env);

    // User notification (except suspended — they can't see it)
    if (transition.to !== 'suspended' && transition.to !== 'closed') {
      const msgs = {
        frozen:       '❄️ Your account has been temporarily frozen. You can view your account but cannot make transactions. Contact support for details.',
        under_review: '🔍 Your account has been flagged for a routine compliance review. You can continue using GamRemit normally.',
        active:       segment2 === 'unfreeze'
                        ? '✅ Your account has been unfrozen. You can now make transactions again.'
                        : segment2 === 'reinstate'
                        ? '✅ Your account has been reinstated. Welcome back!'
                        : '✅ Your account review has been completed.',
      };
      if (msgs[transition.to]) {
        await addNotif(user.id, {
          type: transition.to === 'frozen' ? 'warning' : 'info',
          title: `Account Status Update`,
          body: msgs[transition.to],
        }, env);
      }
    }

    // Telegram alert for high-impact actions
    if (['FREEZE','SUSPEND','CLOSE'].includes(transition.action)) {
      await sendTelegram(
        `🚨 *Compliance Action: ${transition.action}*\n\n` +
        `👤 *User:* ${user.firstName} ${user.lastName}\n` +
        `📧 *Email:* ${user.email}\n` +
        `📋 *Reason:* ${reason}\n` +
        `👮 *Admin:* ${claim.email}\n` +
        `🕐 *Time:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Banjul' })}`, env
      );
    }

    const { passwordHash: _, ...safeUser } = user;
    return jsonResponse({
      success: true,
      user: safeUser,
      auditEntry,
      message: `Account ${segment2}d successfully`
    });
  }

  // ── GET /api/admin/compliance/stats ──────────────────────────
  if (request.method === 'GET' && segment2 === 'stats') {
    const users = (await getAllUsers(env)).filter(u => u.role !== 'admin');
    const today = new Date(); today.setHours(0,0,0,0);
    const { logs } = await getAllAuditLogs(env, 500);
    const todayLogs = logs.filter(l => new Date(l.timestamp) >= today);

    const txs = await getAllTxs(env);
    const riskLevels = await Promise.all(users.map(u => calculateRiskScore(u, txs, env)));
    const highRisk = riskLevels.filter(r => r.level === 'high' || r.level === 'critical').length;

    return jsonResponse({
      success: true,
      stats: {
        totalFrozen:      users.filter(u => u.status === 'frozen').length,
        totalSuspended:   users.filter(u => u.status === 'suspended' || u.status === 'blocked').length,
        totalUnderReview: users.filter(u => u.status === 'under_review').length,
        totalClosed:      users.filter(u => u.status === 'closed').length,
        highRisk,
        fraudAlertsToday: todayLogs.filter(l => ['FREEZE','SUSPEND','FLAG'].includes(l.actionType)).length,
        actionsToday:     todayLogs.length,
      }
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[admin:compliance]', e.message);
    return jsonResponse({ error: e.message || 'Compliance request failed unexpectedly' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
