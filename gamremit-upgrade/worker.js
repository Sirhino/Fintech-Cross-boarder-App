/**
 * GamRemit — Cloudflare Worker Backend
 * Handles: Auth, Users, Transactions, Rates, KYC, Notifications
 * Database: Upstash Redis (REST API)
 * Deploy: wrangler deploy
 */

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

function options() {
  return new Response(null, { status: 204, headers: CORS });
}

// ─── REDIS HELPERS ───────────────────────────────────────────────────────────
async function redis(env, cmd) {
  const url = `${env.UPSTASH_REDIS_REST_URL}/${cmd.map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

async function redisPipeline(env, commands) {
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  return data.map(r => r.result);
}

async function kv_get(env, key) {
  const val = await redis(env, ['GET', key]);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

async function kv_set(env, key, value) {
  await redis(env, ['SET', key, JSON.stringify(value)]);
}

async function kv_del(env, key) {
  await redis(env, ['DEL', key]);
}

// List helpers using Redis Sets
async function list_add(env, setKey, member) {
  await redis(env, ['SADD', setKey, member]);
}
async function list_get(env, setKey) {
  const members = await redis(env, ['SMEMBERS', setKey]);
  return Array.isArray(members) ? members : [];
}
async function list_rem(env, setKey, member) {
  await redis(env, ['SREM', setKey, member]);
}

// ─── JWT (minimal, no external libs) ────────────────────────────────────────
function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64urlDecode(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function jwtSign(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigB64}`;
}

async function jwtVerify(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
async function requireAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload) return null;
  const user = await kv_get(env, `user:${payload.id}`);
  return user;
}

async function requireAdmin(req, env) {
  const user = await requireAuth(req, env);
  if (!user || user.role !== 'admin') return null;
  return user;
}

// ─── ID / REF GENERATORS ─────────────────────────────────────────────────────
function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
function txRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'GR-';
  for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}
function avatar(firstName) {
  return firstName ? firstName.charAt(0).toUpperCase() : '?';
}

