// functions/api/_cctp.js — Circle CCTP V2 constants and raw-REST helpers.
// Built without @circle-fin/app-kit, which crashes on Cloudflare's real
// runtime (it unconditionally pulls in @solana/web3.js, which depends on
// rpc-websockets -> a Babel runtime that uses eval(), blocked by Workers'
// V8 isolate sandbox). This talks to Circle's plain REST API instead —
// the same approach _circle.js already uses successfully for balances/sends.
//
// Contract addresses are identical across every CCTP V2 testnet (deployed
// via CREATE2) — only the domain ID differs per chain.
export const CCTP_CONTRACTS = {
  tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
};

// domain: Circle's internal CCTP routing number (not the same as chain ID).
// usdcAddress: needed on the source chain for approve(); not needed for mint.
// blockchainCode: Circle Wallets API's blockchain identifier for this chain.
export const CCTP_CHAINS = {
  Arc_Testnet: {
    domain: 26,
    usdcAddress: '0x3600000000000000000000000000000000000000',
    blockchainCode: 'ARC-TESTNET',
  },
  Ethereum_Sepolia: {
    domain: 0,
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    blockchainCode: 'ETH-SEPOLIA',
  },
  Base_Sepolia: {
    domain: 6,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    blockchainCode: 'BASE-SEPOLIA',
  },
  // Avalanche Fuji intentionally left out of this pass — add domain +
  // usdcAddress + blockchainCode here once Base is confirmed working,
  // then add a funded relayer wallet for it too.
};

const IRIS_BASE = 'https://iris-api-sandbox.circle.com'; // testnet; mainnet is iris-api.circle.com

// Left-pad a 20-byte EVM address to a 32-byte value, as CCTP's bytes32
// address fields require (12 zero bytes prepended).
export function addressToBytes32(address) {
  return '0x' + '0'.repeat(24) + address.replace(/^0x/i, '').toLowerCase();
}

// USDC has 6 decimals on every CCTP-supported chain.
export function toUsdcUnits(amount) {
  return Math.round(parseFloat(amount) * 1_000_000).toString();
}
export function fromUsdcUnits(units) {
  return (parseInt(units, 10) / 1_000_000).toString();
}

import { getEntityCiphertext } from './_circle.js';
export { getEntityCiphertext };

async function circleFetch(env, path, options = {}) {
  const res = await fetch(`https://api.circle.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.CIRCLE_USER_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.message || `Circle API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function circleContractExecution(env, { walletId, contractAddress, abiFunctionSignature, abiParameters, entitySecretCiphertext, feeLevel = 'MEDIUM' }) {
  return circleFetch(env, '/v1/w3s/developer/transactions/contractExecution', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletId,
      contractAddress,
      abiFunctionSignature,
      abiParameters,
      entitySecretCiphertext,
      feeLevel,
    }),
  });
}

export async function getCircleTx(env, id) {
  return circleFetch(env, `/v1/w3s/transactions/${id}`);
}

// Poll a Circle transaction until it reaches a terminal state.
export async function waitForCircleTx(env, id, { timeoutMs = 25000, intervalMs = 2000 } = {}) {
  const terminal = ['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await getCircleTx(env, id);
    if (terminal.includes(data.transaction.state)) return data.transaction;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null; // caller should treat as "still pending, check back later"
}

// Query Circle's Iris attestation service for a burn message's status.
export async function getAttestation(sourceDomain, txHash) {
  const res = await fetch(`${IRIS_BASE}/v2/messages/${sourceDomain}?transactionHash=${txHash}`);
  const data = await res.json();
  return data?.messages?.[0] || null; // { status, message, attestation, ... } or null if not indexed yet
}

// Fast Transfer (minFinalityThreshold=1000) needs a maxFee set high enough
// to cover Circle's current Fast Transfer fee for this specific route, or
// the burn call reverts on-chain (see depositForBurn's maxFee behavior).
// Always fetch the live fee rather than guessing — Circle's docs are
// explicit that fees "are subject to change" per route. If the route
// doesn't support Fast Transfer at all (some source chains skip it because
// their standard finality is already fast), this falls back to Standard
// Transfer (threshold 2000, maxFee 0) rather than failing the bridge.
export async function getFastTransferPlan(sourceDomain, destDomain, amountUnits) {
  try {
    const res = await fetch(`${IRIS_BASE}/v2/burn/USDC/fees/${sourceDomain}/${destDomain}`);
    const fees = await res.json();
    const fastFee = Array.isArray(fees) ? fees.find(f => f.finalityThreshold <= 1000) : null;
    if (!fastFee || fastFee.minimumFee == null) {
      return { minFinalityThreshold: 2000, maxFee: '0', mode: 'standard' };
    }
    // minimumFee is in basis points of the transfer amount; add a 20% buffer
    // per Circle's documented guidance to avoid reverts from minor fee drift.
    const amount = BigInt(amountUnits);
    const protocolFee = (amount * BigInt(Math.round(fastFee.minimumFee * 100))) / 1_000_000n;
    const maxFee = (protocolFee * 120n) / 100n;
    return { minFinalityThreshold: 1000, maxFee: maxFee.toString(), mode: 'fast' };
  } catch (e) {
    console.error('[cctp:fee]', e.message);
    return { minFinalityThreshold: 2000, maxFee: '0', mode: 'standard' };
  }
}
