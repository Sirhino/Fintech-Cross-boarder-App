// functions/api/bridge/execute.js — REAL CCTP V2 bridge, Phase 1: approve + burn.
// Rebuilt without @circle-fin/app-kit (see _cctp.js header for why that
// package can't be used on Cloudflare). Talks to Circle's plain REST API,
// the exact same pattern _circle.js already uses successfully for
// balances and sends.
//
// This only performs approve() + depositForBurn() on the source chain
// (Arc Testnet) and returns immediately — both steps are fast (a few
// seconds each on testnet). The slower part (waiting for Circle's
// attestation, then minting on the destination chain) happens separately
// in bridge/status/[id].js, which the frontend polls. Splitting it this
// way keeps each HTTP request comfortably within Cloudflare's execution
// limits instead of one long blocking call.
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';
import { getUser, saveTx, generateRef, addNotif } from '../_db.js';
import {
  CCTP_CONTRACTS, CCTP_CHAINS, addressToBytes32, toUsdcUnits,
  circleContractExecution, waitForCircleTx, getEntityCiphertext, getFastTransferPlan,
} from '../_cctp.js';

async function saveBridgeRecord(userId, bridgeId, record, env) {
  if (!env?.DB) return;
  await env.DB.prepare(
    `INSERT INTO bridges (id, user_id, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).bind(bridgeId, userId, JSON.stringify(record)).run();
}

export async function onRequestPost({ request, env }) {
  let user, amt, toChain, toAddress, bridgeId;
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

    user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    const walletId = user.circleWalletId || user.walletId;
    const walletAddress = user.circleWalletAddress || user.walletAddress;
    if (!walletId || !walletAddress) {
      return jsonResponse({ error: 'No Circle wallet on this account yet' }, 400);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    ({ toChain, toAddress } = body);
    const amount = body.amount;

    const destChain = CCTP_CHAINS[toChain];
    if (!destChain) {
      return jsonResponse({ error: `Unsupported destination: ${toChain}. Currently supported: ${Object.keys(CCTP_CHAINS).filter(c => c !== 'Arc_Testnet').join(', ')}` }, 400);
    }
    if (toChain === 'Arc_Testnet') {
      return jsonResponse({ error: 'The source chain is always Arc Testnet — pick a different destination to bridge to.' }, 400);
    }
    if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
      return jsonResponse({ error: 'A valid destination address (0x...) is required' }, 400);
    }
    amt = parseFloat(amount);
    if (!amount || isNaN(amt) || amt <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);

    const relayerEnvKey = `RELAYER_WALLET_ID_${toChain.toUpperCase()}`;
    if (!env[relayerEnvKey]) {
      return jsonResponse({ error: `Bridging to ${toChain} isn't fully configured yet (missing relayer wallet). Contact support.` }, 500);
    }

    bridgeId = `br-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const source = CCTP_CHAINS.Arc_Testnet;
    const units = toUsdcUnits(amt);

    // ── Step 1: approve TokenMessengerV2 to spend the USDC ──────────
    const approveCiphertext = await getEntityCiphertext(env);
    const approveTx = await circleContractExecution(env, {
      walletId,
      contractAddress: source.usdcAddress,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [CCTP_CONTRACTS.tokenMessengerV2, units],
      entitySecretCiphertext: approveCiphertext,
    });
    const approveResult = await waitForCircleTx(env, approveTx.data.id);
    if (!approveResult || approveResult.state !== 'COMPLETE') {
      throw new Error(`Approval step did not complete in time (state: ${approveResult?.state || 'unknown'}). It may still succeed — check back shortly.`);
    }

    // ── Step 2: depositForBurn ───────────────────────────────────────
    // Try Fast Transfer first (settles in seconds instead of waiting for
    // full source-chain finality) — getFastTransferPlan fetches Circle's
    // live fee for this route and falls back to Standard automatically if
    // Fast Transfer isn't available for it, so this never reverts trying.
    const plan = await getFastTransferPlan(source.domain, destChain.domain, units);
    const burnCiphertext = await getEntityCiphertext(env);
    const burnTx = await circleContractExecution(env, {
      walletId,
      contractAddress: CCTP_CONTRACTS.tokenMessengerV2,
      abiFunctionSignature: 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
      abiParameters: [
        units,
        destChain.domain,
        addressToBytes32(toAddress),
        source.usdcAddress,
        '0x0000000000000000000000000000000000000000000000000000000000000000'.slice(0, 66),
        plan.maxFee,
        plan.minFinalityThreshold,
      ],
      entitySecretCiphertext: burnCiphertext,
    });
    const burnResult = await waitForCircleTx(env, burnTx.data.id);
    if (!burnResult || burnResult.state !== 'COMPLETE') {
      throw new Error(`Burn step did not complete in time (state: ${burnResult?.state || 'unknown'}). Check back shortly — it may still confirm.`);
    }

    const record = {
      id: bridgeId,
      userId: user.id,
      fromChain: 'Arc_Testnet',
      toChain,
      toAddress,
      amount: amt.toFixed(6),
      state: 'burned',
      transferMode: plan.mode,
      burnTxHash: burnResult.txHash,
      approveTxId: approveTx.data.id,
      burnTxId: burnTx.data.id,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await saveBridgeRecord(user.id, bridgeId, record, env);

    const ref = generateRef();
    await saveTx({
      reference: ref,
      userId: user.id,
      userName: `${user.firstName} ${user.lastName}`,
      type: 'bridge_transfer',
      sendAmount: amt,
      sendCurrency: 'USDC',
      receiveAmount: amt,
      receiveCurrency: 'USDC',
      recipientName: `${toChain.replace(/_/g, ' ')} — ${toAddress.slice(0,6)}...${toAddress.slice(-4)}`,
      status: 'processing',
      createdAt: record.createdAt,
    }, env);

    await addNotif(user.id, {
      type: 'info',
      title: '🔄 Bridge processing',
      body: `${amt} USDC burned on Arc — waiting for attestation to mint on ${toChain.replace(/_/g, ' ')}`,
      link: '/app.html#history'
    }, env);

    return jsonResponse({ success: true, bridge: record }, 201);

  } catch (e) {
    console.error('[bridge:execute]', bridgeId, e.message);
    if (!user || !bridgeId) {
      return jsonResponse({ error: e.message || 'Bridge failed unexpectedly' }, 502);
    }
    const record = {
      id: bridgeId, userId: user.id, fromChain: 'Arc_Testnet', toChain, toAddress,
      amount: (amt || 0).toFixed(6), state: 'error', error: e.message,
      createdAt: new Date().toISOString(), completedAt: null,
    };
    await saveBridgeRecord(user.id, bridgeId, record, env);

    const ref = generateRef();
    await saveTx({
      reference: ref,
      userId: user.id,
      userName: `${user.firstName} ${user.lastName}`,
      type: 'bridge_transfer',
      sendAmount: amt || 0,
      sendCurrency: 'USDC',
      receiveAmount: 0,
      receiveCurrency: 'USDC',
      recipientName: toChain ? `${toChain.replace(/_/g, ' ')} — ${(toAddress||'').slice(0,6)}...${(toAddress||'').slice(-4)}` : 'Unknown',
      status: 'rejected',
      adminNote: e.message,
      createdAt: record.createdAt,
    }, env);

    return jsonResponse({ success: false, error: e.message, bridge: record }, 500);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
