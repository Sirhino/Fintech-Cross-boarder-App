// functions/api/auth/login.js — Cloudflare Pages Function
import { signJWT, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, verifyPassword } from '../_db.js';

const ADMIN_EMAIL = 'admin@gamremit.com';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { email, password } = body;
  if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400);

  const emailKey = email.toLowerCase().trim();
  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';

  // ── ADMIN LOGIN ───────────────────────────────────────────────
  if (emailKey === ADMIN_EMAIL) {
    const adminPassword = env.ADMIN_PASSWORD || 'GamRemit@Admin2025!';
    const match = password === adminPassword;
    if (!match) return jsonResponse({ error: 'Invalid email or password' }, 401);

    const adminUser = {
      id: 'admin-001', email: ADMIN_EMAIL,
      firstName: 'GamRemit', lastName: 'Admin',
      phone: '+220000000', country: 'GM',
      role: 'admin', status: 'active', kycStatus: 'verified',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastLogin: new Date().toISOString(), avatar: 'GA',
      totalSent: 0, totalTxCount: 0
    };
    const token = await signJWT({ id: 'admin-001', email: ADMIN_EMAIL, role: 'admin', status: 'active' }, JWT_SECRET);
    return jsonResponse({ success: true, token, user: adminUser });
  }

  // ── REGULAR USER LOGIN ────────────────────────────────────────
  const user = await getUser(emailKey, env);
  if (!user) return jsonResponse({ error: 'Invalid email or password' }, 401);

  const match = await verifyPassword(password, user.passwordHash);
  if (!match) return jsonResponse({ error: 'Invalid email or password' }, 401);

  // Extended status checks
  if (user.status === 'suspended' || user.status === 'blocked') {
    return jsonResponse({ error: 'Your account has been suspended. Contact support@gamremit.com', status: 'suspended' }, 403);
  }
  if (user.status === 'closed') {
    return jsonResponse({ error: 'This account has been permanently closed.', status: 'closed' }, 403);
  }

  user.lastLogin = new Date().toISOString();
  await saveUser(user, env);

  const token = await signJWT({
    id: user.id, email: emailKey,
    role: user.role, status: user.status, kycStatus: user.kycStatus
  }, JWT_SECRET);

  const { passwordHash: _, ...safeUser } = user;
  return jsonResponse({ success: true, token, user: safeUser });
}

export async function onRequestOptions() { return optionsResponse(); }
