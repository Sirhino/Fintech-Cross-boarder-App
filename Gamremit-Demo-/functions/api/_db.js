// functions/api/_db.js — Cloudflare D1 backed data layer
// Persistent, growing business data (users, transactions, KYC, notifications,
// audit logs, etc.) lives in D1 (env.DB) instead of KV. D1's free tier
// (5M reads/day, 100K writes/day, no separate list() cap) is dramatically
// more generous than KV's (100K reads/day, 1,000 writes/day, 1,000 list()
// calls/day — the exact limit that broke KYC/transactions listing).
// Short-lived TTL caches (OTP codes, JWK/asset-id caches, quote lookups)
// intentionally stay on KV elsewhere in the codebase — TTL auto-expiry is
// exactly what KV is built for, and their volume is low.

const mem = {};

function isDeployed(env) {
  return !!(env && env.DB);
}

// ── BCRYPT via pure JS (no Node crypto needed) ────────────────────
async function hashPassword(password) {
  // Use SubtleCrypto PBKDF2 as bcrypt alternative for Cloudflare
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const saltHex = Array.from(salt).map(b=>b.toString(16).padStart(2,'0')).join('');
  const hashHex = Array.from(new Uint8Array(derived)).map(b=>b.toString(16).padStart(2,'0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  // Support both legacy bcrypt hashes and new PBKDF2 hashes
  if (stored.startsWith('pbkdf2:')) {
    const [, saltHex, hashHex] = stored.split(':');
    const enc = new TextEncoder();
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b=>parseInt(b,16)));
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
    );
    const newHex = Array.from(new Uint8Array(derived)).map(b=>b.toString(16).padStart(2,'0')).join('');
    return newHex === hashHex;
  }
  // Plain text fallback (for ADMIN_PASSWORD env var)
  return password === stored;
}

// ── CONSTANTS ─────────────────────────────────────────────────────
const DEFAULT_RATES = {
  'GMD-NGN':  { rate:12.40,   fee:1.5, active:true, label:'Gambian Dalasi → Nigerian Naira' },
  'NGN-GMD':  { rate:0.0806,  fee:1.5, active:true, label:'Nigerian Naira → Gambian Dalasi' },
  'USD-NGN':  { rate:1540.00, fee:1.5, active:true, label:'US Dollar → Nigerian Naira'       },
  'USD-GMD':  { rate:61.50,   fee:1.5, active:true, label:'US Dollar → Gambian Dalasi'       },
  'GMD-USD':  { rate:0.01626, fee:1.5, active:true, label:'Gambian Dalasi → US Dollar'       },
  'GMD-USDC': { rate:0.01620, fee:1.5, active:true, label:'Gambian Dalasi → USDC'            },
  'USDC-GMD': { rate:61.73,   fee:1.5, active:true, label:'USDC → Gambian Dalasi'            },
  'USDC-NGN': { rate:765.00,  fee:1.5, active:true, label:'USDC → Nigerian Naira'            },
};

function generateRef() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = n => Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');
  return `GR-${r(6)}-${r(4)}`;
}

