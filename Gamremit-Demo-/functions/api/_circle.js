// functions/api/_circle.js — Circle Developer-Controlled Wallets (REST, fetch-based)
// Mirrors the ciphertext pattern already used in auth/circle-wallet.js, generalized
// for balance checks, transfers, and transaction status polling.

export async function getEntityCiphertext(env) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const entitySecret = env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error('Circle credentials not configured');

  const pubKeyRes = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const pubKeyData = await pubKeyRes.json();
  const pubKeyPem = pubKeyData?.data?.publicKey;
  if (!pubKeyPem) throw new Error('Could not fetch Circle entity public key');

  const pemBody = pubKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey('spki', binaryDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const secretBytes = Uint8Array.from(entitySecret.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, secretBytes);
  // NEVER reuse this across requests — generate fresh every call (per Circle's replay-attack rule).
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

const BLOCKCHAIN = 'ARC-TESTNET'; // matches the chain wallets are created on in circle-wallet.js

export async function getUsdcBalance(walletId, env) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const usdcAddress = env.USDC_ADDRESS;
  const url = `https://api.circle.com/v1/w3s/wallets/${walletId}/balances${usdcAddress ? `?tokenAddresses=${encodeURIComponent(usdcAddress)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'Could not fetch wallet balance');
  const tokenBalances = data?.data?.tokenBalances || [];
  const usdc = usdcAddress
    ? tokenBalances.find(t => (t.token?.tokenAddress || '').toLowerCase() === usdcAddress.toLowerCase())
    : tokenBalances.find(t => (t.token?.symbol || '').toUpperCase() === 'USDC');
  return parseFloat(usdc?.amount || '0');
}

// Arc Testnet token addresses. Both are fixed, publicly documented testnet
// contracts (not secrets) — hardcoded here so transfers never depend on an
// env var that might be unset. env.USDC_ADDRESS can still override this if
// explicitly configured (e.g. pointing at a different deployment).
const ARC_TOKENS = {
  USDC: (env) => env?.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
  EURC: () => '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};

export async function getAllBalances(walletId, env) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'Could not fetch wallet balances');
  const tokenBalances = data?.data?.tokenBalances || [];

  const wanted = ['USDC', 'EURC'];
  return wanted.map(symbol => {
    const match = tokenBalances.find(t => (t.token?.symbol || '').toUpperCase() === symbol);
    return {
      symbol,
      amount: parseFloat(match?.amount || '0'),
      tokenAddress: match?.token?.tokenAddress || (symbol === 'EURC' ? ARC_TOKENS.EURC() : ARC_TOKENS.USDC(env)),
    };
  });
}

export async function transferToken(env, { walletId, destinationAddress, amount, symbol = 'USDC' }) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const tokenAddress = symbol === 'EURC' ? ARC_TOKENS.EURC() : ARC_TOKENS.USDC(env);
  if (!tokenAddress) throw new Error(`${symbol}_ADDRESS not configured`);
  const ciphertext = await getEntityCiphertext(env);

  const res = await fetch('https://api.circle.com/v1/w3s/developer/transactions/transfer', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      entitySecretCiphertext: ciphertext,
      walletId,
      tokenAddress,
      blockchain: BLOCKCHAIN,
      destinationAddress,
      amounts: [String(amount)],
      feeLevel: 'MEDIUM',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.message || 'Circle transfer failed');
    err.status = res.status;
    throw err;
  }
  return data.data?.transaction || data.data;
}

export async function transferUsdc(env, { walletId, destinationAddress, amount }) {
  return transferToken(env, { walletId, destinationAddress, amount, symbol: 'USDC' });
}

// ── Resolve a Circle tokenId (internal UUID, as sent in wallet webhooks)
// to a human symbol (USDC / EURC). Webhook notifications only give us
// tokenId, never the symbol, so we look it up against Circle's token API
// and cache the result in KV — a given tokenId's symbol never changes,
// so this only ever costs one real lookup per token, ever.
export async function getTokenSymbolById(tokenId, env) {
  if (!tokenId) return null;
  const cacheKey = `circle:token-symbol:${tokenId}`;
  try {
    const cached = env.GAMREMIT_KV ? await env.GAMREMIT_KV.get(cacheKey) : null;
    if (cached) return cached;
  } catch { /* KV miss/unavailable — fall through to live lookup */ }

  try {
    const apiKey = env.CIRCLE_USER_API_KEY;
    const res = await fetch(`https://api.circle.com/v1/w3s/tokens/${tokenId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();
    const symbol = (data?.data?.token?.symbol || '').toUpperCase() || null;
    if (symbol && env.GAMREMIT_KV) {
      await env.GAMREMIT_KV.put(cacheKey, symbol, { expirationTtl: 2592000 }); // 30 days
    }
    return symbol;
  } catch (e) {
    console.error('[circle:token-lookup]', e.message);
    return null;
  }
}

export async function getCircleTransaction(env, id) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const res = await fetch(`https://api.circle.com/v1/w3s/transactions/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'Could not fetch Circle transaction');
  return data.data?.transaction;
}

export const CIRCLE_TERMINAL_STATES = ['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'];

// ── Webhook signature verification ─────────────────────────────────
// Circle signs every webhook body with ECDSA P-256/SHA-256. The public
// key is fetched (and cached) per X-Circle-Key-Id. Circle's signature is
// DER-encoded ASN.1, but WebCrypto's ECDSA verify expects raw (r||s)
// format — so we convert DER -> raw before verifying.

function derToRawEcdsaSignature(der) {
  // Minimal DER SEQUENCE { INTEGER r, INTEGER s } parser -> 64-byte raw r||s
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('Invalid DER signature (no SEQUENCE)');
  let seqLen = der[offset++];
  if (seqLen & 0x80) offset += seqLen & 0x7f; // skip multi-byte length, rare for P-256

  function readInt() {
    if (der[offset++] !== 0x02) throw new Error('Invalid DER signature (no INTEGER)');
    let len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // strip leading zero padding byte (sign bit), left-pad to 32 bytes
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  }
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function getCirclePublicKey(env, keyId) {
  const cacheKey = `circle:pubkey:${keyId}`;
  const cached = await env.GAMREMIT_KV.get(cacheKey);
  let publicKeyB64;
  if (cached) {
    publicKeyB64 = cached;
  } else {
    const res = await fetch(`https://api.circle.com/v2/notifications/publicKey/${keyId}`, {
      headers: { Authorization: `Bearer ${env.CIRCLE_USER_API_KEY}` },
    });
    const data = await res.json();
    publicKeyB64 = data?.data?.publicKey;
    if (!publicKeyB64) throw new Error('Could not fetch Circle webhook public key');
    await env.GAMREMIT_KV.put(cacheKey, publicKeyB64, { expirationTtl: 86400 });
  }
  const der = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function verifyCircleWebhookSignature(env, { keyId, signatureB64, rawBody }) {
  if (!keyId || !signatureB64) return false;
  try {
    const publicKey = await getCirclePublicKey(env, keyId);
    const sigDer = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    const sigRaw = derToRawEcdsaSignature(sigDer);
    const data = new TextEncoder().encode(rawBody);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigRaw, data);
  } catch (e) {
    console.error('[circle:webhook-verify]', e.message);
    return false;
  }
}
