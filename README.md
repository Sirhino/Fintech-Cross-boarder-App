# GamRemit API — Cloudflare Worker

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | None | Register new user |
| POST | /api/auth/login | None | Login, returns JWT |
| GET | /api/auth/me | User | Get current user + notifications |
| PATCH | /api/auth/me | User | Update profile |
| GET | /api/admin/users | Admin | List all users + stats |
| PATCH | /api/admin/users/:id | Admin | Approve/block user |
| GET | /api/transactions | User/Admin | Get transactions |
| POST | /api/transactions | User | Submit new transfer |
| PATCH | /api/transactions/:ref | User/Admin | Update status |
| GET | /api/rates | None | Get exchange rates |
| POST | /api/rates | Admin | Update rate/fee |
| GET | /api/kyc | Admin | List all KYC submissions |
| POST | /api/kyc | User | Submit KYC documents |
| PATCH | /api/kyc/:id | Admin | Approve/reject KYC |
| GET | /api/notifications | User | Get notifications |
| PATCH | /api/notifications/read | User | Mark all as read |
| GET | /api/debug | None | Check env + counts |

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

---

## Step 2 — Set Secrets in Cloudflare

Run these one by one:

```bash
wrangler secret put UPSTASH_REDIS_REST_URL
# paste: https://loving-gnu-104251.upstash.io

wrangler secret put UPSTASH_REDIS_REST_TOKEN
# paste: your token from Upstash dashboard

wrangler secret put JWT_SECRET
# paste: gr-secret-xK92mPQb-2026!

wrangler secret put ADMIN_PASSWORD
# paste: t@Admin2025!
```

---

## Step 3 — Deploy

```bash
wrangler deploy
```

You'll get a URL like:
```
https://gamremit-api.YOUR-SUBDOMAIN.workers.dev
```

---

## Step 4 — Connect to your Frontend

In your `admin.html`, update line 450–453:

```js
const API = location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://gamremit-api.YOUR-SUBDOMAIN.workers.dev';
```

OR use the banner at the bottom of admin.html to paste your Worker URL.

---

## Step 5 — Test it works

Open your browser and visit:
```
https://gamremit-api.YOUR-SUBDOMAIN.workers.dev/api/debug
```

You should see:
```json
{
  "env": {
    "UPSTASH_REDIS_REST_URL": "✅ set",
    "UPSTASH_REDIS_REST_TOKEN": "✅ set",
    "JWT_SECRET": "✅ set",
    "ADMIN_PASSWORD": "✅ set"
  }
}
```

---

## Admin Login

Email: `admin@.com`  
Password: whatever you set as `ADMIN_PASSWORD`

The admin account is auto-created on first request.

---

## Local Development

```bash
cp .dev.vars.example .dev.vars
# fill in your real values in .dev.vars

wrangler dev
# Worker runs at http://localhost:8787
```