// ── KYC TIERS — based on GMD send amount ─────────────────────────
// Determines what KYC documents are required for a given transfer amount
const KYC_TIERS = [
  {
    tier: 0,
    label: 'Basic',
    color: '#8ab4ff',
    icon: '🔵',
    minGMD: 0,
    maxGMD: 2999,
    description: 'Basic account — small transfers',
    requiredDocs: ['national_id', 'passport'],
    extraRequirements: [],
    dailyLimitGMD: 2999,
    monthlyLimitGMD: 9999,
  },
  {
    tier: 1,
    label: 'Tier 1 — Standard',
    color: '#00D48C',
    icon: '🟢',
    minGMD: 3000,
    maxGMD: 4999,
    description: 'Standard verification for transfers from 3,000 GMD',
    requiredDocs: ['national_id', 'passport', 'resident_permit'],
    extraRequirements: ['selfie_with_id', 'proof_of_address'],
    dailyLimitGMD: 4999,
    monthlyLimitGMD: 49999,
  },
  {
    tier: 2,
    label: 'Tier 2 — Enhanced',
    color: '#F0A033',
    icon: '🟡',
    minGMD: 5000,
    maxGMD: 9999,
    description: 'Enhanced verification for transfers from 5,000 GMD',
    requiredDocs: ['national_id', 'passport', 'resident_permit', 'bank_statement'],
    extraRequirements: ['selfie_with_id', 'proof_of_address', 'source_of_funds'],
    dailyLimitGMD: 9999,
    monthlyLimitGMD: 149999,
  },
  {
    tier: 3,
    label: 'Tier 3 — Advanced',
    color: '#C084FC',
    icon: '🟣',
    minGMD: 10000,
    maxGMD: 14999,
    description: 'Advanced verification for transfers from 10,000 GMD',
    requiredDocs: ['passport', 'bank_statement', 'utility_bill'],
    extraRequirements: ['selfie_with_id', 'proof_of_address', 'source_of_funds', 'employment_proof'],
    dailyLimitGMD: 14999,
    monthlyLimitGMD: 299999,
  },
  {
    tier: 4,
    label: 'Tier 4 — Elite',
    color: '#F0A033',
    icon: '⭐',
    minGMD: 15000,
    maxGMD: Infinity,
    description: 'Elite verification for transfers of 15,000 GMD and above',
    requiredDocs: ['passport', 'bank_statement', 'utility_bill', 'national_id'],
    extraRequirements: ['selfie_with_id', 'proof_of_address', 'source_of_funds', 'employment_proof', 'in_person_or_video_call'],
    dailyLimitGMD: Infinity,
    monthlyLimitGMD: Infinity,
  },
];

// Get KYC tier for a GMD amount
function getKycTier(amountGMD) {
  const amt = parseFloat(amountGMD) || 0;
  return KYC_TIERS.find(t => amt >= t.minGMD && amt <= t.maxGMD) || KYC_TIERS[0];
}

// Get KYC tier by tier number
function getKycTierByLevel(tierLevel) {
  return KYC_TIERS.find(t => t.tier === tierLevel) || KYC_TIERS[0];
}

// Check if a user's approved KYC tier covers the requested amount
function isKycSufficient(userKycTier, requestedAmountGMD) {
  const requiredTier = getKycTier(requestedAmountGMD);
  return (userKycTier || 0) >= requiredTier.tier;
}

function getTier(amount, from, to) {
  const tiers = [
    { min:0,     max:4999,    fee:2.0, label:'Standard' },
    { min:5000,  max:19999,   fee:1.5, label:'Silver'   },
    { min:20000, max:49999,   fee:1.2, label:'Gold'     },
    { min:50000, max:Infinity,fee:0.8, label:'Platinum' },
  ];
  if (from==='GMD' || to==='GMD')
    return tiers.find(t=>amount>=t.min&&amount<=t.max)||tiers[0];
  return { fee:1.5, label:'Standard' };
}

// ── D1 HELPERS ───────────────────────────────────────────────────
async function d1Run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}
async function d1First(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}
async function d1All(env, sql, ...args) {
  const res = await env.DB.prepare(sql).bind(...args).all();
  return res.results || [];
}

// ── ARC NAME RESOLUTION (shared by payroll, payment requests, etc.) ─
// Accepts either a raw 0x address or a "name.arc" / bare "name" handle
// and always resolves to a real 0x address (or null if unknown/invalid).
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
async function resolveWalletInput(input, env) {
  const raw = String(input || '').trim();
  if (!raw) return { address: null, error: 'Wallet address or .arc name is required' };
  if (ADDR_RE.test(raw)) return { address: raw, error: null };

  const name = raw.toLowerCase().replace(/\.arc$/, '');
  if (!env?.DB) return { address: null, error: `Could not resolve ${raw}` };
  const row = await d1First(env, 'SELECT data FROM arc_names WHERE name = ?', name);
  if (!row) return { address: null, error: `${name}.arc is not a registered name` };
  const record = JSON.parse(row.data);
  if (!record.walletAddress || !ADDR_RE.test(record.walletAddress)) {
    return { address: null, error: `${name}.arc has no valid wallet address on file` };
  }
  return { address: record.walletAddress, error: null };
}

