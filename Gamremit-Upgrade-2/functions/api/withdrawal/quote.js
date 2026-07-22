// POST /api/withdrawal/quote
// body: { usdcAmount, currency, accountNumber, institutionCode }
import { getCountry, getQuote, getUsdcAssetId, isFiatDisabledError, FIAT_UNAVAILABLE_MESSAGE } from './_blockradar.js';
import { jsonResponse, optionsResponse, fromRequest } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { usdcAmount, currency, accountNumber, institutionCode } = body || {};

  const amount = parseFloat(usdcAmount);
  const country = getCountry(currency);
  if (!country) return jsonResponse({ error: 'Unsupported currency' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);
  if (!accountNumber || !institutionCode) return jsonResponse({ error: 'accountNumber and institutionCode are required' }, 400);

  try {
    const assetId = await getUsdcAssetId(env);
    const res = await getQuote(env, {
      assetId,
      amount,
      currency: country.currency,
      accountIdentifier: String(accountNumber).trim(),
      institutionIdentifier: institutionCode,
    });
    const q = res.data || {};

    // Stash the quote for ~3 minutes so execute.js can re-validate the
    // client didn't tamper with fee/rate before confirming.
    const quoteId = `qt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.GAMREMIT_KV.put(
      `br:quote:${quoteId}`,
      JSON.stringify({ ...q, assetId, usdcAmount: amount, currency: country.currency, accountNumber, institutionCode, userId: payload.id }),
      { expirationTtl: 180 }
    );

    return jsonResponse({
      quoteId,
      usdcAmount: amount,
      currency: country.currency,
      exchangeRate: q.rate || q.rateUSD || null,
      networkFee: q.fee ?? q.networkFee ?? 0,
      amountReceived: q.toAmount ?? null,
      estimatedArrivalTime: q.estimatedArrivalTime || '5-30 minutes',
      expiresInSeconds: 180,
    });
  } catch (e) {
    if (isFiatDisabledError(e)) {
      return jsonResponse({ error: FIAT_UNAVAILABLE_MESSAGE }, 503);
    }
    return jsonResponse({ error: e.message || 'Could not fetch quote' }, e.status || 502);
  }
}
export async function onRequestOptions() { return optionsResponse(); }
