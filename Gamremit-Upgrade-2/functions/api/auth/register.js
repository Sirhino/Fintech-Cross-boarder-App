// functions/api/auth/register.js — Cloudflare Pages Function
import { signJWT, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser, hashPassword, pushAdminNotif, sendTelegram, sendEmailKYC } from '../_db.js';

// Same visual style as the KYC status emails in kyc/index.js, so the new
// user gets a consistent look from their very first email.
function welcomeKycEmailHtml({ firstName }) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#07090F;color:#fff;padding:32px 24px;max-width:520px;margin:0 auto">
    <h2 style="color:#F0A033">⏳ Verify Your Identity</h2>
    <p style="color:rgba(255,255,255,.7);line-height:1.7">Dear ${firstName},<br><br>
    Welcome to GamRemit! Your account has been created. Before you can send money, please complete KYC verification by uploading your identity documents.
    </p>
    <a href="https://gamremit.xyz/kyc.html" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#1246F5,#2A5AFF);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;margin-top:8px">Complete KYC →</a>
    <p style="color:rgba(255,255,255,.3);font-size:12px;margin-top:32px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px">GamRemit · 🇬🇲 Gambia ↔ 🇳🇬 Nigeria</p>
  </body></html>`;
}

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

  // Notify the new user by email (Mailjet) to complete KYC verification.
  // This was previously missing entirely — registration never emailed the
  // user, only the admin bell + Telegram fired.
  try {
    await sendEmailKYC({
      to: user.email,
      subject: 'GamRemit — Please Verify Your Identity',
      html: welcomeKycEmailHtml({ firstName: user.firstName })
    }, env);
  } catch (e) { console.error('[register] KYC welcome email failed', e.message); }

  const JWT_SECRET = env.JWT_SECRET;

  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const token = await signJWT({ id: userId, email: emailKey, role: 'user', status: 'pending', kycStatus: 'pending' }, JWT_SECRET);
  const { passwordHash: _, ...safeUser } = user;

  return jsonResponse({ success: true, token, user: safeUser,
    message: 'Registration successful. Please complete KYC verification.' }, 201);
}

export async function onRequestOptions() { return optionsResponse(); }