// ── USER HELPERS ──────────────────────────────────────────────────
async function getUser(email, env) {
  const row = await d1First(env, 'SELECT data FROM users WHERE email = ?', email.toLowerCase().trim());
  return row ? JSON.parse(row.data) : null;
}
async function getAllUsers(env) {
  const rows = await d1All(env, 'SELECT data FROM users');
  return rows.map(r => JSON.parse(r.data));
}
async function saveUser(user, env) {
  const email = user.email.toLowerCase().trim();
  await d1Run(env,
    `INSERT INTO users (email, id, circle_wallet_id, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET id = excluded.id, circle_wallet_id = excluded.circle_wallet_id, data = excluded.data`,
    email, user.id, user.circleWalletId || null, JSON.stringify(user)
  );
  if (user.circleWalletId) {
    await d1Run(env,
      `INSERT INTO wallet_map (wallet_id, email) VALUES (?, ?)
       ON CONFLICT(wallet_id) DO UPDATE SET email = excluded.email`,
      user.circleWalletId, email
    );
  }
}
async function getUserByWalletId(walletId, env) {
  const row = await d1First(env, 'SELECT email FROM wallet_map WHERE wallet_id = ?', walletId);
  return row ? getUser(row.email, env) : null;
}

// ── TX HELPERS ────────────────────────────────────────────────────
async function getTx(ref, env) {
  const row = await d1First(env, 'SELECT data FROM transactions WHERE reference = ?', ref.toUpperCase());
  return row ? JSON.parse(row.data) : null;
}
async function getTxByCircleTxId(circleTxId, env) {
  if (!circleTxId) return null;
  const row = await d1First(
    env,
    `SELECT data FROM transactions WHERE json_extract(data, '$.circleTxId') = ? OR json_extract(data, '$.circleTransactionId') = ? LIMIT 1`,
    circleTxId, circleTxId
  );
  return row ? JSON.parse(row.data) : null;
}
async function getAllTxs(env) {
  const rows = await d1All(env, 'SELECT data FROM transactions ORDER BY created_at DESC');
  return rows.map(r => JSON.parse(r.data));
}
async function saveTx(tx, env) {
  const ref = tx.reference.toUpperCase();
  await d1Run(env,
    `INSERT INTO transactions (reference, user_id, created_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(reference) DO UPDATE SET user_id = excluded.user_id, data = excluded.data`,
    ref, tx.userId || null, tx.createdAt || new Date().toISOString(), JSON.stringify(tx)
  );
}