// ─── HASH PASSWORD ───────────────────────────────────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── SEED ADMIN ──────────────────────────────────────────────────────────────
async function ensureAdmin(env) {
  const existing = await kv_get(env, 'user:admin');
  if (existing) return;
  const hashed = await hashPassword(env.ADMIN_PASSWORD || 'GamRemit@Admin2025!');
  const admin = {
    id: 'admin',
    email: 'admin@gamremit.com',
    password: hashed,
    firstName: 'GamRemit',
    lastName: 'Admin',
    role: 'admin',
    status: 'active',
    country: 'GM',
    phone: '',
    avatar: 'A',
    createdAt: new Date().toISOString(),
    notifications: [],
  };
  await kv_set(env, 'user:admin', admin);
  await list_add(env, 'users', 'admin');
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
async function pushAdminNotif(env, title, body) {
  const notif = { id: uid(), title, body, read: false, createdAt: new Date().toISOString() };
  const admin = await kv_get(env, 'user:admin');
  if (admin) {
    admin.notifications = [notif, ...(admin.notifications || [])].slice(0, 50);
    await kv_set(env, 'user:admin', admin);
  }
}

async function pushUserNotif(env, userId, title, body) {
  const user = await kv_get(env, `user:${userId}`);
  if (!user) return;
  const notif = { id: uid(), title, body, read: false, createdAt: new Date().toISOString() };
  user.notifications = [notif, ...(user.notifications || [])].slice(0, 50);
  await kv_set(env, `user:${userId}`, user);
}

// ─── SAFE USER (strip password) ───────────────────────────────────────────────
function safeUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CIRCLE DEVELOPER-CONTROLLED WALLETS ────────────────────────────────────
// Pure fetch() — no Node SDK, fully compatible with Cloudflare Workers

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s';

function circleUUID() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function circleEntityCiphertext(apiKey, entitySecretHex) {
  // Fetch Circle's RSA public key — must be fresh per request (replay prevention)
  const pkRes = await fetch(`${CIRCLE_BASE}/config/entity/publicKey`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });
  if (!pkRes.ok) throw new Error(`Circle publicKey fetch failed: ${pkRes.status}`);
  const pkData = await pkRes.json();
  const pem = pkData.data?.publicKey;
  if (!pem) throw new Error('Circle returned no public key');

  // Strip PEM headers → DER bytes → import as RSA-OAEP
  const pemBody = pem
    .replace(/-----BEGIN (?:RSA )?PUBLIC KEY-----/, '')
    .replace(/-----END (?:RSA )?PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
  );

  // Encrypt the 32-byte entity secret
  const secretBytes = Uint8Array.from(entitySecretHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, cryptoKey, secretBytes);
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

async function circleCreateWallet(userId, env) {
  if (!env.CIRCLE_API_KEY || !env.CIRCLE_ENTITY_SECRET || !env.CIRCLE_WALLET_SET_ID) {
    console.warn('[circle] Skipping wallet creation — CIRCLE_* env vars not configured');
    return null;
  }
  try {
    const ciphertext = await circleEntityCiphertext(env.CIRCLE_API_KEY, env.CIRCLE_ENTITY_SECRET);
    const res = await fetch(`${CIRCLE_BASE}/developer/wallets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CIRCLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey: circleUUID(),
        accountType: 'EOA',
        blockchains: ['ARC-TESTNET'],
        count: 1,
        walletSetId: env.CIRCLE_WALLET_SET_ID,
        entitySecretCiphertext: ciphertext,
        metadata: [{ name: `gr-${userId}`, refId: userId }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Circle wallet create failed: ${res.status}`);
    const wallet = data.data?.wallets?.[0];
    if (!wallet?.id || !wallet?.address) throw new Error('No wallet in Circle response');
    console.log(`[circle] Wallet created for ${userId}: ${wallet.address}`);
    return { walletId: wallet.id, walletAddress: wallet.address };
  } catch (err) {
    // Never block registration — wallet can be provisioned retroactively
    console.error(`[circle] Wallet creation failed for ${userId}:`, err.message);
    return null;
  }
}

// ── POST /api/auth/register ──────────────────────────────────────────────────
async function handleRegister(req, env) {
  const body = await req.json().catch(() => ({}));
  const { email, password, firstName, lastName, phone, country } = body;

  if (!email || !password || !firstName || !lastName) {
    return cors({ error: 'Missing required fields' }, 400);
  }

  const emailKey = `email:${email.toLowerCase()}`;
  const existingId = await kv_get(env, emailKey);
  if (existingId) return cors({ error: 'Email already registered' }, 409);

  const id = uid();
  const hashed = await hashPassword(password);
  const user = {
    id, email: email.toLowerCase(), password: hashed,
    firstName, lastName, phone: phone || '', country: country || '',
    role: 'user', status: 'pending',
    avatar: avatar(firstName),
    kycStatus: 'none',
    createdAt: new Date().toISOString(),
    notifications: [],
    // Circle wallet fields — populated below
    walletId: null,
    walletAddress: null,
    walletNetwork: 'ARC-TESTNET',
    walletCreatedAt: null,
  };

  // Save user first — registration never blocked by wallet errors
  await kv_set(env, `user:${id}`, user);
  await kv_set(env, emailKey, id);
  await list_add(env, 'users', id);

  // Auto-create Circle EVM wallet on Arc Testnet
  const wallet = await circleCreateWallet(id, env);
  if (wallet) {
    user.walletId        = wallet.walletId;
    user.walletAddress   = wallet.walletAddress;
    user.walletCreatedAt = new Date().toISOString();
    await kv_set(env, `user:${id}`, user); // persist wallet info
  }

  await pushAdminNotif(env,
    '🆕 New Registration',
    `${firstName} ${lastName} (${email}) registered.${wallet ? ` ✅ Wallet: ${wallet.walletAddress}` : ' ⚠️ Wallet pending.'}`
  );

  const { password: _, ...safeUser } = user;
  return cors({
    success: true,
    message: 'Registration successful. Awaiting admin approval.',
    wallet: wallet
      ? { address: wallet.walletAddress, network: 'Arc Testnet', ready: true }
      : { address: null, network: 'Arc Testnet', ready: false },
    user: safeUser,
  });
}

// ── POST /api/auth/login ─────────────────────────────────────────────────────
async function handleLogin(req, env) {
  const body = await req.json().catch(() => ({}));
  const { email, password } = body;
  if (!email || !password) return cors({ error: 'Missing credentials' }, 400);

  const emailKey = `email:${email.toLowerCase()}`;
  const userId = await kv_get(env, emailKey);
  if (!userId) return cors({ error: 'Invalid email or password' }, 401);

  const user = await kv_get(env, `user:${userId}`);
  if (!user) return cors({ error: 'Invalid email or password' }, 401);

  const hashed = await hashPassword(password);
  if (hashed !== user.password) return cors({ error: 'Invalid email or password' }, 401);

  if (user.status === 'pending') {
    return cors({ error: 'Your account is pending approval. Please wait for admin review.' }, 403);
  }
  if (user.status === 'blocked') {
    return cors({ error: 'Your account has been suspended. Contact support.' }, 403);
  }

  const token = await jwtSign(
    { id: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    env.JWT_SECRET
  );

  return cors({ token, user: safeUser(user) });
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
async function handleMe(req, env, url) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);

  const withNotifs = url.searchParams.get('notifs') === '1';
  const result = { user: safeUser(user) };
  if (withNotifs) result.notifications = user.notifications || [];
  return cors(result);
}

// ── PATCH /api/auth/me ───────────────────────────────────────────────────────
async function handleUpdateMe(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const allowed = ['firstName', 'lastName', 'phone', 'country'];
  allowed.forEach(k => { if (body[k] !== undefined) user[k] = body[k]; });
  if (body.firstName) user.avatar = avatar(body.firstName);

  await kv_set(env, `user:${user.id}`, user);
  return cors({ user: safeUser(user) });
}

// ── GET /api/admin/users ─────────────────────────────────────────────────────
async function handleAdminUsers(req, env, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);

  const userIds = await list_get(env, 'users');
  const users = [];
  for (const id of userIds) {
    const u = await kv_get(env, `user:${id}`);
    if (u) users.push(safeUser(u));
  }
  users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (url.searchParams.get('stats') === '1') {
    const txIds = await list_get(env, 'transactions');
    const txs = [];
    for (const id of txIds) {
      const t = await kv_get(env, `tx:${id}`);
      if (t) txs.push(t);
    }
    const stats = {
      totalUsers: users.filter(u => u.role !== 'admin').length,
      pendingUsers: users.filter(u => u.status === 'pending').length,
      activeUsers: users.filter(u => u.status === 'active').length,
      totalTransactions: txs.length,
      pendingTransactions: txs.filter(t => t.status === 'pending').length,
      completedTransactions: txs.filter(t => t.status === 'completed').length,
      totalVolume: txs.filter(t => t.status === 'completed').reduce((s, t) => s + (t.receiveAmount || 0), 0),
    };
    return cors({ users, stats });
  }

  return cors({ users });
}

