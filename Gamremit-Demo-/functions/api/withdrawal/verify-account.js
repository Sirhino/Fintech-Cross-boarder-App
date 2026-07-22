// POST /api/withdrawal/verify-account
// body: { accountNumber, institutionCode, currency }
import { getCountry, verifyAccount, isFiatDisabledError, FIAT_UNAVAILABLE_MESSAGE } from './_blockradar.js';
import { jsonResponse, optionsResponse, fromRequest } from '../_auth.js';

export async function onRequestPost({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const payload = await fromRequest(request, JWT_SECRET);
  if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { accountNumber, institutionCode, currency } = body || {};

  if (!accountNumber || !institutionCode || !currency) {
    return jsonResponse({ error: 'accountNumber, institutionCode and currency are required' }, 400);
  }
  if (!getCountry(currency)) return jsonResponse({ error: 'Unsupported currency' }, 400);
  if (!/^[0-9A-Za-z]{4,20}$/.test(String(accountNumber).trim())) {
    return jsonResponse({ error: 'Invalid account number format' }, 400);
  }

  try {
    const res = await verifyAccount(env, {
      accountIdentifier: String(accountNumber).trim(),
      currency: currency.toUpperCase(),
      institutionIdentifier: institutionCode,
    });
    return jsonResponse({
      accountName: res.data?.accountName || res.data?.account_name || null,
      raw: res.data,
    });
  } catch (e) {
    if (isFiatDisabledError(e)) {
      return jsonResponse({ error: FIAT_UNAVAILABLE_MESSAGE }, 503);
    }
    return jsonResponse({ error: e.message || 'Account verification failed' }, e.status || 400);
  }
}
export async function onRequestOptions() { return optionsResponse(); }