// ── RATES ─────────────────────────────────────────────────────────
async function getRates(env) {
  const row = await d1First(env, 'SELECT data FROM rates WHERE id = 1');
  return row ? JSON.parse(row.data) : { ...DEFAULT_RATES, updatedAt:new Date().toISOString(), updatedBy:'system' };
}
async function saveRates(r, env) {
  await d1Run(env,
    `INSERT INTO rates (id, data) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    JSON.stringify(r)
  );
}

// ── NOTIFS ────────────────────────────────────────────────────────
async function getNotifs(userId, env) {
  const rows = await d1All(env,
    'SELECT data FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
  return rows.map(r => JSON.parse(r.data));
}
async function addNotif(userId, {type='info',title,body,link=''}, env) {
  const notifId = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const createdAt = new Date().toISOString();
  const entry = { id: notifId, type, title, body, link, read: false, createdAt };
  await d1Run(env,
    'INSERT INTO notifications (user_id, notif_id, created_at, data) VALUES (?, ?, ?, ?)',
    userId, notifId, createdAt, JSON.stringify(entry)
  );
  // Trim to the most recent 50 per user so this table doesn't grow unbounded
  await d1Run(env, `
    DELETE FROM notifications WHERE user_id = ? AND notif_id NOT IN (
      SELECT notif_id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    )`, userId, userId
  );
}
async function pushAdminNotif({type,title,body,link},env) {
  // NOTE: admin is NOT a row in the `users` table — auth/login.js
  // authenticates the admin purely against env.ADMIN_PASSWORD and always
  // issues a JWT with the fixed id 'admin-001' (same id auth/me.js reads
  // notifications for). Filtering getAllUsers() for role==='admin' here
  // always matched zero rows, so this silently notified no one. Write
  // directly to the one real admin id instead.
  await addNotif('admin-001', {type,title,body,link}, env);
}

// ── KYC ──────────────────────────────────────────────────────────
async function getKyc(userId, env) {
  const row = await d1First(env, 'SELECT data FROM kyc WHERE user_id = ?', userId);
  return row ? JSON.parse(row.data) : null;
}
async function saveKyc(userId, data, env) {
  await d1Run(env,
    `INSERT INTO kyc (user_id, data) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data`,
    userId, JSON.stringify(data)
  );
}
async function getAllKyc(env) {
  const rows = await d1All(env, 'SELECT data FROM kyc');
  return rows.map(r => JSON.parse(r.data));
}

// ── TELEGRAM ──────────────────────────────────────────────────────
async function sendTelegram(msg, env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  const chatId = env?.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — message not sent');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId, text:msg, parse_mode:'Markdown'})
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[telegram] Telegram API rejected message', res.status, body);
    }
  } catch (e) { console.error('[telegram]', e.message); }
}

// Strips tags/entities down to a readable plain-text fallback. Providing
// a TextPart alongside HTMLPart is a small but real deliverability signal —
// mail with an HTML-only body (no plain-text alternative) scores worse on
// several spam filters than mail that includes both.
function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── EMAIL (Brevo) ─────────────────────────────────────────────────
async function sendEmail({to,subject,html},env) {
  const apiKey = env?.BREVO_API_KEY;
  const fromEmail = env?.EMAIL_FROM || 'noreply@gamremit.com';
  const fromName = env?.EMAIL_FROM_NAME || 'GamRemit';
  if (!apiKey) { console.error('[email] BREVO_API_KEY missing — email not sent'); return; }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email',{
      method:'POST',
      headers:{'api-key':apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({
        sender:{name:fromName,email:fromEmail},
        to:[{email:to}],subject,htmlContent:html,textContent:htmlToPlainText(html)
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Brevo rejected send', res.status, body);
    }
  } catch(e) { console.error('[email]',e.message); }
}

// KYC-specific emails run through Mailjet instead of Brevo — deliberately a
// separate provider/pool so a busy KYC day can never eat into the Brevo
// quota that OTP sign-in codes depend on. Same call signature as sendEmail()
// on purpose, so call sites just swap which function they call.
async function sendEmailKYC({to,subject,html},env) {
  const apiKey    = env?.MAILJET_API_KEY;
  const apiSecret = env?.MAILJET_API_SECRET;
  const fromEmail = env?.EMAIL_FROM || 'noreply@gamremit.com';
  const fromName  = env?.EMAIL_FROM_NAME || 'GamRemit';
  if (!apiKey || !apiSecret) { console.error('[email:kyc] MAILJET_API_KEY/MAILJET_API_SECRET missing — email not sent'); return; }
  try {
    const res = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${apiKey}:${apiSecret}`),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [{
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: to }],
          Subject: subject,
          HTMLPart: html,
          TextPart: htmlToPlainText(html),
        }],
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('[email:kyc] Mailjet rejected send', res.status, body);
    } else {
      console.log('[email:kyc] Mailjet accepted send', res.status, 'to:', to, body);
    }
  } catch (e) { console.error('[email:kyc]', e.message); }
}