// ── PATCH /api/admin/users/:id ───────────────────────────────────────────────
async function handleAdminUpdateUser(req, env, userId) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);

  const user = await kv_get(env, `user:${userId}`);
  if (!user) return cors({ error: 'User not found' }, 404);

  const body = await req.json().catch(() => ({}));
  const allowed = ['status', 'kycStatus', 'role'];
  allowed.forEach(k => { if (body[k] !== undefined) user[k] = body[k]; });
  user.updatedAt = new Date().toISOString();

  await kv_set(env, `user:${userId}`, user);

  if (body.status === 'active') {
    await pushUserNotif(env, userId, '✅ Account Approved',
      'Your GamRemit account has been approved! You can now log in and send transfers.');
    await pushAdminNotif(env, '✅ User Approved',
      `${user.firstName} ${user.lastName} has been approved.`);
  } else if (body.status === 'blocked') {
    await pushUserNotif(env, userId, '🚫 Account Suspended',
      'Your GamRemit account has been suspended. Contact support for help.');
  }

  return cors({ user: safeUser(user) });
}

// ── GET /api/transactions ─────────────────────────────────────────────────────
async function handleGetTransactions(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);

  const txIds = await list_get(env, 'transactions');
  let txs = [];
  for (const id of txIds) {
    const t = await kv_get(env, `tx:${id}`);
    if (t) {
      // Admins see all; users see only their own
      if (user.role === 'admin' || t.userId === user.id) txs.push(t);
    }
  }
  txs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return cors({ transactions: txs });
}

