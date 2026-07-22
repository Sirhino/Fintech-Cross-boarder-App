// functions/api/withdrawal/_blockradar.js
// Shared helper for Blockradar's Withdraw Fiat API.
// Docs: https://docs.blockradar.co/en/use-cases/withdraw-fiat
//
// We use the MASTER WALLET endpoints (treasury-style payout), not the
// per-user "child address" endpoints. That means: GamRemit's own
// Blockradar wallet is the thing that actually disburses fiat, and we
// keep an internal ledger entry recording which user's balance was
// debited for which withdrawal. This matches how the rest of this
// codebase already tracks money movement (bridge/transfer.js,
// pay/payroll.js are ledger-based too, not literal per-user on-chain
// custody) — see the note in execute.js about the one real gap this
// leaves open.

const BASE_URL = 'https://api.blockradar.co/v1';

export const SUPPORTED_COUNTRIES = [
  { code: 'NG', currency: 'NGN', name: 'Nigeria',  flag: '🇳🇬', min: 5000,  max: 5000000 },
  { code: 'KE', currency: 'KES', name: 'Kenya',    flag: '🇰🇪', min: 500,   max: 1000000 },
  { code: 'TZ', currency: 'TZS', name: 'Tanzania', flag: '🇹🇿', min: 5000,  max: 5000000 },
  { code: 'UG', currency: 'UGX', name: 'Uganda',   flag: '🇺🇬', min: 5000,  max: 5000000 },
  { code: 'MW', currency: 'MWK', name: 'Malawi',   flag: '🇲🇼', min: 5000,  max: 5000000 },
];
// NOTE: min/max above are placeholders — replace with whatever limits
// you actually want to enforce per corridor. Blockradar itself doesn't
// publish fixed min/max per currency in the docs I have access to; these
// are app-level guardrails, not provider limits.

export function getCountry(currencyOrCode) {
  const v = String(currencyOrCode || '').toUpperCase();
  return SUPPORTED_COUNTRIES.find(c => c.currency === v || c.code === v) || null;
}

function headers(env) {
  if (!env?.BLOCKRADAR_API_KEY) throw new Error('BLOCKRADAR_API_KEY not configured');
  return { 'x-api-key': env.BLOCKRADAR_API_KEY, 'Content-Type': 'application/json' };
}

function walletId(env) {
  if (!env?.BLOCKRADAR_WALLET_ID) throw new Error('BLOCKRADAR_WALLET_ID not configured');
  return env.BLOCKRADAR_WALLET_ID;
}

// Blockradar's own gateway returns this exact shape while a business's
// Withdraw Fiat access is pending compliance review — see
// https://docs.blockradar.co/en/essentials/withdraw-fiat. This is a
// business-onboarding state (ours to resolve with Blockradar), not a
// per-user error, so callers should treat it as "not available yet"
// rather than a generic failure.
const FIAT_DISABLED_PATTERNS = [
  /fiat withdrawal feature is not enabled/i,
  /not enabled for this business/i,
  /complete.*(onboarding|compliance)/i,
  /kyb/i,
];

export function isFiatDisabledError(err) {
  const msg = String(err?.message || '');
  return FIAT_DISABLED_PATTERNS.some(re => re.test(msg));
}

// A single, calm, end-user-facing message for the compliance-gated case.
// Blockradar's raw message talks about "this business" contacting their
// support — that's guidance for GamRemit's operator, not GamRemit's own
// customers, so we never show it to end users directly.
export const FIAT_UNAVAILABLE_MESSAGE =
  'Bank withdrawals aren\'t available yet — our payment partner is still completing a compliance review on our account. Please check back soon.';

async function br(env, path, opts = {}) {
  const url = `${BASE_URL}/wallets/${walletId(env)}${path}`;
  let res;
  // 12s timeout we control ourselves. Without this, a slow/hanging
  // Blockradar response just sits in fetch() until Cloudflare's own
  // platform-level execution limit kills the Function — and a
  // platform kill returns Cloudflare's own generic error page (not
  // JSON), which never reaches our try/catch below at all. That's how
  // Blockradar's real error/response was getting lost and showing up
  // to the user as a bare "something went wrong" with no detail.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    res = await fetch(url, { ...opts, headers: { ...headers(env), ...(opts.headers || {}) }, signal: controller.signal });
  } catch (networkErr) {
    // fetch() itself threw (DNS/network/timeout/abort) — never let this
    // surface as a bare, message-less error further up the chain.
    const isTimeout = networkErr.name === 'AbortError';
    const err = new Error(isTimeout
      ? 'Blockradar did not respond in time. Please try again in a moment.'
      : 'Could not reach the payment provider. Please try again in a moment.');
    err.status = 502;
    err.cause = networkErr;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON body, e.g. an HTML error page */ }

  if (!res.ok || data.status === false) {
    const msg =
      data?.message ||
      data?.error ||
      data?.errors?.[0]?.message ||
      (raw && raw.length < 300 ? raw : null) ||
      `Blockradar request failed (${res.status || 'unknown status'})`;
    console.error('[blockradar]', path, res.status, msg);
    const err = new Error(msg);
    // Always normalize to a real HTTP error code — never let a 2xx
    // status (e.g. a 200 with {status:false}) leak through as an "error"
    // status, and never leave it undefined either.
    err.status = (!res.ok && res.status >= 400) ? res.status : 502;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getAssets(env) {
  return br(env, '/withdraw/fiat/assets');
}

export async function getInstitutions(env, currency, amount, assetId) {
  const qs = new URLSearchParams({ currency, amount: String(amount), assetId });
  return br(env, `/withdraw/fiat/institutions?${qs}`);
}

export async function getRates(env, currency, assetId, amount) {
  const qs = new URLSearchParams({ currency, assetId, amount: String(amount) });
  return br(env, `/withdraw/fiat/rates?${qs}`);
}

export async function verifyAccount(env, { accountIdentifier, currency, institutionIdentifier }) {
  return br(env, '/withdraw/fiat/institution-account-verification', {
    method: 'POST',
    body: JSON.stringify({ accountIdentifier, currency, institutionIdentifier }),
  });
}

export async function getQuote(env, { assetId, amount, currency, accountIdentifier, institutionIdentifier }) {
  return br(env, '/withdraw/fiat/quote', {
    method: 'POST',
    body: JSON.stringify({ assetId, amount: String(amount), currency, accountIdentifier, institutionIdentifier }),
  });
}

export async function executeWithdrawal(env, payload) {
  return br(env, '/withdraw/fiat/execute', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Default USDC asset id is fetched + cached in KV for an hour so every
// quote/execute call doesn't re-hit /assets.
export async function getUsdcAssetId(env) {
  const cacheKey = 'br:usdc-asset-id';
  const cached = await env.GAMREMIT_KV.get(cacheKey);
  if (cached) return cached;
  const res = await getAssets(env);
  const usdc = (res.data || []).find(a => (a.asset?.symbol || a.symbol || '').toUpperCase() === 'USDC');
  if (!usdc) throw new Error('USDC not found in Blockradar supported assets for this wallet');
  const id = usdc.asset?.id || usdc.id;
  await env.GAMREMIT_KV.put(cacheKey, id, { expirationTtl: 3600 });
  return id;
}
