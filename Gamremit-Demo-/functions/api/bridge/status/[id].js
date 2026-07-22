// functions/api/bridge/status/[id].js — REAL CCTP V2 bridge, Phase 2.
// The frontend polls this after a burn (from bridge/execute.js) completes.
// Each call: checks Circle's Iris attestation service; once the message is
// attested, submits receiveMessage() on the destination chain using a
// GamRemit-owned "relayer" wallet (receiveMessage is permissionless per
// CCTP's design — anyone can submit it, the minted USDC always goes to the
// mintRecipient address baked into the original burn message, regardless of
// who calls receiveMessage). This avoids needing a funded wallet per user
// per destination chain — one relayer wallet per chain covers everyone.
import { fromRequest, jsonResponse, optionsResponse } from '../../_auth.js';
import { getUser, getAllTxs, saveTx, sendEmail } from '../../_db.js';
import {
  CCTP_CONTRACTS, CCTP_CHAINS, circleContractExecution, waitForCircleTx,
  getEntityCiphertext, getAttestation,
} from '../../_cctp.js';

async function getBridgeRecord(userId, bridgeId, env) {
  const row = await env.DB.prepare('SELECT data FROM bridges WHERE id = ? AND user_id = ?').bind(bridgeId, userId).first();
  return row ? JSON.parse(row.data) : null;
}
async function saveBridgeRecord(userId, bridgeId, record, env) {
  await env.DB.prepare(
    `INSERT INTO bridges (id, user_id, data) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).bind(bridgeId, userId, JSON.stringify(record)).run();
}

export async function onRequestGet({ request, env, params }) {
  try {
    const JWT_SECRET = env.JWT_SECRET;
    if (!JWT_SECRET) return jsonResponse({ error: 'Server misconfigured — contact support' }, 500);
    const claim = await fromRequest(request, JWT_SECRET);
    if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

    const user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    const bridge = await getBridgeRecord(user.id, params.id, env);
    if (!bridge) return jsonResponse({ error: 'Bridge not found' }, 404);

    // Already finished (success or error) — nothing more to do, just report it.
    if (bridge.state === 'success' || bridge.state === 'error') {
      return jsonResponse({ success: true, bridge });
    }

    const destChain = CCTP_CHAINS[bridge.toChain];
    if (!destChain) return jsonResponse({ success: true, bridge }); // shouldn't happen

    // ── Check attestation ────────────────────────────────────────────
    const attestation = await getAttestation(CCTP_CHAINS.Arc_Testnet.domain, bridge.burnTxHash);
    if (!attestation || attestation.status !== 'complete') {
      bridge.state = 'attesting';
      await saveBridgeRecord(user.id, bridge.id, bridge, env);
      return jsonResponse({ success: true, bridge });
    }

    // ── Attested — submit the mint via the relayer wallet ────────────
    const relayerWalletId = env[`RELAYER_WALLET_ID_${bridge.toChain.toUpperCase()}`];
    if (!relayerWalletId) {
      bridge.state = 'error';
      bridge.error = `No relayer wallet configured for ${bridge.toChain}`;
      await saveBridgeRecord(user.id, bridge.id, bridge, env);
      return jsonResponse({ success: false, bridge, error: bridge.error }, 500);
    }

    if (!bridge.mintTxId) {
      const ciphertext = await getEntityCiphertext(env);
      const mintTx = await circleContractExecution(env, {
        walletId: relayerWalletId,
        contractAddress: CCTP_CONTRACTS.messageTransmitterV2,
        abiFunctionSignature: 'receiveMessage(bytes,bytes)',
        abiParameters: [attestation.message, attestation.attestation],
        entitySecretCiphertext: ciphertext,
      });
      bridge.mintTxId = mintTx.data.id;
      bridge.state = 'minting';
      await saveBridgeRecord(user.id, bridge.id, bridge, env);
    }

    const mintResult = await waitForCircleTx(env, bridge.mintTxId, { timeoutMs: 8000, intervalMs: 2000 });
    if (!mintResult) {
      // Still pending — frontend will poll again shortly.
      return jsonResponse({ success: true, bridge });
    }
    if (mintResult.state === 'COMPLETE') {
      bridge.state = 'success';
      bridge.mintTxHash = mintResult.txHash;
      bridge.completedAt = new Date().toISOString();
      await saveBridgeRecord(user.id, bridge.id, bridge, env);

      // Flip the linked transaction from 'processing' to 'sent'/'completed'.
      const txs = await getAllTxs(env);
      const linked = txs.find(t => t.type === 'bridge_transfer' && t.userId === user.id && t.status === 'processing' && Math.abs(t.sendAmount - parseFloat(bridge.amount)) < 0.000001);
      if (linked) {
        linked.status = 'completed';
        await saveTx(linked, env);
      }

      // Best-effort email — a failed send here should never block the
      // response, so this stays outside the main try/catch's error path.
      try {
        const destLabel = bridge.toChain.replace(/_/g, ' ');
        const html = `
          <div style="font-family:'Sora',sans-serif;max-width:480px;margin:0 auto;background:#07090F;color:#fff;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#1246F5,#2A5AFF);padding:28px 32px;text-align:center">
              <h1 style="margin:0;font-size:1.6rem;font-weight:800;letter-spacing:-.02em">GamRemit</h1>
              <p style="margin:8px 0 0;opacity:.8;font-size:.9rem">Bridge Complete</p>
            </div>
            <div style="padding:32px">
              <p style="color:rgba(255,255,255,.7);margin:0 0 20px;font-size:.95rem;line-height:1.7">
                Your bridge transfer has landed. <strong style="color:#00D48C">${bridge.amount} USDC</strong> is now available on <strong>${destLabel}</strong>.
              </p>
              <div style="background:rgba(0,212,140,.08);border:1px solid rgba(0,212,140,.2);border-radius:12px;padding:16px 18px;font-size:.8rem;color:rgba(255,255,255,.6);word-break:break-all">
                <div style="margin-bottom:8px"><strong style="color:#fff">Destination</strong><br>${bridge.toAddress}</div>
                <div><strong style="color:#fff">Mint transaction</strong><br>${bridge.mintTxHash}</div>
              </div>
            </div>
            <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,.08);text-align:center">
              <p style="color:rgba(255,255,255,.3);font-size:.72rem;margin:0">© 2025 GamRemit · Arc Testnet · USDC Settlement</p>
            </div>
          </div>`;
        await sendEmail({ to: user.email, subject: `✅ ${bridge.amount} USDC bridged to ${destLabel}`, html }, env);
      } catch (e) { console.error('[bridge:status:email]', e.message); }
    } else {
      bridge.state = 'error';
      bridge.error = `Mint transaction ${mintResult.state.toLowerCase()}`;
      await saveBridgeRecord(user.id, bridge.id, bridge, env);
    }

    return jsonResponse({ success: bridge.state === 'success', bridge });
  } catch (e) {
    console.error('[bridge:status]', e.message);
    return jsonResponse({ error: e.message || 'Status check failed unexpectedly' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
