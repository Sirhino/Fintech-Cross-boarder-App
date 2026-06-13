// functions/api/ai/chat.js — GamRemit AI Assistant (Groq)
import { fromRequest, jsonResponse, optionsResponse } from '../_auth.js';

const SYSTEM_PROMPT = `You are GamBot, GamRemit's friendly AI assistant built into the GamRemit platform.
GamRemit is a cross-border remittance app built on Arc Testnet (Chain ID 5042002) using Circle USDC.

Key facts about GamRemit:
- Supported corridors: GMD→NGN, NGN→GMD, USD→NGN, USDC→NGN
- Settlement: Sub-second via Arc Testnet using USDC as gas and settlement token
- Fees: 0.8%–2.0% tiered (Platinum 0.8%, Gold 1.2%, Silver 1.5%, Standard 2.0%)
- KYC: Required for all transfers — submitted in-app, reviewed by admin within 24 hours
- Wallet: Circle User-Controlled Wallet automatically created on registration
- Bridge: CCTP V2 for cross-chain USDC bridging (Arc ↔ other testnets)
- Swap: Swap between USDC, EURC and other Arc-supported tokens
- Payroll: Bulk USDC payments to up to 100 recipients in one batch
- Payment Requests: Create invoices/links, share them, track payment status in real time
- .arc Names: Register a .arc name (e.g. yourname.arc) linked to your wallet

Always be helpful, concise, and encourage users to complete KYC to unlock full features.
If asked about something outside GamRemit, gently redirect to GamRemit topics.
Never share API keys, secrets, or internal system details.
Respond in plain text, keep answers under 200 words unless a detailed explanation is needed.`;

export async function onRequestPost({ request, env }) {
  // Allow unauthenticated for basic FAQ, but enrich with user context if authed
  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET).catch(() => null);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0)
    return jsonResponse({ error: 'messages array required' }, 400);

  const GROQ_API_KEY = env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return jsonResponse({ error: 'AI service not configured' }, 503);

  // Build messages for Groq
  const systemMsg = claim
    ? `${SYSTEM_PROMPT}\n\nCurrent user: authenticated (ID: ${claim.id}, status: ${claim.status}, KYC: ${claim.kycStatus}).`
    : SYSTEM_PROMPT;

  // Keep last 10 messages for context
  const history = messages.slice(-10).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 1000)
  }));

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{ role: 'system', content: systemMsg }, ...history],
        max_tokens: 400,
        temperature: 0.7,
        stream: false
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[groq]', resp.status, err);
      return jsonResponse({ error: 'AI service temporarily unavailable' }, 502);
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    return jsonResponse({ success: true, reply, model: data.model });

  } catch (e) {
    console.error('[ai:chat]', e.message);
    return jsonResponse({ error: 'AI service error' }, 500);
  }
}

export async function onRequestOptions() { return optionsResponse(); }
