// functions/api/admin/setup-relayer.js — ONE-TIME admin utility.
// Creates a Circle developer wallet on the given destination chain and
// auto-funds it with testnet native gas via Circle's own faucet, so it can
// act as the shared "relayer" that submits the mint step of CCTP bridges
// for every user on that chain (see bridge/status/[id].js for why one
// shared wallet is safe: receiveMessage() is permissionless, funds always
// go to the address in the original burn message, not to the caller).
//
// Admin-only. Run once per destination chain you want to support, then
// copy the printed walletId into a secret:
//   npx wrangler pages secret put RELAYER_WALLET_ID_<CHAIN> --project-name=gamremitagent
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';

const CIRCLE_BLOCKCHAIN_CODES = {
  Ethereum_Sepolia: 'ETH-SEPOLIA',
  Base_Sepolia: 'BASE-SEPOLIA',
  Avalanche_Fuji: 'AVAX-FUJI',
};

export async function onRequestPost({ request, env }) {
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim || claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const { chain } = body;
    const blockchainCode = CIRCLE_BLOCKCHAIN_CODES[chain];
    if (!blockchainCode) {
      return jsonResponse({ error: `Unknown chain "${chain}". Supported: ${Object.keys(CIRCLE_BLOCKCHAIN_CODES).join(', ')}` }, 400);
    }

    const apiKey = env.CIRCLE_USER_API_KEY;
    const entitySecret = env.CIRCLE_ENTITY_SECRET;
    const walletSetId = env.CIRCLE_WALLET_SET_ID;
    if (!apiKey || !entitySecret || !walletSetId) {
      return jsonResponse({ error: 'Circle credentials not configured on server' }, 500);
    }

    // Same entity-secret-encryption pattern as auth/circle-wallet.js
    const pubKeyRes = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const pubKeyData = await pubKeyRes.json();
    const pubKeyPem = pubKeyData?.data?.publicKey;
    if (!pubKeyPem) return jsonResponse({ error: 'Could not fetch Circle entity public key' }, 502);
    const pemBody = pubKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, '');
    const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey('spki', binaryDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const secretBytes = Uint8Array.from(entitySecret.match(/.{2}/g).map(b => parseInt(b, 16)));
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, secretBytes);
    const ciphertext = btoa(String.fromCharCode(...new Uint8Array(encrypted)));

    // Create the wallet
    const walletRes = await fetch('https://api.circle.com/v1/w3s/developer/wallets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        entitySecretCiphertext: ciphertext,
        wallets: [{ refId: `relayer-${chain}`, description: `GamRemit CCTP relayer — ${chain}`, count: 1 }],
        walletSetId,
        blockchains: [blockchainCode],
      })
    });
    const walletData = await walletRes.json();
    const wallet = walletData?.data?.wallets?.[0];
    if (!wallet) {
      return jsonResponse({ error: walletData?.message || 'Wallet creation failed', raw: walletData }, 502);
    }

    // Fund with native gas token via Circle's testnet faucet
    let faucetResult = null;
    try {
      const faucetRes = await fetch('https://api.circle.com/v1/faucet/drips', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: wallet.address, blockchain: blockchainCode, native: true })
      });
      faucetResult = await faucetRes.json();
    } catch (e) {
      faucetResult = { error: e.message };
    }

    return jsonResponse({
      success: true,
      chain,
      walletId: wallet.id,
      address: wallet.address,
      faucetResult,
      nextStep: `Run: npx wrangler pages secret put RELAYER_WALLET_ID_${chain.toUpperCase()} --project-name=gamremitagent   (then paste this walletId when prompted)`,
    }, 201);

  } catch (e) {
    console.error('[admin:setup-relayer]', e.message);
    return jsonResponse({ error: e.message || 'Setup failed unexpectedly' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
