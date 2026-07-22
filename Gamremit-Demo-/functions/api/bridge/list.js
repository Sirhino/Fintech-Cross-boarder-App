// functions/api/bridge/list.js — lists the current user's bridge records.
// Used by the frontend on page load to resume polling any bridge that's
// still in-flight (state !== 'success' && state !== 'error'), since the
// original polling loop in app.html only runs for the lifetime of the page
// that submitted the bridge and has no way to pick back up after a reload
// or navigation away.
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser } from '../_db.js';

export async function onRequestGet({ request, env }) {
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

    const user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    const url = new URL(request.url);
    const pendingOnly = url.searchParams.get('pending') === '1';

    const { results } = await env.DB.prepare(
      'SELECT data FROM bridges WHERE user_id = ? ORDER BY id DESC LIMIT 50'
    ).bind(user.id).all();

    let bridges = (results || []).map(r => JSON.parse(r.data));
    if (pendingOnly) {
      bridges = bridges.filter(b => b.state !== 'success' && b.state !== 'error');
    }

    return jsonResponse({ success: true, bridges });
  } catch (e) {
    console.error('[bridge:list]', e.message);
    return jsonResponse({ error: e.message || 'Failed to list bridges' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
