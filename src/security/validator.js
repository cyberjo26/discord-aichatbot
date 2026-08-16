import crypto from 'node:crypto';

// Ed25519 webhook signature verifier
export function verifyDiscordSignature(rawBody, signature, timestamp, clientPublicKey) {
  if (!rawBody || !signature || !timestamp || !clientPublicKey) {
    return false;
  }
  try {
    const pubKeyDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(clientPublicKey, 'hex')
    ]);
    const keyObject = crypto.createPublicKey({
      key: pubKeyDer,
      format: 'der',
      type: 'spki'
    });

    const msg = Buffer.concat([
      Buffer.from(timestamp, 'utf-8'),
      Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf-8')
    ]);

    return crypto.verify(null, msg, keyObject, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// In-memory sliding window rate limiter
// ponytail: in-memory limiter; swap with Redis token bucket if sharded across containers
export class SecurityRateLimiter {
  constructor({ maxRequests = 10, windowMs = 60000, ipBlockList = [] } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.ipBlockList = new Set(ipBlockList);
    this.hits = new Map();
  }

  blockIp(ip) {
    this.ipBlockList.add(ip);
  }

  unblockIp(ip) {
    this.ipBlockList.delete(ip);
  }

  isIpBlocked(ip) {
    return this.ipBlockList.has(ip);
  }

  checkLimit(key, ip = null) {
    if (ip && this.isIpBlocked(ip)) {
      return { allowed: false, reason: 'ip_blocked', remaining: 0 };
    }

    const now = Date.now();
    const timestamps = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, reason: 'rate_limited', remaining: 0 };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      reason: 'ok',
      remaining: this.maxRequests - timestamps.length
    };
  }

  clear() {
    this.hits.clear();
  }
}
