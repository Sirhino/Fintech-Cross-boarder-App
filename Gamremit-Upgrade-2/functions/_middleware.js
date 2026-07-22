// functions/_middleware.js — centralized CORS enforcement for /api/*.
//
// IMPORTANT: CORS is a BROWSER-ONLY mechanism. It restricts which websites'
// JavaScript is allowed to read a cross-origin fetch() response. It has NO
// effect on:
//   - Server-to-server calls (this backend calling Circle/Blockradar APIs)
//   - Incoming webhooks (Circle/Blockradar calling US) — webhook senders are
//     servers, not browsers, and never send an Origin header at all
//   - Native mobile apps (Android/iOS) — these aren't subject to CORS either
//   - curl, Postman, backend services generally
// This middleware only ever affects requests that include a browser-style
// `Origin` header. Everything else passes through completely untouched.
//
// It also only runs for /api/* (per _routes.json's include scope) — static
// page loads (app.html, admin.html, etc.) are never touched by this file.

const ALLOWED_ORIGINS = new Set([
  'https://gamremit.xyz',
  'https://www.gamremit.xyz',
  'https://gamremitagent.pages.dev',
  // Local development
  'http://localhost:8788',   // wrangler pages dev default port
  'http://localhost:3000',
  'http://127.0.0.1:8788',
]);

const CORS_METHODS = 'GET,POST,PATCH,PUT,DELETE,OPTIONS';
const CORS_HEADERS = 'Content-Type,Authorization';

export async function onRequest(context) {
  const { request, next } = context;
  const origin = request.headers.get('Origin');

  // No Origin header at all = not a browser CORS request (webhook, mobile
  // app, server-to-server call, curl, etc.) — pass straight through.
  if (!origin) return next();

  const isAllowed = ALLOWED_ORIGINS.has(origin);

  // Preflight requests: answer directly, don't even reach the route handler.
  if (request.method === 'OPTIONS') {
    if (!isAllowed) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const response = await next();

  // Rebuild the response with the correct CORS header — this overrides
  // whatever the individual route handler already set (most currently
  // default to '*'), so this file is the single source of truth.
  const headers = new Headers(response.headers);
  if (isAllowed) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', CORS_METHODS);
    headers.set('Access-Control-Allow-Headers', CORS_HEADERS);
  } else {
    // Unknown origin: strip any CORS header so the browser blocks the page's
    // JS from reading the response. The request has already been processed
    // by this point — CORS never blocks the server from doing the work,
    // only the browser from letting the calling page see the result.
    headers.delete('Access-Control-Allow-Origin');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
