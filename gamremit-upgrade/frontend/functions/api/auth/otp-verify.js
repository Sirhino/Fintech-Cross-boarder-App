// functions/api/auth/otp-verify.js — Verify OTP, create Circle wallet, return JWT
import { signJWT, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, pushAdminNotif, sendTelegram } from '../_db.js';

const MAX_ATTEMPTS = 5;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { email, otp, firstName, lastName, phone, country } = body;
  if (!email?.includes('@')) return jsonResponse({ error: 'Email required' }, 400);
  if (!otp || otp.length !== 6) return jsonResponse({ error: 'Enter the 6-digit code' }, 400);

  const emailKey = email.toLowerCase().trim();
  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';

  // ── Retrieve stored OTP ────────────────────────────────────────
  const stored = await kvGetOtp(`otp:${emailKey}`, env);
  if (!stored) return jsonResponse({ error: 'Code expired. Request a new one.' }, 400);
  if (Date.now() > stored.expires) return jsonResponse({ error: 'Code expired. Request a new one.' }, 400);
  if (stored.attempts >= MAX_ATTEMPTS) return jsonResponse({ error: 'Too many attempts. Request a new code.' }, 429);

  if (stored.otp !== otp.trim()) {
    stored.attempts = (stored.attempts || 0) + 1;
    await kvSetOtp(`otp:${emailKey}`, stored, 600, env);
    const left = MAX_ATTEMPTS - stored.attempts;
    return jsonResponse({ error: `Invalid code. ${left} attempt${left === 1 ? '' : 's'} left.` }, 400);
  }

  // Delete OTP after successful verify
  await kvDelOtp(`otp:${emailKey}`, env);

  // ── Check if user exists ────────────────────────────────────────
  let user = await getUser(emailKey, env);
  let isNew = false;

  if (!user) {
    // New user registration via OTP — require profile fields
    if (!firstName?.trim() || !lastName?.trim()) {
      return jsonResponse({ needsProfile: true, message: 'Complete your profile to finish registration.' }, 200);
    }
    isNew = true;
    const userId = `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Create Circle user-controlled wallet
    let circleUserId = null, circleWalletId = null;
    try {
      const circleResp = await createCircleUserWallet(userId, env);
      circleUserId   = circleResp?.userId   || null;
      circleWalletId = circleResp?.walletId || null;
    } catch (e) { console.error('[circle:wallet]', e.message); }

    user = {
      id: userId,
      email: emailKey,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: (phone || '').trim(),
      country: (country || '').trim(),
      role: 'user',
      status: 'pending',
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      avatar: `${firstName[0]}${lastName[0]}`.toUpperCase(),
      totalSent: 0,
      totalTxCount: 0,
      authMethod: 'otp',
      circleUserId,
      circleWalletId,
    };

    await saveUser(user, env);

    await pushAdminNotif({
      type: 'user',
      title: '🆕 New OTP Registration',
      body: `${user.firstName} ${user.lastName} (${user.email}) registered via Email OTP.`,
      link: '/admin.html#users'
    }, env);

    await sendTelegram(
      `🔔 *New GamRemit Registration (OTP)*\n\n` +
      `👤 *Name:* ${user.firstName} ${user.lastName}\n` +
      `📧 *Email:* ${user.email}\n📱 *Phone:* ${user.phone || 'N/A'}\n` +
      `🌍 *Country:* ${user.country || 'N/A'}\n` +
      `🕐 *Time:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Banjul' })}\n\n` +
      `Action: Admin panel → Pending Approvals`, env
    );

  } else {
    // Existing user login
    if (user.status === 'blocked') return jsonResponse({ error: 'Account suspended. Contact support@gamremit.com' }, 403);
    user.lastLogin = new Date().toISOString();
    await saveUser(user, env);
  }

  const token = await signJWT({
    id: user.id, email: emailKey,
    role: user.role, status: user.status, kycStatus: user.kycStatus
  }, JWT_SECRET);

  const { passwordHash: _, ...safeUser } = user;
  return jsonResponse({
    success: true, token, user: safeUser, isNew,
    message: isNew ? 'Registration successful. Please complete KYC verification.' : 'Welcome back!'
  }, isNew ? 201 : 200);
}

// ── Create Circle User-Controlled Wallet ──────────────────────────
async function createCircleUserWallet(userId, env) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  if (!apiKey) return {};

  const r = await fetch('https://api.circle.com/v1/w3s/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  if (!r.ok) throw new Error(`Circle user create: ${r.status}`);
  const data = await r.json();
  return { userId: data?.data?.id };
}

// ── Redis OTP helpers ─────────────────────────────────────────────
async function kvGetOtp(key, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return null;
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    const parsed = JSON.parse(data.result); return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch { return null; }
}

async function kvSetOtp(key, value, ttl, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return;
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/setex/${encodeURIComponent(key)}/${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

async function kvDelOtp(key, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return;
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  });
}

export async function onRequestOptions() { return optionsResponse(); }