// ════════════════════════════════════════════════════════════════
// COMPLIANCE & RISK MODULE — _db.js additions
// ════════════════════════════════════════════════════════════════

// ── Valid account statuses ────────────────────────────────────────
const ACCOUNT_STATUSES = {
  active:               { label: 'Active',               color: '#00D48C', canLogin: true,  canTransact: true  },
  pending:              { label: 'Pending Verification',  color: '#F0A033', canLogin: true,  canTransact: false },
  under_review:         { label: 'Under Review',          color: '#8ab4ff', canLogin: true,  canTransact: true  },
  frozen:               { label: 'Frozen',                color: '#FF9F43', canLogin: true,  canTransact: false },
  suspended:            { label: 'Suspended',             color: '#FF4D6A', canLogin: false, canTransact: false },
  closed:               { label: 'Closed',                color: '#666',    canLogin: false, canTransact: false },
};

// ── Audit Log — immutable append-only (Cloudflare D1) ──────────────
function auditId() {
  // 13-digit ms timestamp, zero-padded to 15 to be safe past year 2286,
  // so string comparison sorts the same as numeric comparison.
  return `${Date.now()}`.padStart(15, '0') + '-' + Math.random().toString(36).slice(2, 8);
}

async function appendAuditLog(entry, env) {
  if (!env?.DB) return null;
  const id  = auditId();
  const log = {
    id,
    userId:         entry.userId,
    userEmail:      entry.userEmail || null,
    actionType:     entry.actionType,
    previousStatus: entry.previousStatus || null,
    newStatus:      entry.newStatus      || null,
    reason:         entry.reason         || null,
    adminId:        entry.adminId,
    adminEmail:     entry.adminEmail     || null,
    ipAddress:      entry.ipAddress      || null,
    metadata:       entry.metadata       || {},
    timestamp:      new Date().toISOString(),
  };
  await d1Run(env,
    'INSERT INTO audit_logs (id, user_id, created_at, data) VALUES (?, ?, ?, ?)',
    id, entry.userId || null, log.timestamp, JSON.stringify(log)
  );
  return log;
}

async function getAuditLogsForUser(userId, env, limit = 50) {
  if (!env?.DB) return [];
  try {
    const rows = await d1All(env,
      'SELECT data FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      userId, limit
    );
    return rows.map(r => JSON.parse(r.data));
  } catch { return []; }
}

async function getAllAuditLogs(env, limit = 200, cursor = undefined) {
  if (!env?.DB) return { logs: [], cursor: null };
  try {
    const offset = parseInt(cursor, 10) || 0;
    // Fetch one extra row to know whether there's a next page
    const rows = await d1All(env,
      'SELECT data FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      limit + 1, offset
    );
    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map(r => JSON.parse(r.data));
    return { logs, cursor: hasMore ? String(offset + limit) : null };
  } catch { return { logs: [], cursor: null }; }
}

// ── Compliance Notes ──────────────────────────────────────────────
async function getComplianceNotes(userId, env) {
  const rows = await d1All(env,
    'SELECT data FROM compliance_notes WHERE user_id = ? ORDER BY note_id DESC', userId);
  return rows.map(r => JSON.parse(r.data));
}

