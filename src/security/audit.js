import crypto from 'node:crypto';
import fs from 'node:fs';

// Tamper-resistant HMAC chained audit logger
// ponytail: local append-only hash-chained file; upgrade to WORM storage or SIEM webhook when required
export class TamperResistantAuditLogger {
  constructor(filePath, hmacSecret = 'default-secret-change-me') {
    this.filePath = filePath;
    this.hmacSecret = hmacSecret;
    this.lastHash = 'GENESIS_BLOCK';
    this.entries = [];
  }

  log(actorId, action, details = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      actorId,
      action,
      details,
      prevHash: this.lastHash
    };

    const signature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(record))
      .digest('hex');

    const securedEntry = { ...record, signature };
    this.lastHash = signature;
    this.entries.push(securedEntry);

    if (this.filePath) {
      fs.appendFileSync(this.filePath, JSON.stringify(securedEntry) + '\n', 'utf-8');
    }

    return securedEntry;
  }

  verifyChain(fileContent = null) {
    const rawLines = fileContent
      ? fileContent.trim().split('\n').filter(Boolean)
      : this.entries.map(e => JSON.stringify(e));

    let prevHash = 'GENESIS_BLOCK';
    for (let i = 0; i < rawLines.length; i++) {
      const parsed = typeof rawLines[i] === 'string' ? JSON.parse(rawLines[i]) : rawLines[i];
      const { signature, ...recordBody } = parsed;

      if (recordBody.prevHash !== prevHash) {
        return { valid: false, brokenIndex: i, reason: 'prev_hash_mismatch' };
      }

      const expectedSig = crypto
        .createHmac('sha256', this.hmacSecret)
        .update(JSON.stringify(recordBody))
        .digest('hex');

      if (signature !== expectedSig) {
        return { valid: false, brokenIndex: i, reason: 'invalid_signature' };
      }

      prevHash = signature;
    }

    return { valid: true, count: rawLines.length };
  }
}
