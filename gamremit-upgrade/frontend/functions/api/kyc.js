// functions/api/kyc.js — Cloudflare Pages Function
import { fromRequest, jsonResponse, optionsResponse } from './_auth.js';
import { getUser, saveUser, getKyc, saveKyc, getAllKyc,
         addNotif, pushAdminNotif, sendTelegram, sendEmail,
         KYC_TIERS, getKycTier, getKycTierByLevel } from './_db.js';

function kycEmailHtml({ firstName, status, reason }) {
  const color = status==='approved'?'#00D48C':status==='rejected'?'#FF4D6A':'#F0A033';
  const label = status==='approved'?'✅ Approved':status==='rejected'?'❌ Rejected':'⏳ Under Review';
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#07090F;color:#fff;padding:32px 24px;max-width:520px;margin:0 auto">
    <h2 style="color:${color}">KYC Verification ${label}</h2>
    <p style="color:rgba(255,255,255,.7);line-height:1.7">Dear ${firstName},<br><br>
    ${status==='approved'?'Your identity has been verified. Your account is now fully active — you can start sending money!':
      status==='rejected'?'Your KYC submission was reviewed and could not be approved.':
      'Your KYC documents have been received and are under review.'}
    </p>
    ${reason?`<div style="background:rgba(255,77,106,.1);border:1px solid rgba(255,77,106,.3);border-radius:10px;padding:14px;margin:14px 0"><strong style="color:#ff7090">Reason:</strong><br><span style="color:rgba(255,255,255,.7)">${reason}</span></div><p style="color:rgba(255,255,255,.6);font-size:14px">Please log in and resubmit with correct documents.</p>`:''}
    ${status==='approved'?`<a href="https://gamremit-pages.pages.dev/app" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#1246F5,#2A5AFF);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;margin-top:8px">Go to Dashboard →</a>`:''}
    <p style="color:rgba(255,255,255,.3);font-size:12px;margin-top:32px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px">GamRemit · 🇬🇲 Gambia ↔ 🇳🇬 Nigeria</p>
  </body></html>`;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResponse();

  const JWT_SECRET = env.JWT_SECRET || 'gamremit-dev-secret';
  const claim = await fromRequest(request, JWT_SECRET);
  if (!claim) return jsonResponse({ error: 'Unauthorized' }, 401);

  const url       = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const userId    = pathParts[pathParts.length - 1];
  const isUserId  = userId && userId.startsWith('usr-');

  // ── POST: user submits KYC ────────────────────────────────────
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const { docType, docFront, selfie, docBack, expiryDate, docNumber } = body;
    if (!docType || !docFront || !selfie)
      return jsonResponse({ error: 'Document type, front image and selfie are required' }, 400);

    const valid = ['passport','national_id','resident_permit','bank_statement'];
    if (!valid.includes(docType))
      return jsonResponse({ error: 'Invalid document type' }, 400);

    if (docType === 'bank_statement' && expiryDate) {
      const issue = new Date(expiryDate), ago = new Date();
      ago.setMonth(ago.getMonth() - 3);
      if (issue < ago) return jsonResponse({ error: 'Bank statement must be no older than 3 months' }, 400);
    }

    const user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    const existing    = await getKyc(user.id, env);
    const resubmitCount = existing ? (existing.resubmitCount || 0) + 1 : 0;

    // Determine which tier this submission is for based on intendedAmount
    const intendedAmount  = parseFloat(body.intendedAmount || 0);
    const intendedCurrency = (body.intendedCurrency || 'GMD').toUpperCase();
    let amountInGMD = intendedAmount;
    if (intendedCurrency === 'NGN')  amountInGMD = intendedAmount * 0.0806;
    if (intendedCurrency === 'USD')  amountInGMD = intendedAmount * 61.50;
    if (intendedCurrency === 'USDC') amountInGMD = intendedAmount * 61.73;
    const requestedTierInfo = getKycTier(amountInGMD);

    const kycData = {
      userId: user.id, userEmail: user.email,
      userName: `${user.firstName} ${user.lastName}`, userPhone: user.phone,
      docType, docNumber: docNumber || null, expiryDate: expiryDate || null,
      docFront, docBack: docBack || null, selfie,
      status: 'pending', submittedAt: new Date().toISOString(),
      reviewedAt: null, reviewedBy: null, rejectionReason: null, resubmitCount,
      // KYC tier fields
      requestedTierLevel:  requestedTierInfo.tier,
      requestedTierLabel:  requestedTierInfo.label,
      intendedAmount:      intendedAmount || null,
      intendedCurrency:    intendedCurrency,
      amountInGMD:         Math.round(amountInGMD),
    };

    await saveKyc(user.id, kycData, env);
    user.kycStatus = 'pending';
    await saveUser(user, env);

    const labels = { passport:'🛂 Passport', national_id:'🪪 National ID', resident_permit:'📋 Resident Permit', bank_statement:'🏦 Bank Statement' };
    await pushAdminNotif({ type:'kyc', title:'🪪 New KYC Submission',
      body:`${user.firstName} ${user.lastName} submitted ${labels[docType]||docType}.`,
      link:'/admin.html#kyc' }, env);

    await sendTelegram(
      `🪪 *New KYC Submission*\n\n👤 *Name:* ${user.firstName} ${user.lastName}\n📧 *Email:* ${user.email}\n📄 *Doc:* ${labels[docType]||docType}\n🏅 *Tier:* ${requestedTierInfo.icon} ${requestedTierInfo.label}\n💰 *Intended:* ${intendedAmount ? intendedAmount.toLocaleString() + ' ' + intendedCurrency : 'Not specified'}\n${expiryDate?`📅 *Date:* ${expiryDate}\n`:''}${resubmitCount>0?`♻️ *Resubmit #${resubmitCount}*\n`:''}\n🕐 ${new Date().toLocaleString('en-GB',{timeZone:'Africa/Banjul'})}`, env);

    await sendEmail({ to: user.email, subject: 'GamRemit — KYC Documents Received',
      html: kycEmailHtml({ firstName: user.firstName, status: 'pending' }) }, env);

    const { docFront:_f, docBack:_b, selfie:_s, ...safeKyc } = kycData;
    return jsonResponse({ success: true, kyc: safeKyc,
      message: 'KYC submitted. Our team will review within 24 hours.' }, 201);
  }

  // ── GET: user own KYC / admin all ─────────────────────────────
  if (request.method === 'GET') {
    if (claim.role === 'admin' && url.searchParams.get('all') === '1') {
      const all = await getAllKyc(env);
      const safe = all.map(({ docFront, docBack, selfie, ...r }) => r);
      return jsonResponse({ success: true, kycs: safe });
    }
    if (claim.role === 'admin' && isUserId) {
      const kyc = await getKyc(userId, env);
      if (!kyc) return jsonResponse({ error: 'KYC not found' }, 404);
      return jsonResponse({ success: true, kyc });
    }
    const user = await getUser(claim.email, env);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    const kyc = await getKyc(user.id, env);
    if (!kyc) return jsonResponse({ success: true, kyc: null });
    const { docFront:_f, docBack:_b, selfie:_s, ...safeKyc } = kyc;
    return jsonResponse({ success: true, kyc: safeKyc });
  }

  // ── PATCH: admin approve / reject ─────────────────────────────
  if (request.method === 'PATCH' && isUserId) {
    if (claim.role !== 'admin') return jsonResponse({ error: 'Admin only' }, 403);

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const { status, rejectionReason } = body;

    if (!['approved','rejected'].includes(status))
      return jsonResponse({ error: "status must be 'approved' or 'rejected'" }, 400);
    if (status === 'rejected' && !rejectionReason?.trim())
      return jsonResponse({ error: 'Rejection reason required' }, 400);

    const kyc = await getKyc(userId, env);
    if (!kyc) return jsonResponse({ error: 'KYC not found' }, 404);

    // Read submitted tier level from KYC data (set during submission)
    const approvedTierLevel = body.tierLevel !== undefined
      ? parseInt(body.tierLevel)
      : (kyc.requestedTierLevel || 0);

    const updated = { ...kyc, status,
      rejectionReason: status==='rejected' ? rejectionReason.trim() : null,
      reviewedAt: new Date().toISOString(), reviewedBy: claim.email,
      approvedTierLevel: status === 'approved' ? approvedTierLevel : null };
    await saveKyc(userId, updated, env);

    const user = await getUser(kyc.userEmail, env);
    if (user) {
      user.kycStatus = status;
      user.status = status === 'approved' ? 'active' : 'pending';
      // Store the approved KYC tier level on the user record
      if (status === 'approved') {
        user.kycTierLevel = approvedTierLevel;
        user.kycTierLabel = getKycTierByLevel(approvedTierLevel)?.label || 'Basic';
        user.kycTierApprovedAt = new Date().toISOString();
      }
      await saveUser(user, env);

      await addNotif(user.id, {
        type: status==='approved'?'success':'error',
        title: status==='approved'?'✅ KYC Approved!':'❌ KYC Rejected',
        body: status==='approved'
          ? 'Your identity verified. Account is now active!'
          : `KYC not approved. Reason: ${rejectionReason}. Please resubmit.`,
        link: status==='approved'?'/app.html':'/kyc.html'
      }, env);

      await sendTelegram(
        `${status==='approved'?'✅':'❌'} *KYC ${status.toUpperCase()}*\n👤 ${user.firstName} ${user.lastName} (${user.email})\n📄 ${kyc.docType.replace('_',' ')}${status==='rejected'?`\n❗ Reason: ${rejectionReason}`:''}`, env);

      await sendEmail({ to: user.email,
        subject: `GamRemit — KYC ${status==='approved'?'Approved ✅':'Rejected ❌'}`,
        html: kycEmailHtml({ firstName: user.firstName, status, reason: rejectionReason }) }, env);
    }

    const { docFront:_f, docBack:_b, selfie:_s, ...safeKyc } = updated;
    return jsonResponse({ success: true, kyc: safeKyc });
  }

  // ── GET /api/kyc/tiers — return all KYC tier definitions ────────
  if (request.method === 'GET' && url.pathname.endsWith('/tiers')) {
    return jsonResponse({ success: true, tiers: KYC_TIERS });
  }

  // ── GET /api/kyc/check?amount=5000&currency=GMD — check required tier ──
  if (request.method === 'GET' && url.searchParams.get('amount')) {
    const amount   = parseFloat(url.searchParams.get('amount')) || 0;
    const currency = (url.searchParams.get('currency') || 'GMD').toUpperCase();

    let amountInGMD = amount;
    if (currency === 'NGN')  amountInGMD = amount * 0.0806;
    if (currency === 'USD')  amountInGMD = amount * 61.50;
    if (currency === 'USDC') amountInGMD = amount * 61.73;

    const requiredTier = getKycTier(amountInGMD);
    const user = claim ? await getUser(claim.email, env) : null;
    const userTierLevel = user?.kycTierLevel || 0;
    const sufficient = user?.kycStatus === 'approved' && userTierLevel >= requiredTier.tier;

    return jsonResponse({
      success: true,
      amountInGMD: Math.round(amountInGMD),
      requiredTier,
      userTierLevel,
      sufficient,
      allTiers: KYC_TIERS,
    });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
