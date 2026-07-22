// functions/api/auth/otp-send.js — Email OTP login (replaces password)
import { jsonResponse, optionsResponse } from '../_auth.js';
import { sendEmail } from '../_db.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { email } = body;
  if (!email?.includes('@')) return jsonResponse({ error: 'Valid email required' }, 400);

  const emailKey = email.toLowerCase().trim();

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Store OTP in Cloudflare KV — expirationTtl handles expiry natively;
  // we keep `expires` in the payload too as a belt-and-suspenders check.
  const otpData = { otp, expires, attempts: 0 };
  await kvSetWithTTL(`otp:${emailKey}`, otpData, 600, env);

  // Send OTP email via Brevo
  const html = `
    <div style="font-family:'Sora',sans-serif;max-width:480px;margin:0 auto;background:#07090F;color:#fff;border-radius:16px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#1246F5,#2A5AFF);padding:28px 32px;text-align:center">
        <h1 style="margin:0;font-size:1.6rem;font-weight:800;letter-spacing:-.02em">GamRemit</h1>
        <p style="margin:8px 0 0;opacity:.8;font-size:.9rem">Secure Sign-In Code</p>
      </div>
      <div style="padding:32px">
        <p style="color:rgba(255,255,255,.7);margin:0 0 24px;font-size:.95rem;line-height:1.7">
          Here is your one-time sign-in code for GamRemit. It expires in <strong style="color:#00D48C">10 minutes</strong>.
        </p>
        <div style="background:rgba(18,70,245,.12);border:2px solid rgba(18,70,245,.3);border-radius:14px;padding:22px;text-align:center;margin-bottom:24px">
          <div style="font-size:2.6rem;font-weight:800;font-family:'Space Mono',monospace;letter-spacing:.18em;color:#fff">${otp}</div>
        </div>
        <p style="color:rgba(255,255,255,.45);font-size:.78rem;line-height:1.6;margin:0">
          If you didn't request this code, you can safely ignore this email. Never share this code with anyone — GamRemit will never ask for it.
        </p>
      </div>
      <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,.08);text-align:center">
        <p style="color:rgba(255,255,255,.3);font-size:.72rem;margin:0">© 2025 GamRemit · Arc Testnet · USDC Settlement</p>
      </div>
    </div>
  `;

  await sendEmail({ to: emailKey, subject: `${otp} — Your GamRemit Sign-In Code`, html }, env);

  return jsonResponse({ success: true, message: 'OTP sent to your email', expiresIn: 600 });
}

// Helper: set with TTL (600s = 10 min) using Cloudflare KV's native expirationTtl
async function kvSetWithTTL(key, value, ttlSeconds, env) {
  if (!env?.GAMREMIT_KV) { console.error('[otp:set] GAMREMIT_KV binding missing'); return; }
  try {
    await env.GAMREMIT_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch (e) { console.error('[otp:set]', e.message); }
}

export async function onRequestOptions() { return optionsResponse(); }
