// GET /api/withdrawal/institutions?currency=NGN
import { getCountry, getInstitutions, getUsdcAssetId, isFiatDisabledError, FIAT_UNAVAILABLE_MESSAGE } from './_blockradar.js';
import { jsonResponse, optionsResponse, fromRequest } from '../_auth.js';

export async function onRequestGet({ request, env }) {
  let currency;
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const payload = await fromRequest(request, JWT_SECRET);
    if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

    const url = new URL(request.url);
    currency = (url.searchParams.get('currency') || '').toUpperCase();
    const country = getCountry(currency);
    if (!country) return jsonResponse({ error: 'Unsupported currency' }, 400);

    const cacheKey = `br:institutions:${currency}`;
    const cached = await env.GAMREMIT_KV.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Only trust the cache if it actually has institutions in it — an
      // empty cached result (e.g. from a prior failed/misconfigured call)
      // should never be treated as a valid "no banks" answer; always retry
      // the real API in that case instead of serving stale emptiness.
      if (Array.isArray(parsed) && parsed.length > 0) {
        return jsonResponse({ institutions: parsed, cached: true });
      }
    }

    // Blockradar's Get Institutions endpoint requires `amount` and `assetId`
    // in addition to `currency` — the bank list isn't tied to a specific
    // withdrawal amount at this step in our flow (that's entered later), so
    // we use a small representative USDC amount purely to satisfy the
    // required parameter; it does not affect which banks are returned.
    const assetId = await getUsdcAssetId(env);
    const res = await getInstitutions(env, currency, 10, assetId);
    const list = res.data || [];
    // Only cache genuinely non-empty results — caching an empty list for
    // a full day is exactly what masked this bug for you the first time.
    if (list.length > 0) {
      await env.GAMREMIT_KV.put(cacheKey, JSON.stringify(list), { expirationTtl: 86400 });
    }
    return jsonResponse({ institutions: list, available: true, cached: false });
  } catch (e) {
    console.error('[withdrawal:institutions]', currency, e.message);
    // Compliance-gated: this isn't a bug and isn't the end user's fault —
    // return a calm "no banks yet" state (200 OK) so the UI shows the
    // existing friendly empty-state instead of an error banner.
    if (isFiatDisabledError(e)) {
      return jsonResponse({ institutions: [], available: false, reason: FIAT_UNAVAILABLE_MESSAGE, cached: false });
    }
    return jsonResponse({ error: e.message || 'Could not load institutions' }, e.status || 502);
  }
}
export async function onRequestOptions() { return optionsResponse(); }
