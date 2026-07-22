// functions/api/swap/estimate.js — Token swap (Circle Swap SDK via App Kit)
// TEMPORARILY DISABLED — see functions/api/bridge/execute.js for the full
// explanation: Circle's App Kit / Swap Kit packages depend on
// @solana/web3.js unconditionally, which crashes at Cloudflare's actual
// runtime (builds fine, fails on real requests). Not fixable at this layer.
import { jsonResponse, optionsResponse } from '../_auth.js';

export async function onRequestPost() {
  return jsonResponse({
    error: 'Token swaps are temporarily unavailable while we resolve a platform compatibility issue. Please check back soon.'
  }, 503);
}

export async function onRequestOptions() { return optionsResponse(); }
