// ponytail: basic env loader with validation; replace with vault/cloud KMS if multi-instance secrets sync needed
export function loadSecurityConfig() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || typeof token !== 'string' || token.trim().length < 20) {
    throw new Error('FATAL: DISCORD_TOKEN is missing or invalid');
  }

  return Object.freeze({
    discordToken: token.trim(),
    clientId: process.env.DISCORD_CLIENT_ID || null,
    clientPublicKey: process.env.DISCORD_PUBLIC_KEY || null,
    auditSecret: process.env.AUDIT_HMAC_SECRET || 'default-audit-secret-key-change-in-prod'
  });
}
