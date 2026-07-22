# GamRemit — USDC Cross-Border Remittance on Arc Testnet

USDC-powered remittance platform built on **Arc Testnet** and **Circle**
infrastructure, with a Gambia ⇄ Nigeria (GMD ⇄ NGN) corridor as the initial
use case.

🔗 Live app: [gamremit.xyz/app](https://gamremit.xyz/app)

---

## What's actually running

This project is deployed on **Cloudflare Pages** (Pages Functions), not a
standalone Worker — see `wrangler.toml` and `functions/api/*`.

- **Circle Developer-Controlled Wallets** — wallet creation & custody
- **CCTP V2** — cross-chain USDC bridging (Arc Testnet ⇄ Ethereum Sepolia),
  implemented via raw REST calls (see `functions/api/_cctp.js`) instead of
  `@circle-fin/bridge-kit`, because that package's Solana dependency crashes
  under Cloudflare Workers' `eval()`-blocking sandbox
- **D1** — all persistent data (users, transactions, KYC). KV is used only
  for short-lived TTL caches (OTP codes, JWK cache, quote caches) — D1's
  free tier write/read limits are far more generous than KV's
- **Blockradar** — NGN fiat off-ramp integration
- **JWT auth**, OTP-based verification

## API Routes

| Method | Path                         | Auth       | Description                       |
|--------|------------------------------|------------|------------------------------------|
| POST   | /api/auth/register           | None       | Register new user                  |
| POST   | /api/auth/login              | None       | Login, returns JWT                 |
| GET    | /api/auth/me                 | User       | Current user + notifications       |
| PATCH  | /api/auth/me                 | User       | Update profile                     |
| GET    | /api/wallet/balance          | User       | Circle wallet balance               |
| POST   | /api/bridge/execute          | User       | Start a CCTP bridge (burn on Arc)  |
| GET    | /api/bridge/status/:id       | User       | Poll attestation / mint status     |
| GET    | /api/bridge/list             | User       | Bridge history                     |
| POST   | /api/swap/estimate           | User       | Same-chain swap quote (disabled)   |
| POST   | /api/swap/execute            | User       | Same-chain swap (disabled)         |
| GET    | /api/admin/users             | Admin      | List all users + stats             |
| PATCH  | /api/admin/users/:id         | Admin      | Approve / block user                |
| GET    | /api/transactions            | User/Admin | Get transactions                    |
| POST   | /api/transactions            | User       | Submit new transfer                 |
| GET    | /api/rates                   | None       | Get exchange rates                  |
| POST   | /api/rates                   | Admin      | Update rate / fee                   |
| GET    | /api/kyc                     | Admin      | List KYC submissions                 |
| POST   | /api/kyc                     | User       | Submit KYC documents                 |
| PATCH  | /api/kyc/:id                 | Admin      | Approve / reject KYC                 |

> **Note:** `/api/swap/*` currently returns a 503 by design. Circle's Swap
> SDK pulls in `@solana/web3.js` unconditionally, which fails at runtime on
> Cloudflare Workers. The frontend swap panel is locked to same-token
> bridging only until this is resolved.

---

## Setup

### 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2 — Set secrets on Cloudflare (never commit real values — set them directly)

```bash
npx wrangler pages secret put JWT_SECRET --project-name=gamremitagent
npx wrangler pages secret put ADMIN_PASSWORD --project-name=gamremitagent
npx wrangler pages secret put CIRCLE_APP_ID --project-name=gamremitagent
npx wrangler pages secret put CIRCLE_ENTITY_SECRET --project-name=gamremitagent
npx wrangler pages secret put CIRCLE_USER_API_KEY --project-name=gamremitagent
npx wrangler pages secret put CIRCLE_WALLET_SET_ID --project-name=gamremitagent
npx wrangler pages secret put BLOCKRADAR_API_KEY --project-name=gamremitagent
npx wrangler pages secret put BLOCKRADAR_WALLET_ID --project-name=gamremitagent
npx wrangler pages secret put BLOCKRADAR_DEPOSIT_ADDRESS --project-name=gamremitagent
npx wrangler pages secret put RELAYER_WALLET_ID_ETHEREUM_SEPOLIA --project-name=gamremitagent
```

Generate `JWT_SECRET` and `ADMIN_PASSWORD` yourself (e.g. `openssl rand -hex 32`)
— do not reuse any value that has ever appeared in this repo's history.

### 3 — Create the D1 database

```bash
npx wrangler d1 create gamremit-db
npx wrangler d1 execute gamremit-db --remote --file=./schema.sql
```

Update `database_id` in `wrangler.toml` with the ID printed above.

### 4 — Deploy

```bash
npx wrangler pages deploy .
```

### 5 — Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your own real values — this file is gitignored
wrangler pages dev .
```

---

## Security

- No credentials are hardcoded anywhere in this repo — every secret is read
  from `env.*` at runtime via Cloudflare Pages secret bindings.
- `.gitignore` excludes `.env`, `.dev.vars`, `.wrangler/`, and key/PEM files.
- If you ever find a real credential committed to this repo's history,
  rotate it immediately — removing it from a new commit does **not** remove
  it from git history.