async function addComplianceNote(userId, note, env) {
  const entry = {
    id:        `note-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    content:   note.content,
    adminId:   note.adminId,
    adminEmail:note.adminEmail || null,
    adminName: note.adminName  || 'Admin',
    createdAt: new Date().toISOString(),
    edited:    false,
    editedAt:  null,
  };
  await d1Run(env,
    'INSERT INTO compliance_notes (user_id, note_id, data) VALUES (?, ?, ?)',
    userId, entry.id, JSON.stringify(entry)
  );
  return entry;
}

async function editComplianceNote(userId, noteId, newContent, adminEmail, env) {
  const row = await d1First(env,
    'SELECT data FROM compliance_notes WHERE user_id = ? AND note_id = ?', userId, noteId);
  if (!row) return null;
  const updated = JSON.parse(row.data);
  updated.content  = newContent;
  updated.edited   = true;
  updated.editedAt = new Date().toISOString();
  updated.editedBy = adminEmail;
  await d1Run(env,
    'UPDATE compliance_notes SET data = ? WHERE user_id = ? AND note_id = ?',
    JSON.stringify(updated), userId, noteId
  );
  return updated;
}

// ── Risk Score ────────────────────────────────────────────────────
async function calculateRiskScore(user, txs, env) {
  let score = 0;
  const signals = [];

  const userTxs = txs.filter(t => t.userId === user.id || t.userEmail === user.email);
  const now = Date.now();
  const day = 86400000;

  // Signal: KYC not completed
  if (user.kycStatus !== 'approved') { score += 10; signals.push({ code: 'kyc_pending', label: 'KYC not approved', weight: 10 }); }

  // Signal: New account (<7 days) sending large amount
  const ageMs = now - new Date(user.createdAt).getTime();
  if (ageMs < 7 * day) { score += 15; signals.push({ code: 'new_account', label: 'Account < 7 days old', weight: 15 }); }

  // Signal: Large transaction spikes (>500 GMD in a day for new user)
  const todayTxs = userTxs.filter(t => now - new Date(t.createdAt).getTime() < day);
  const todayVol = todayTxs.reduce((s, t) => s + (parseFloat(t.sendAmount) || 0), 0);
  if (todayVol > 10000) { score += 25; signals.push({ code: 'large_daily_vol', label: `High daily volume: ${todayVol.toFixed(0)} GMD`, weight: 25 }); }
  else if (todayVol > 5000) { score += 12; signals.push({ code: 'elevated_daily_vol', label: `Elevated daily volume: ${todayVol.toFixed(0)} GMD`, weight: 12 }); }

  // Signal: Excessive transaction frequency (>5 in 24h)
  if (todayTxs.length > 10) { score += 20; signals.push({ code: 'high_freq', label: `${todayTxs.length} transactions today`, weight: 20 }); }
  else if (todayTxs.length > 5) { score += 10; signals.push({ code: 'medium_freq', label: `${todayTxs.length} transactions today`, weight: 10 }); }

  // Signal: Account under review or previously frozen
  if (user.status === 'under_review') { score += 20; signals.push({ code: 'under_review', label: 'Currently under review', weight: 20 }); }
  if (user.complianceHistory?.wasFrozen) { score += 15; signals.push({ code: 'was_frozen', label: 'Previously frozen', weight: 15 }); }

  // Signal: KYC mismatch
  if (user.kycMismatch) { score += 30; signals.push({ code: 'kyc_mismatch', label: 'KYC data mismatch detected', weight: 30 }); }

  // Signal: Multiple failed logins
  if ((user.failedLogins || 0) > 5) { score += 15; signals.push({ code: 'failed_logins', label: `${user.failedLogins} failed login attempts`, weight: 15 }); }

  score = Math.min(100, score);
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  return { score, level, signals };
}

// ── Withdrawal-specific fraud signals ──────────────────────────────
// Builds on calculateRiskScore (account-level signals) and adds signals
// specific to the withdrawal being attempted right now. Returns the same
// {score, level, signals} shape so it's easy to display/log consistently.
async function assessWithdrawalRisk(user, amountUsdc, currency, env) {
  const txs = await getAllTxs(env);
  const base = await calculateRiskScore(user, txs, env);
  let score = base.score;
  const signals = [...base.signals];

  const now = Date.now();
  const day = 86400000;
  const myWithdrawals = txs.filter(t =>
    (t.userId === user.id || t.userEmail === user.email) && t.type === 'withdrawal'
  );
  const isFirstWithdrawal = myWithdrawals.length === 0;

  // Signal: velocity — multiple withdrawals in the last 24h
  const recentWithdrawals = myWithdrawals.filter(t => now - new Date(t.createdAt).getTime() < day);
  if (recentWithdrawals.length >= 3) {
    score += 25; signals.push({ code: 'withdrawal_velocity', label: `${recentWithdrawals.length} withdrawals in 24h`, weight: 25 });
  } else if (recentWithdrawals.length >= 1) {
    score += 8; signals.push({ code: 'repeat_withdrawal', label: `${recentWithdrawals.length} prior withdrawal(s) today`, weight: 8 });
  }

  // Signal: first-ever withdrawal is unusually large
  if (isFirstWithdrawal && amountUsdc >= 500) {
    score += 20; signals.push({ code: 'first_withdrawal_large', label: `First withdrawal is ${amountUsdc} USDC`, weight: 20 });
  }

  // Signal: this withdrawal is a big jump above the user's own history
  if (myWithdrawals.length > 0) {
    const avgPast = myWithdrawals.reduce((s, t) => s + (parseFloat(t.sendAmount) || 0), 0) / myWithdrawals.length;
    if (avgPast > 0 && amountUsdc > avgPast * 4) {
      score += 18; signals.push({ code: 'withdrawal_spike', label: `${amountUsdc} USDC vs avg ${avgPast.toFixed(0)} USDC`, weight: 18 });
    }
  }

  // Signal: large absolute amount regardless of history
  if (amountUsdc >= 2000) {
    score += 15; signals.push({ code: 'large_withdrawal', label: `Large withdrawal: ${amountUsdc} USDC`, weight: 15 });
  }

  // Signal: account created and withdrawing same day
  const accountAgeMs = now - new Date(user.createdAt).getTime();
  if (accountAgeMs < day) {
    score += 22; signals.push({ code: 'same_day_withdrawal', label: 'Account created and withdrawing same day', weight: 22 });
  }

  score = Math.min(100, score);
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  return { score, level, signals };
}

// Auto-flags an account to 'under_review' from a fraud-detection signal,
// not an admin click. Never downgrades a stronger restriction (frozen/
// suspended/closed) — those stay as the admin set them. Always audit-
// logged with adminId 'system-auto-fraud' so it's clearly distinguishable
// from a human decision in the audit trail, and always notifies admins.
async function autoFlagForReview(user, reason, signals, env) {
  if (['frozen', 'suspended', 'closed', 'under_review'].includes(user.status)) {
    return false; // already restricted or already flagged — don't overwrite
  }
  const previousStatus = user.status;
  user.status = 'under_review';
  await saveUser(user, env);

  await appendAuditLog({
    userId: user.id, userEmail: user.email,
    actionType: 'AUTO_FLAG',
    previousStatus, newStatus: 'under_review',
    reason,
    adminId: 'system-auto-fraud', adminEmail: 'system-auto-fraud',
    metadata: { signals },
  }, env);

  await pushAdminNotif({
    type: 'alert',
    title: '🚩 Account auto-flagged for review',
    body: `${user.email} was automatically flagged: ${reason}`,
    link: `/admin.html?user=${user.id}`,
  }, env);

  sendTelegram(
    `🚩 *Auto-flagged for review*\n👤 ${user.email}\n📋 ${reason}\n🔎 Signals: ${signals.map(s => s.label).join(', ')}`,
    env
  ).catch(() => {});

  return true;
}

export {
  getUser, getAllUsers, saveUser, getUserByWalletId,
  getTx, getTxByCircleTxId, getAllTxs, saveTx,
  getRates, saveRates,
  getNotifs, addNotif, pushAdminNotif,
  getKyc, saveKyc, getAllKyc,
  hashPassword, verifyPassword,
  generateRef, getTier, DEFAULT_RATES,
  sendTelegram, sendEmail, sendEmailKYC, isDeployed,
  KYC_TIERS, getKycTier, getKycTierByLevel, isKycSufficient,
  ACCOUNT_STATUSES,
  appendAuditLog, getAuditLogsForUser, getAllAuditLogs,
  getComplianceNotes, addComplianceNote, editComplianceNote,
  calculateRiskScore, assessWithdrawalRisk, autoFlagForReview,
  resolveWalletInput
};