// ── POST /api/transactions ────────────────────────────────────────────────────
async function handleCreateTransaction(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);
  if (user.status !== 'active') return cors({ error: 'Account not active' }, 403);

  const body = await req.json().catch(() => ({}));
  const {
    sendAmount, sendCurrency, receiveCurrency, receiveAmount, effectiveRate,
    recipientName, bankName, accountNumber,
    fromBank, fromAccount, receipt, receiptBase64
  } = body;

  if (!sendAmount || !sendCurrency || !receiveCurrency || !recipientName || !bankName || !accountNumber) {
    return cors({ error: 'Missing required fields' }, 400);
  }

  const reference = txRef();
  const tx = {
    id: uid(),
    reference,
    userId: user.id,
    userName: `${user.firstName} ${user.lastName}`,
    userEmail: user.email,
    sendAmount: Number(sendAmount),
    sendCurrency,
    receiveCurrency,
    receiveAmount: Number(receiveAmount) || 0,
    effectiveRate: effectiveRate || '',
    recipientName,
    bankName,
    accountNumber,
    fromBank: fromBank || '',
    fromAccount: fromAccount || '',
    receiptBase64: receiptBase64 || receipt || null,
    status: 'pending',
    note: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };

  await kv_set(env, `tx:${reference}`, tx);
  await list_add(env, 'transactions', reference);

  await pushAdminNotif(env,
    '💸 New Transfer Request',
    `${user.firstName} ${user.lastName} submitted a transfer of ${sendAmount} ${sendCurrency} → ${receiveAmount} ${receiveCurrency}. Ref: ${reference}`
  );

  await pushUserNotif(env, user.id, '💸 Transfer Submitted',
    `Your transfer (${reference}) has been submitted and is pending review.`
  );

  return cors({ transaction: tx }, 201);
}

// ── PATCH /api/transactions/:ref ──────────────────────────────────────────────
async function handleUpdateTransaction(req, env, ref) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);

  const tx = await kv_get(env, `tx:${ref}`);
  if (!tx) return cors({ error: 'Transaction not found' }, 404);

  // Only admin can update status; user can only update their own pending tx note
  const body = await req.json().catch(() => ({}));

  if (user.role === 'admin') {
    if (body.status) {
      tx.status = body.status;
      if (body.status === 'completed') tx.completedAt = new Date().toISOString();
      // Notify user
      const msg = {
        completed: '✅ Your transfer has been completed! Funds have been sent.',
        processing: '🔄 Your transfer is now being processed.',
        rejected: '❌ Your transfer has been rejected. Contact support for details.',
      }[body.status];
      if (msg) await pushUserNotif(env, tx.userId, `Transfer ${body.status}`, msg);
    }
    if (body.note !== undefined) tx.note = body.note;
  } else {
    // User can cancel only their own pending tx
    if (tx.userId !== user.id) return cors({ error: 'Forbidden' }, 403);
    if (tx.status !== 'pending') return cors({ error: 'Cannot modify non-pending transaction' }, 400);
    if (body.status === 'cancelled') tx.status = 'cancelled';
  }

  tx.updatedAt = new Date().toISOString();
  await kv_set(env, `tx:${ref}`, tx);
  return cors({ transaction: tx });
}

