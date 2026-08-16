import EventEmitter from 'node:events';

// ponytail: in-process rotation event coordinator; replace with IPC/Redis bus if clustered
export class TokenRotationManager extends EventEmitter {
  constructor(initialToken) {
    super();
    this.currentToken = initialToken;
    this.history = [];
    this.scheduleTimer = null;
  }

  getCurrentToken() {
    return this.currentToken;
  }

  rotate(newToken, reason = 'scheduled_rotation') {
    if (!newToken || typeof newToken !== 'string' || newToken.trim().length < 20) {
      throw new Error('Invalid new token for rotation');
    }
    const previousToken = this.currentToken;
    this.currentToken = newToken.trim();
    this.history.push({
      timestamp: new Date().toISOString(),
      reason,
      rotatedAt: Date.now()
    });
    this.emit('rotated', { previousToken, newToken: this.currentToken, reason });
    return true;
  }

  emergencyOverride(newToken) {
    return this.rotate(newToken, 'emergency_manual_override');
  }

  scheduleRotation(intervalMs, tokenProviderFn) {
    this.stopScheduledRotation();
    if (!intervalMs || intervalMs <= 0) return;
    this.scheduleTimer = setInterval(async () => {
      try {
        const next = await tokenProviderFn();
        if (next) this.rotate(next, 'auto_scheduled');
      } catch (err) {
        this.emit('rotation_error', err);
      }
    }, intervalMs);
    if (this.scheduleTimer.unref) this.scheduleTimer.unref();
  }

  stopScheduledRotation() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }
}
