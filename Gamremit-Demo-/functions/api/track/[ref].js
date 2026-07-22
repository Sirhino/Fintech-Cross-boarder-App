// functions/api/track/[ref].js — public transfer tracking, no auth required
// (same intent as the public /pay/* page: anyone with the reference/ID can
// check status, no login needed). This file didn't exist before — the
// frontend's Track Transfer tab was calling /api/track/${ref} against
// nothing, which is why it always returned a network error.
//
// Supports two kinds of references:
//   GR-xxxxxx-xxxx  — a regular send-money transaction (bank recipient)
//   br-xxxxxxxxx-xxxxx — a cross-chain bridge transfer (blockchain destination)
import { jsonResponse, optionsResponse } from '../_auth.js';
import { getTx } from '../_db.js';

export async function onRequestGet({ params, env }) {
  try {
    const ref = (params.ref || '').trim();
    if (!ref) return jsonResponse({ error: 'Reference required' }, 400);

    // ── Bridge transfer (br-...) ──────────────────────────────────
    if (ref.toLowerCase().startsWith('br-')) {
      const row = await env.DB.prepare('SELECT data FROM bridges WHERE id = ?').bind(ref.toLowerCase()).first();
      if (!row) return jsonResponse({ transaction: null });
      const bridge = JSON.parse(row.data);

      // Map bridge state to the same status vocabulary the frontend
      // already knows how to badge (s-processing, s-completed, s-error, etc.)
      const statusMap = { success: 'completed', error: 'rejected' };
      const status = statusMap[bridge.state] || 'processing';

      return jsonResponse({
        transaction: {
          kind: 'bridge',
          reference: bridge.id,
          status,
          sendAmount: bridge.amount,
          sendCurrency: 'USDC',
          receiveAmount: bridge.amount,
          receiveCurrency: 'USDC',
          fromChain: bridge.fromChain,
          toChain: bridge.toChain,
          toAddress: bridge.toAddress,
          burnTxHash: bridge.burnTxHash || null,
          mintTxHash: bridge.mintTxHash || null,
          createdAt: bridge.createdAt,
          completedAt: bridge.completedAt || null,
          adminNote: bridge.error || null,
        }
      });
    }

    // ── Regular send-money transaction (GR-...) ───────────────────
    const tx = await getTx(ref, env);
    if (!tx) return jsonResponse({ transaction: null });

    return jsonResponse({
      transaction: {
        kind: 'transfer',
        reference: tx.reference,
        status: tx.status,
        sendAmount: tx.sendAmount,
        sendCurrency: tx.sendCurrency,
        receiveAmount: tx.receiveAmount,
        receiveCurrency: tx.receiveCurrency,
        recipientName: tx.recipientName,
        bankName: tx.bankName,
        createdAt: tx.createdAt,
        adminNote: tx.adminNote || null,
      }
    });
  } catch (e) {
    console.error('[track]', e.message);
    return jsonResponse({ error: e.message || 'Lookup failed' }, 502);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