// ── GET /api/rates ────────────────────────────────────────────────────────────
async function handleGetRates(req, env, url) {
  let rates = await kv_get(env, 'rates');
  if (!rates) {
    rates = {
      'NGN-GMD': { rate: 0.052, fee: 1.5, active: true },
      'GMD-NGN': { rate: 19.2,  fee: 1.5, active: true },
      'USD-GMD': { rate: 72.5,  fee: 2.0, active: true },
      'GMD-USD': { rate: 0.0138, fee: 2.0, active: true },
      'USD-NGN': { rate: 1580,  fee: 2.0, active: true },
      'NGN-USD': { rate: 0.00063, fee: 2.0, active: true },
    };
    await kv_set(env, 'rates', rates);
  }
  const updatedAt = await kv_get(env, 'rates:updatedAt');

  // Handle preview query: ?preview=1&from=NGN&to=GMD&amount=1000
  const preview = url.searchParams.get('preview');
  if (preview === '1') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const amount = parseFloat(url.searchParams.get('amount') || '0');
    const pair = `${from}-${to}`;
    const r = rates[pair];
    if (!r || !r.active) return cors({ error: 'Rate not available for this pair' });
    const fee = r.fee || 0;
    const baseRate = r.rate;
    const feeAmount = amount * (fee / 100);
    const netAmount = amount - feeAmount;
    const receive = Math.round(netAmount * baseRate * 100) / 100;
    return cors({ receive, baseRate, fee, feeAmount, pair, from, to });
  }

  return cors({ rates, updatedAt });
}

// ── POST /api/rates ───────────────────────────────────────────────────────────
async function handleUpdateRates(req, env) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => ({}));
  const { pair, rate, fee, active } = body;
  if (!pair) return cors({ error: 'Missing pair' }, 400);

  let rates = await kv_get(env, 'rates') || {};
  if (!rates[pair]) rates[pair] = { rate: 0, fee: 0, active: true };
  if (rate !== undefined) rates[pair].rate = Number(rate);
  if (fee !== undefined) rates[pair].fee = Number(fee);
  if (active !== undefined) rates[pair].active = Boolean(active);

  const updatedAt = new Date().toISOString();
  await kv_set(env, 'rates', rates);
  await kv_set(env, 'rates:updatedAt', updatedAt);

  return cors({ updated: rates[pair], updatedAt });
}

// ── GET /api/kyc ──────────────────────────────────────────────────────────────
async function handleGetKyc(req, env) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);

  const kycIds = await list_get(env, 'kyc');
  const kycs = [];
  for (const id of kycIds) {
    const k = await kv_get(env, `kyc:${id}`);
    if (k) kycs.push(k);
  }
  kycs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return cors({ kycs });
}

