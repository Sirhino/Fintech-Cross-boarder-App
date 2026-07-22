// functions/api/wallet/balance.js — real on-chain USDC + EURC balances for the logged-in user's Circle wallet
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser } from '../_db.js';
import { getAllBalances } from '../_circle.js';

export async function onRequestGet({ request, env }) {
  const JWT_SECRET = env.JWT_SECRET;
  if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await getUser(claim.email, env);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  const walletId = user.circleWalletId || user.walletId;
  if (!walletId) return jsonResponse({ success: true, balance: null, balances: [], message: 'No Circle wallet yet' });

  try {
    const balances = await getAllBalances(walletId, env);
    const usdc = balances.find(b => b.symbol === 'USDC');
    // `balance` kept for backward compatibility with existing frontend code
    // that only ever asked for the USDC number; `balances` is the new,
    // full multi-token array (USDC + EURC).
    return jsonResponse({ success: true, balance: usdc?.amount ?? 0, balances });
  } catch (e) {
    console.error('[wallet:balance]', e.message);
    return jsonResponse({ error: e.message }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
