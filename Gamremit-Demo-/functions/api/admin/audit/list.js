// functions/api/admin/audit/list.js — GET /api/admin/audit/list
// Lists audit log entries from Cloudflare KV. Admin-only.
//
// Query params:
//   userId   — optional, restrict to one user's audit trail
//   limit    — optional, default 100, max 500
//   cursor   — optional, KV pagination cursor (only applies to the
//              global/no-userId view; see getAllAuditLogs in _db.js)

import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import { getAuditLogsForUser, getAllAuditLogs } from '../../_db.js';

export async function onRequestGet({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (payload.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
  const cursor = url.searchParams.get('cursor') || undefined;

  if (userId) {
    const logs = await getAuditLogsForUser(userId, env, limit);
    return jsonResponse({ logs, count: logs.length });
  }

  const { logs, cursor: nextCursor } = await getAllAuditLogs(env, limit, cursor);
  return jsonResponse({ logs, count: logs.length, cursor: nextCursor });
}

export async function onRequestOptions() { return optionsResponse(); }
