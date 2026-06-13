// functions/api/bridge/transfer.js — CCTP V2 Bridge (Arc ↔ other chains)
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser } from '../_db.js';

// Supported chains for testnet bridging via CCTP V2
const SUPPORTED_CHAINS = {
  arc: {
    name: 'Arc Testnet',
    chainId: 5042002,
    domain: 9,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // testnet USDC on Arc
    cctpMessenger: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155'
  },
  sepolia: {
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    domain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    cctpMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
  },
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    domain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    cctpMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
  },
  'avax-fuji': {
    name: 'Avalanche Fuji',
    chainId: 43113,
    domain: 1,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    cctpMessenger: '0xeb08f243E5d3FCFF26A9E38Ae5520A669f4019d0'
  }
};

async function kvGet(key, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return null;
  try {
    const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function kvSet(key, value, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return;
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
}

async function kvKeys(pattern, env) {
  if (!env?.UPSTASH_REDIS_REST_URL) return [];
  try {
    const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(pattern)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const d = await r.json();
    return d.result || [];
  } catch { return []; }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  const url   = new URL(request.url);
  const parts = url.pathname.split('/');
  const last  = parts[parts.length - 1];

  // GET /api/bridge/transfer — list supported chains + user's bridge history
  if (request.method === 'GET' && last === 'transfer') {
    const keys = await kvKeys(`bridge:${user.id}:*`, env);
    const history = (await Promise.all(keys.map(k => kvGet(k, env)))).filter(Boolean);
    history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return jsonResponse({ success: true, chains: SUPPORTED_CHAINS, history });
  }

  // GET /api/bridge/transfer/:id — check specific bridge status
  if (request.method === 'GET' && last !== 'transfer') {
    const bridge = await kvGet(`bridge:${user.id}:${last}`, env);
    if (!bridge) return jsonResponse({ error: 'Bridge transfer not found' }, 404);

    // Simulate status progression for testnet
    let updatedBridge = { ...bridge };
    const ageMs = Date.now() - new Date(bridge.createdAt).getTime();
    if (bridge.status === 'initiated' && ageMs > 30000)       updatedBridge.status = 'attesting';
    if (bridge.status === 'attesting' && ageMs > 90000)       updatedBridge.status = 'complete';
    if (updatedBridge.status !== bridge.status) await kvSet(`bridge:${user.id}:${last}`, updatedBridge, env);

    return jsonResponse({ success: true, bridge: updatedBridge });
  }

  // POST /api/bridge/transfer — initiate bridge
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { fromChain, toChain, amount, toAddress } = body;

    if (!SUPPORTED_CHAINS[fromChain]) return jsonResponse({ error: `Unsupported source chain: ${fromChain}` }, 400);
    if (!SUPPORTED_CHAINS[toChain])   return jsonResponse({ error: `Unsupported destination chain: ${toChain}` }, 400);
    if (fromChain === toChain)         return jsonResponse({ error: 'Source and destination must differ' }, 400);
    if (!amount || parseFloat(amount) <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);

    const recipient = toAddress || user.circleWalletId || '0x0000000000000000000000000000000000000000';

    const bridgeId = `br-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const srcChain = SUPPORTED_CHAINS[fromChain];
    const dstChain = SUPPORTED_CHAINS[toChain];

    // Estimate CCTP V2 fee (testnet: ~0.001 USDC flat)
    const fee = 0.001;

    const bridge = {
      id: bridgeId,
      userId: user.id,
      fromChain: { key: fromChain, ...srcChain },
      toChain:   { key: toChain, ...dstChain },
      amount:    parseFloat(amount).toFixed(6),
      fee:       fee.toFixed(6),
      netAmount: (parseFloat(amount) - fee).toFixed(6),
      recipient,
      status:    'initiated', // initiated → attesting → complete
      burnTxHash: `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
      mintTxHash: null,
      attestation: null,
      estimatedTime: '~2 minutes (testnet)',
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    await kvSet(`bridge:${user.id}:${bridgeId}`, bridge, env);

    return jsonResponse({ success: true, bridge }, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function onRequestOptions() { return optionsResponse(); }
