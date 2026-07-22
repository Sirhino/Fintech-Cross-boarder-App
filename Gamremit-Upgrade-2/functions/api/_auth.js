// functions/api/_auth.js — JWT helper for Cloudflare Pages
// Cloudflare uses Web Crypto API instead of Node crypto

const SECRET_KEY_CACHE = {};

async function getKey(secret) {
  if (SECRET_KEY_CACHE[secret]) return SECRET_KEY_CACHE[secret];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
  SECRET_KEY_CACHE[secret] = key;
  return key;
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

export async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + 7 * 24 * 3600 }; // 7 days
  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(body)));
  const msg = `${headerB64}.${payloadB64}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return `${msg}.${base64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const msg = `${headerB64}.${payloadB64}`;
    const key = await getKey(secret);
    const enc = new TextEncoder();
    const sig = Uint8Array.from(b64decode(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(msg));
    if (!valid) return null;
    const payload = JSON.parse(b64decode(payloadB64));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export async function fromRequest(request, secret) {
  try {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return null;
    return await verifyJWT(token, secret);
  } catch { return null; }
}

export function cors(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(), ...extraHeaders }
  });
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: cors() });
}
