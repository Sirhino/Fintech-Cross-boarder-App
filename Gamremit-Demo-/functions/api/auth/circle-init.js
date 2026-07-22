// functions/api/auth/circle-init.js
// Called after OTP verify to initialize Circle wallet via SDK challenge
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveUser } from '../_db.js';

export async function onRequestPost({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const apiKey = env.CIRCLE_USER_API_KEY;
  const appId  = env.CIRCLE_APP_ID;
  if (!apiKey || !appId) {
    return jsonResponse({ error: 'Circle not configured', skipped: true }, 200);
  }

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  try {
    // ── Step 1: Ensure Circle user exists ─────────────────────────
    let circleUserId = user.circleUserId;
    if (!circleUserId) {
      const createRes = await fetch('https://api.circle.com/v1/w3s/users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-User-Id': user.id
        },
        body: JSON.stringify({ userId: user.id })
      });
      const createData = await createRes.json();
      circleUserId = createData?.data?.id || user.id;
      user.circleUserId = circleUserId;
    }

    // ── Step 2: Get user token ─────────────────────────────────────
    const tokenRes = await fetch(
      `https://api.circle.com/v1/w3s/users/${encodeURIComponent(circleUserId)}/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[circle:token]', tokenRes.status, err);
      return jsonResponse({ error: 'Failed to get Circle user token', skipped: true }, 200);
    }
    const tokenData = await tokenRes.json();
    const userToken     = tokenData?.data?.userToken;
    const encryptionKey = tokenData?.data?.encryptionKey;

    if (!userToken) return jsonResponse({ error: 'No userToken returned', skipped: true }, 200);

    // ── Step 3: Check if wallet already exists ────────────────────
    if (user.circleWalletId) {
      // Already initialized — just return a fresh token for re-auth
      return jsonResponse({
        success: true,
        alreadyInitialized: true,
        userToken,
        encryptionKey,
        appId,
        circleUserId
      });
    }

    // ── Step 4: Initialize user — creates PIN challenge ───────────
    const initRes = await fetch('https://api.circle.com/v1/w3s/user/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-User-Token': userToken
      },
      body: JSON.stringify({
        idempotencyKey: `init-${user.id}-${Date.now()}`,
        accountType: 'EOA',  // Externally Owned Account on Arc Testnet
        blockchains: ['ARC-TESTNET']
      })
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      console.error('[circle:init]', initRes.status, err);
      // Return token anyway so frontend can retry
      return jsonResponse({
        success: true,
        userToken,
        encryptionKey,
        appId,
        circleUserId,
        challengeId: null,
        note: 'Wallet init failed — user can retry'
      });
    }

    const initData  = await initRes.json();
    const challengeId = initData?.data?.challengeId;

    // Save circle user ID to user record
    await saveUser(user, env);

    return jsonResponse({
      success: true,
      userToken,
      encryptionKey,
      appId,
      circleUserId,
      challengeId,
      alreadyInitialized: false
    });

  } catch (e) {
    console.error('[circle:init]', e.message);
    return jsonResponse({ error: e.message, skipped: true }, 200);
  }
}

// ── PATCH — save wallet ID after SDK challenge completes ──────────
export async function onRequestPatch({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { walletId, walletAddress, circleUserId } = body;
  if (!walletId) return jsonResponse({ error: 'walletId required' }, 400);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  user.circleWalletId      = walletId;
  user.circleWalletAddress = walletAddress || null;
  user.circleUserId        = circleUserId  || user.circleUserId;
  user.walletInitializedAt = new Date().toISOString();
  await saveUser(user, env);

  return jsonResponse({ success: true, walletId, walletAddress });
}

export async function onRequestOptions() { return optionsResponse(); }
