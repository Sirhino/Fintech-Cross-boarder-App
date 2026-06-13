# GamRemit Upgrade — Deployment Checklist

## Overview of What Changed

| File | Status | Description |
|------|--------|-------------|
| `frontend/index.html` | **REPLACED** | Email OTP login (no more passwords) |
| `frontend/app.html` | **UPGRADED** | 4 new panels + AI chat bubble injected |
| `frontend/pay.html` | **NEW** | Public payment request pay page |
| `frontend/_redirects` | **UPDATED** | Added `/pay/*` route |
| `frontend/functions/api/auth/otp-send.js` | **NEW** | Sends 6-digit OTP via Brevo |
| `frontend/functions/api/auth/otp-verify.js` | **NEW** | Verifies OTP, creates Circle wallet, issues JWT |
| `frontend/functions/api/pay/requests.js` | **NEW** | Payment Requests CRUD |
| `frontend/functions/api/pay/payroll.js` | **NEW** | Bulk USDC payroll |
| `frontend/functions/api/bridge/transfer.js` | **NEW** | CCTP V2 bridge UI + history |
| `frontend/functions/api/arc-names/index.js` | **NEW** | .arc name registration |
| `frontend/functions/api/ai/chat.js` | **NEW** | GamBot AI via Groq |
| `.env.example` | **UPDATED** | All old + new variables documented |

All existing files (kyc.html, admin.html, all original API functions, wrangler.toml, worker.js, logos) are **preserved unchanged**.

---

## Step 1 — Add New Environment Variables in Cloudflare Pages

Go to: **Cloudflare Dashboard → Pages → gamremit → Settings → Environment Variables**

Add these NEW variables alongside your existing ones:

### Required for OTP Login (Feature 1)
| Variable | Where to get it |
|----------|----------------|
| `CIRCLE_APP_ID` | [console.circle.com](https://console.circle.com) → User-Controlled Wallets → App ID |
| `CIRCLE_USER_API_KEY` | [console.circle.com](https://console.circle.com) → User-Controlled Wallets → API Keys |
| `CIRCLE_ENTITY_SECRET` | `openssl rand -hex 32` → register at Circle Console → Entity Secret |

> **Note:** `BREVO_API_KEY`, `JWT_SECRET`, and `UPSTASH_REDIS_REST_URL/TOKEN` are already in your dashboard from the original setup. OTP emails use Brevo (same key). OTP codes use Upstash Redis (same connection). No extra cost.

### Required for AI Assistant (Feature 5)
| Variable | Where to get it |
|----------|----------------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API Keys → Create API Key (free) |

### All Other New Features (Features 2, 3, 4, 6, 7)
No additional env vars needed — they use Upstash Redis (already set) and Arc Testnet (public RPC).

---

## Step 2 — Get Each New API Key

### Circle User-Controlled Wallets (OTP Login)
1. Go to [console.circle.com](https://console.circle.com)
2. Select **Testnet** environment
3. Navigate to **User-Controlled Wallets**
4. Create an **App** → copy the **App ID** → set as `CIRCLE_APP_ID`
5. Under **API Keys** → create a key → set as `CIRCLE_USER_API_KEY`
6. Under **Entity Secret** → run `openssl rand -hex 32` → paste and register → save as `CIRCLE_ENTITY_SECRET`

### Groq API (AI Assistant)
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up (free) → **API Keys** → **Create API Key**
3. Copy key → set as `GROQ_API_KEY`
4. Free tier: 14,400 req/day on `llama3-8b-8192` — plenty for GamBot

### .arc Name Registry
The `.arc` name feature uses Upstash Redis as the registry (no separate contract needed for testnet). For mainnet production, you would deploy the ARC Name Registry contract and update `ARC_REGISTRY` in `arc-names/index.js`.

---

## Step 3 — Test Locally Before Deploying

```bash
# 1. Copy env file
cp .env.example .dev.vars
# Edit .dev.vars and fill in real values for: JWT_SECRET, UPSTASH_*, GROQ_API_KEY

# 2. Run local dev server (one command)
npx wrangler pages dev frontend --port 8787

# 3. Open in browser
open http://localhost:8787

# 4. Test checklist:
# ✅ Visit http://localhost:8787 → OTP login screen shows (no password field)
# ✅ Enter email → receive 6-digit OTP in email
# ✅ Enter OTP → redirect to /kyc.html
# ✅ In app: sidebar shows Payment Requests, Payroll, Bridge, .arc Names
# ✅ AI chat bubble appears bottom-right → ask "What corridors do you support?"
# ✅ Payment Request: create → copy link → open in incognito → pay
# ✅ Payroll: add 2 rows → execute → CSV downloads automatically
# ✅ Bridge: select Arc → Sepolia → enter amount → initiate
# ✅ .arc Names: search "testname" → check → register
```

---

## Step 4 — Deploy to gamremit.pages.dev (Zero Downtime)

```bash
# Option A — Cloudflare Pages Git integration (recommended)
# 1. Push this upgraded folder to your GitHub repo
git add -A
git commit -m "feat: add 7 new features (OTP, PayReq, Payroll, Swap, AI, Bridge, ArcNames)"
git push origin main
# Cloudflare Pages auto-deploys on push → ~60 second build time
# Your existing gamremit.pages.dev stays live during build

# Option B — Direct upload via Wrangler (no git required)
npx wrangler pages deploy frontend --project-name gamremit
# This uploads the frontend/ directory directly to Cloudflare Pages
# Zero downtime — Cloudflare atomically switches to new deployment
```

---

## Step 5 — Post-Deployment Verification

After deploy, check these on **gamremit.pages.dev**:

| Check | URL | Expected |
|-------|-----|----------|
| OTP Login page | `/` | No password field, "Send Sign-In Code" button |
| Registration | `/#register` | Profile fields + OTP verify step |
| App sidebar | `/app.html` | 4 new nav items visible |
| AI chat | `/app.html` | 🤖 bubble bottom-right |
| Payment Requests | `/app.html` → Payment Requests | Create + share link works |
| Payroll | `/app.html` → Payroll | Add rows, execute, CSV downloads |
| Bridge | `/app.html` → Bridge | Chain selector, preview, initiate |
| .arc Names | `/app.html` → .arc Names | Search + register |
| Pay page | `/pay/TESTCODE` | Public pay form loads |
| AI response | Chat bubble | GamBot responds in <3s |

---

## Backward Compatibility Notes

- **Existing password users**: The old `/api/auth/login` endpoint is still present and unchanged. Existing users who registered with a password can still log in via the old endpoint if you need it. The new OTP flow is the **only flow shown on the UI** — but the backend endpoint exists for migration.
- **Existing transfers and KYC**: Completely unchanged — all `/api/transactions`, `/api/kyc`, `/api/rates` endpoints preserved.
- **Admin panel**: Unchanged — admin.html still works as before.
- **All existing env vars**: No existing variables were removed — only new ones added.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| OTP email not arriving | Check `BREVO_API_KEY` is set; check Brevo logs at app.brevo.com |
| AI chat returns "service not configured" | `GROQ_API_KEY` not set in CF Pages env vars |
| OTP "Code expired" immediately | Check Upstash Redis connection — `UPSTASH_REDIS_REST_URL` and `TOKEN` |
| Bridge initiate fails | Check `JWT_SECRET` matches — user must be logged in |
| .arc name search 404 | Ensure `frontend/functions/api/arc-names/index.js` is present |
| Pay page shows "Not found" | Check `_redirects` has `/pay/* /pay.html 200` |
| New nav items missing in sidebar | Hard-refresh browser (Ctrl+Shift+R) to clear cached app.html |