// ── POST /api/kyc ─────────────────────────────────────────────────────────────
async function handleSubmitKyc(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);

  let body = {};
  try {
    const text = await req.text();
    body = JSON.parse(text);
  } catch { return cors({ error: 'Invalid request body' }, 400); }
  
  const { docType, docFront, docBack, selfie } = body;
  if (!docType || !docFront) return cors({ error: 'Missing KYC documents' }, 400);
  
  const existing = await kv_get(env, `kyc:user:${user.id}`);
  if (existing && existing.status === 'pending') {
    return cors({ error: 'KYC already submitted and pending review' }, 409);
  }

  const kycId = uid();

  // Store images separately to avoid Redis size limits
  if (docFront) await kv_set(env, `kyc-img:${kycId}:front`, docFront);
  if (docBack) await kv_set(env, `kyc-img:${kycId}:back`, docBack);
  if (selfie) await kv_set(env, `kyc-img:${kycId}:selfie`, selfie);

  const kyc = {
    id: kycId,
    userId: user.id,
    userName: `${user.firstName} ${user.lastName}`,
    userEmail: user.email,
    docType,
    hasDocFront: !!docFront,
    hasDocBack: !!docBack,
    hasSelfie: !!selfie,
    status: 'pending',
    rejectionReason: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await kv_set(env, `kyc:${kycId}`, kyc);
  await kv_set(env, `kyc:user:${user.id}`, kyc);
  await list_add(env, 'kyc', kycId);

  // Update user kycStatus
  user.kycStatus = 'pending';
  await kv_set(env, `user:${user.id}`, user);

  await pushAdminNotif(env, '🪪 KYC Submitted',
    `${user.firstName} ${user.lastName} submitted KYC documents for review.`);

  return cors({ kyc }, 201);
}


// ── GET /api/kyc/:id/images ───────────────────────────────────────────────────
async function handleGetKycImages(req, env, kycId) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);
  const front = await kv_get(env, `kyc-img:${kycId}:front`);
  const back = await kv_get(env, `kyc-img:${kycId}:back`);
  const selfie = await kv_get(env, `kyc-img:${kycId}:selfie`);
  return cors({ docFront: front, docBack: back, selfie });
}

// ── PATCH /api/kyc/:id ────────────────────────────────────────────────────────
async function handleUpdateKyc(req, env, kycId) {
  const admin = await requireAdmin(req, env);
  if (!admin) return cors({ error: 'Forbidden' }, 403);

  const kyc = await kv_get(env, `kyc:${kycId}`);
  if (!kyc) return cors({ error: 'KYC not found' }, 404);

  const body = await req.json().catch(() => ({}));
  const { status, rejectionReason } = body;

  if (status) kyc.status = status;
  if (rejectionReason) kyc.rejectionReason = rejectionReason;
  kyc.updatedAt = new Date().toISOString();

  await kv_set(env, `kyc:${kycId}`, kyc);
  await kv_set(env, `kyc:user:${kyc.userId}`, kyc);

  // Update user kycStatus
  const user = await kv_get(env, `user:${kyc.userId}`);
  if (user) {
    user.kycStatus = status;
    await kv_set(env, `user:${kyc.userId}`, user);
  }

  if (status === 'approved') {
    await pushUserNotif(env, kyc.userId, '✅ KYC Approved',
      'Your identity has been verified. Your account is now fully verified.');
  } else if (status === 'rejected') {
    await pushUserNotif(env, kyc.userId, '❌ KYC Rejected',
      `Your KYC was rejected: ${rejectionReason || 'Please resubmit with clearer documents.'}`);
  }

  return cors({ kyc });
}


// ── GET /api/track/:ref ───────────────────────────────────────────────────────
async function handleTrackTransaction(req, env, ref) {
  const tx = await kv_get(env, `tx:${ref}`);
  if (!tx) return cors({ error: 'Transaction not found' }, 404);
  // Return limited public info only
  return cors({ transaction: {
    reference: tx.reference,
    status: tx.status,
    sendAmount: tx.sendAmount,
    sendCurrency: tx.sendCurrency,
    receiveAmount: tx.receiveAmount,
    receiveCurrency: tx.receiveCurrency,
    recipientName: tx.recipientName,
    bankName: tx.bankName,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    completedAt: tx.completedAt,
    adminNote: tx.note || tx.adminNote || '',
  }});
}
// ── GET /api/notifications ────────────────────────────────────────────────────
async function handleGetNotifications(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);
  return cors({ notifications: user.notifications || [] });
}

// ── PATCH /api/notifications/read ─────────────────────────────────────────────
async function handleMarkNotifRead(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return cors({ error: 'Unauthorized' }, 401);
  (user.notifications || []).forEach(n => n.read = true);
  await kv_set(env, `user:${user.id}`, user);
  return cors({ ok: true });
}

