// Developer-controlled wallet creation for GamRemit
export async function createDevWallet(userId, env) {
  const apiKey = env.CIRCLE_USER_API_KEY;
  const entitySecret = env.CIRCLE_ENTITY_SECRET;
  const walletSetId = env.CIRCLE_WALLET_SET_ID;
  if (!apiKey || !entitySecret || !walletSetId) return {};
  try {
    const pubKeyRes = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const pubKeyData = await pubKeyRes.json();
    const pubKeyPem = pubKeyData?.data?.publicKey;
    if (!pubKeyPem) return {};
    const pemBody = pubKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, '');
    const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey('spki', binaryDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const secretBytes = Uint8Array.from(entitySecret.match(/.{2}/g).map(b => parseInt(b, 16)));
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, secretBytes);
    const ciphertext = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    const res = await fetch('https://api.circle.com/v1/w3s/developer/wallets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        entitySecretCiphertext: ciphertext,
        wallets: [{ refId: userId, description: `GamRemit ${userId}`, count: 1 }],
        walletSetId,
        blockchains: ['ARB-SEPOLIA']
      })
    });
    const data = await res.json();
    const wallet = data?.data?.wallets?.[0];
    if (!wallet) return {};
    return { walletId: wallet.id, walletAddress: wallet.address };
  } catch (e) {
    console.error('[circle:dev-wallet]', e.message);
    return {};
  }
}
