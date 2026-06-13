// functions/api/auth/register.js — Cloudflare Pages Function
import { signJWT, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, hashPassword, pushAdminNotif, sendTelegram } from '../_db.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { firstName, lastName, email, phone, country, password, confirmPassword } = body;

  const errors = [];
  if (!firstName?.trim())               errors.push('First name required');
  if (!lastName?.trim())                errors.push('Last name required');
  if (!email?.includes('@'))            errors.push('Valid email required');
  if (!phone?.trim())                   errors.push('Phone required');
  if (!country?.trim())                 errors.push('Country required');
  if (!password || password.length < 8) errors.push('Password min 8 characters');
  if (password !== confirmPassword)     errors.push('Passwords do not match');
  if (errors.length) return jsonResponse({ error: errors[0], errors }, 400);

  const emailKey = email.toLowerCase().trim();
  const existing = await getUser(emailKey, env);
  if (existing) return jsonResponse({ error: 'Email already registered' }, 409);

  const passwordHash = await hashPassword(password);
  const userId = `usr-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

  const user = {
    id: userId, email: emailKey, passwordHash,
    firstName: firstName.trim(), lastName: lastName.trim(),
    phone: phone.trim(), country: country.trim(),
    role: 'user', status: 'pending', kycStatus: 'pending',
    createdAt: new Date().toISOString(), lastLogin: null,
    avatar: `${firstName[0]}${lastName[0]}`.toUpperCase(),
    totalSent: 0, totalTxCount: 0
  };

  await saveUser(user, env);

  await pushAdminNotif({
    type: 'user',
    title: '🆕 New Registration',
    body: `${user.firstName} ${user.lastName} (${user.email}) registered.`,
    link: '/admin.html#users'
  }, env);

  await sendTelegram(
    `🔔 *New GamRemit Registration*\n\n` +
    `👤 *Name:* ${user.firstName} ${user.lastName}\n` +
    `📧 *Email:* ${user.email}\n` +
    `📱 *Phone:* ${user.phone}\n` +
    `🌍 *Country:* ${user.country}\n` +
    `🕐 *Time:* ${new Date().toLocaleString('en-GB',{timeZone:'Africa/Banjul'})}\n\n` +
    `Action: Admin panel → Pending Approvals`, env
  );

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const token = await signJWT({ id: userId, email: emailKey, role: 'user', status: 'pending', kycStatus: 'pending' }, JWT_SECRET);
  const { passwordHash: _, ...safeUser } = user;

  return jsonResponse({ success: true, token, user: safeUser,
    message: 'Registration successful. Please complete KYC verification.' }, 201);
}

export async function onRequestOptions() { return optionsResponse(); }