// ── GET /api/debug ────────────────────────────────────────────────────────────
async function handleDebug(req, env) {
  const userIds = await list_get(env, 'users');
  const txIds = await list_get(env, 'transactions');
  return cors({
    deployed: new Date().toISOString(),
    env: {
      UPSTASH_REDIS_REST_URL:   env.UPSTASH_REDIS_REST_URL   ? '✅ set' : '❌ missing',
      UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN ? '✅ set' : '❌ missing',
      JWT_SECRET:               env.JWT_SECRET               ? '✅ set' : '❌ missing',
      ADMIN_PASSWORD:           env.ADMIN_PASSWORD           ? '✅ set' : '❌ missing',
      CIRCLE_API_KEY:           env.CIRCLE_API_KEY           ? '✅ set' : '❌ missing',
      CIRCLE_ENTITY_SECRET:     env.CIRCLE_ENTITY_SECRET     ? '✅ set' : '❌ missing',
      CIRCLE_WALLET_SET_ID:     env.CIRCLE_WALLET_SET_ID     ? '✅ set' : '❌ missing',
    },
    counts: { users: userIds.length, transactions: txIds.length },
    users: userIds,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // Seed admin on first run
    await ensureAdmin(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return options();

    // ── Auth routes
    if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
    if (path === '/api/auth/login'    && method === 'POST') return handleLogin(request, env);
    if (path === '/api/auth/me'       && method === 'GET')  return handleMe(request, env, url);
    if (path === '/api/auth/me'       && method === 'PATCH') return handleUpdateMe(request, env);

    // ── Admin user routes
    if (path === '/api/admin/users'   && method === 'GET')  return handleAdminUsers(request, env, url);
    const userMatch = path.match(/^\/api\/admin\/users\/(.+)$/);
    if (userMatch && method === 'PATCH') return handleAdminUpdateUser(request, env, userMatch[1]);

    // ── Transaction routes
    if (path === '/api/transactions'  && method === 'GET')  return handleGetTransactions(request, env);
    if (path === '/api/transactions'  && method === 'POST') return handleCreateTransaction(request, env);
    const txMatch = path.match(/^\/api\/transactions\/(.+)$/);
    if (txMatch && method === 'PATCH') return handleUpdateTransaction(request, env, txMatch[1]);

    // ── Rates routes
    if (path === '/api/rates'         && method === 'GET')  return handleGetRates(request, env, url);
    if (path === '/api/rates'         && method === 'POST') return handleUpdateRates(request, env);

    // ── KYC routes
    if (path === '/api/kyc'           && method === 'GET')  return handleGetKyc(request, env);
    if (path === '/api/kyc/me'        && method === 'GET')  return handleGetMyKyc(request, env);
    if (path === '/api/kyc'           && method === 'POST') return handleSubmitKyc(request, env);
    const kycImgMatch = path.match(/^\/api\/kyc\/([^\/]+)\/images$/);
    if (kycImgMatch && method === 'GET') return handleGetKycImages(request, env, kycImgMatch[1]);
    const kycMatch = path.match(/^\/api\/kyc\/(.+)$/);
    if (kycMatch && method === 'PATCH') return handleUpdateKyc(request, env, kycMatch[1]);

    // ── Notifications
    if (path === '/api/notifications'       && method === 'GET')   return handleGetNotifications(request, env);
    const trackMatch = path.match(/^\/api\/track\/(.+)$/);
    if (trackMatch && method === 'GET') return handleTrackTransaction(request, env, trackMatch[1]);
    if (path === '/api/notifications/read'  && method === 'PATCH') return handleMarkNotifRead(request, env);

    // ── Debug
    if (path === '/api/debug'         && method === 'GET')  return handleDebug(request, env);

    return cors({ error: 'Not found' }, 404);
  },
};
