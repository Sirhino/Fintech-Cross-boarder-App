// functions/api/rates.js — Cloudflare Pages Function
import { fromRequest, jsonResponse, optionsResponse } from './_auth.js';
import { getRates, saveRates } from './_db.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const url = new URL(request.url);
  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';

  // ── GET: preview quote ────────────────────────────────────────
  if (request.method === 'GET' && url.searchParams.get('preview') === '1') {
    const from   = url.searchParams.get('from')?.toUpperCase();
    const to     = url.searchParams.get('to')?.toUpperCase();
    const amount = parseFloat(url.searchParams.get('amount') || '0');

    if (!from || !to || !amount) return jsonResponse({ error: 'from, to, amount required' }, 400);

    const rates = await getRates(env);
    const key   = `${from}-${to}`;
    const r     = rates[key];
    if (!r || !r.active) return jsonResponse({ error: `Pair ${key} not available` }, 400);

    const { getTier } = await import('./_db.js');
    const tier         = getTier(amount, from, to);
    const effectiveRate= parseFloat((r.rate * (1 - tier.fee / 100)).toFixed(6));
    const receive      = parseFloat((amount * effectiveRate).toFixed(6));

    return jsonResponse({
      success: true, from, to, amount,
      baseRate: r.rate, effectiveRate,
      fee: tier.fee, tierLabel: tier.label,
      receive, lockedAt: new Date().toISOString()
    });
  }

  // ── GET: all rates ────────────────────────────────────────────
  if (request.method === 'GET') {
    const rates = await getRates(env);
    return jsonResponse({ success: true, rates, updatedAt: rates.updatedAt, updatedBy: rates.updatedBy });
  }

  // ── POST: admin updates rate ──────────────────────────────────
  if (request.method === 'POST') {
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim)               return jsonResponse({ error: 'Unauthorized' }, 401);
    if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { pair, rate, fee, active } = body;
    if (!pair) return jsonResponse({ error: 'pair required e.g. GMD-NGN' }, 400);

    const rates = await getRates(env);
    if (!rates[pair]) rates[pair] = { rate: 0, fee: 1.5, active: true, label: pair };
    if (rate   !== undefined) rates[pair].rate   = parseFloat(rate);
    if (fee    !== undefined) rates[pair].fee    = parseFloat(fee);
    if (active !== undefined) rates[pair].active = Boolean(active);
    rates.updatedAt = new Date().toISOString();
    rates.updatedBy = claim.email;

    await saveRates(rates, env);
    return jsonResponse({ success: true, pair, updated: rates[pair], updatedAt: rates.updatedAt });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
