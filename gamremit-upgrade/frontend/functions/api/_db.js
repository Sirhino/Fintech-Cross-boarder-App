// functions/api/_db.js — Upstash Redis via REST API (Cloudflare compatible)
// No Node.js required — uses fetch() which Cloudflare supports natively

const mem = { users:{}, txs:{}, rates:null, notifs:{}, kyc:{} };

function isDeployed(env) {
  return !!(env && env.UPSTASH_REDIS_REST_URL);
}

async function kvGet(key, env) {
  if (!isDeployed(env)) return mem[key] || null;
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    if (data.result === null || data.result === undefined) return null;
    try { const p = JSON.parse(data.result); return typeof p === 'string' ? JSON.parse(p) : p; } catch { return data.result; }
  } catch(e) { console.error('[kv:get]', key, e.message); return null; }
}

async function kvSet(key, value, env) {
  if (!isDeployed(env)) { mem[key] = value; return; }
  try {
    await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch(e) { console.error('[kv:set]', key, e.message); }
}

async function kvKeys(pattern, env) {
  if (!isDeployed(env)) {
    const prefix = pattern.replace('*','');
    return Object.keys(mem).filter(k => k.startsWith(prefix));
  }
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    return data.result || [];
  } catch(e) { console.error('[kv:keys]', e.message); return []; }
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

// ── USER HELPERS ──────────────────────────────────────────────────
async function getUser(email, env) {
  return await kvGet(`user:${email.toLowerCase().trim()}`, env);
}
async function getAllUsers(env) {
  const keys = await kvKeys('user:*', env);
  if (!keys.length) return [];
  return (await Promise.all(keys.map(k=>kvGet(k,env)))).filter(Boolean);
}
async function saveUser(user, env) {
  await kvSet(`user:${user.email.toLowerCase().trim()}`, user, env);
}

// ── TX HELPERS ────────────────────────────────────────────────────
async function getTx(ref, env) { return await kvGet(`tx:${ref.toUpperCase()}`,env); }
async function getAllTxs(env) {
  const keys = await kvKeys('tx:*',env);
  if (!keys.length) return [];
  return (await Promise.all(keys.map(k=>kvGet(k,env)))).filter(Boolean);
}
async function saveTx(tx, env) { await kvSet(`tx:${tx.reference.toUpperCase()}`,tx,env); }

// ── RATES ─────────────────────────────────────────────────────────
async function getRates(env) {
  const saved = await kvGet('gr:rates',env);
  return saved || { ...DEFAULT_RATES, updatedAt:new Date().toISOString(), updatedBy:'system' };
}
async function saveRates(r,env) { await kvSet('gr:rates',r,env); }

// ── NOTIFS ────────────────────────────────────────────────────────
async function getNotifs(userId,env) { return (await kvGet(`notif:${userId}`,env)) || []; }
async function addNotif(userId,{type='info',title,body,link=''},env) {
  const existing = await getNotifs(userId,env);
  const updated = [{
    id:`${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type,title,body,link,read:false,
    createdAt:new Date().toISOString()
  },...existing].slice(0,50);
  await kvSet(`notif:${userId}`,updated,env);
}
async function pushAdminNotif({type,title,body,link},env) {
  const users = await getAllUsers(env);
  await Promise.all(
    users.filter(u=>u.role==='admin').map(a=>addNotif(a.id,{type,title,body,link},env))
  );
}

// ── KYC ──────────────────────────────────────────────────────────
async function getKyc(userId,env) { return await kvGet(`kyc:${userId}`,env); }
async function saveKyc(userId,data,env) { await kvSet(`kyc:${userId}`,data,env); }
async function getAllKyc(env) {
  const keys = await kvKeys('kyc:*',env);
  if (!keys.length) return [];
  return (await Promise.all(keys.map(k=>kvGet(k,env)))).filter(Boolean);
}

// ── TELEGRAM ──────────────────────────────────────────────────────
async function sendTelegram(msg, env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  const chatId = env?.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId, text:msg, parse_mode:'Markdown'})
    });
  } catch {}
}

// ── EMAIL (Brevo) ─────────────────────────────────────────────────
async function sendEmail({to,subject,html},env) {
  const apiKey = env?.BREVO_API_KEY;
  const fromEmail = env?.EMAIL_FROM || 'noreply@gamremit.com';
  const fromName = env?.EMAIL_FROM_NAME || 'GamRemit';
  if (!apiKey) return;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email',{
      method:'POST',
      headers:{'api-key':apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({
        sender:{name:fromName,email:fromEmail},
        to:[{email:to}],subject,htmlContent:html
      })
    });
  } catch(e) { console.error('[email]',e.message); }
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

// ── Audit Log — immutable append-only ────────────────────────────
async function appendAuditLog(entry, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return null;
  const id  = `audit-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
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
  // Store individual log entry (never overwritten)
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(`auditlog:${id}`)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(log))
  });
  // Also push to user-specific list
  await kvListPush(`audits:user:${entry.userId}`, id, env);
  // Push to global list
  await kvListPush('audits:global', id, env);
  return log;
}

async function kvListPush(listKey, value, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${env.UPSTASH_REDIS_REST_URL}/lpush/${encodeURIComponent(listKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  } catch {}
}

async function getAuditLogsForUser(userId, env, limit = 50) {
  if (!env?.UPSTASH_REDIS_REST_URL) return [];
  try {
    const idsRes = await fetch(
      `${env.UPSTASH_REDIS_REST_URL}/lrange/${encodeURIComponent(`audits:user:${userId}`)}/0/${limit - 1}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
    const idsData = await idsRes.json();
    const ids = idsData.result || [];
    const logs = await Promise.all(
      ids.map(async id => {
        const r = await fetch(
          `${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(`auditlog:${id}`)}`,
          { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
        );
        const d = await r.json();
        return d.result ? (typeof JSON.parse(d.result) === 'string' ? JSON.parse(JSON.parse(d.result)) : JSON.parse(d.result)) : null;
      })
    );
    return logs.filter(Boolean);
  } catch { return []; }
}

async function getAllAuditLogs(env, limit = 200) {
  if (!env?.UPSTASH_REDIS_REST_URL) return [];
  try {
    const idsRes = await fetch(
      `${env.UPSTASH_REDIS_REST_URL}/lrange/${encodeURIComponent('audits:global')}/0/${limit - 1}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
    const idsData = await idsRes.json();
    const ids = idsData.result || [];
    const logs = await Promise.all(
      ids.map(async id => {
        const r = await fetch(
          `${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(`auditlog:${id}`)}`,
          { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } }
        );
        const d = await r.json();
        return d.result ? (typeof JSON.parse(d.result) === 'string' ? JSON.parse(JSON.parse(d.result)) : JSON.parse(d.result)) : null;
      })
    );
    return logs.filter(Boolean);
  } catch { return []; }
}

// ── Compliance Notes ──────────────────────────────────────────────
async function getComplianceNotes(userId, env) {
  return (await kvGet(`compliance:notes:${userId}`, env)) || [];
}

async function addComplianceNote(userId, note, env) {
  const notes = await getComplianceNotes(userId, env);
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
  notes.unshift(entry);
  await kvSet(`compliance:notes:${userId}`, notes, env);
  return entry;
}

async function editComplianceNote(userId, noteId, newContent, adminEmail, env) {
  const notes = await getComplianceNotes(userId, env);
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx === -1) return null;
  notes[idx].content  = newContent;
  notes[idx].edited   = true;
  notes[idx].editedAt = new Date().toISOString();
  notes[idx].editedBy = adminEmail;
  await kvSet(`compliance:notes:${userId}`, notes, env);
  return notes[idx];
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

export {
  getUser, getAllUsers, saveUser,
  getTx, getAllTxs, saveTx,
  getRates, saveRates,
  getNotifs, addNotif, pushAdminNotif,
  getKyc, saveKyc, getAllKyc,
  hashPassword, verifyPassword,
  generateRef, getTier, DEFAULT_RATES,
  sendTelegram, sendEmail, isDeployed,
  KYC_TIERS, getKycTier, getKycTierByLevel, isKycSufficient,
  ACCOUNT_STATUSES,
  appendAuditLog, getAuditLogsForUser, getAllAuditLogs,
  getComplianceNotes, addComplianceNote, editComplianceNote,
  calculateRiskScore
};
