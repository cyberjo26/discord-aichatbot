# Incident Response Playbook: Bot Compromise

## Phase 1: Containment (0–5 min)
1. **Revoke Token:** Discord Developer Portal -> Bot Application -> Reset Token.
2. **Kill Processes:**
   ```bash
   pkill -f "node" || taskkill /F /IM node.exe
   ```
3. **Invalidate Env Variables:** Clear `DISCORD_TOKEN` on host/cloud runners immediately.

## Phase 2: Key & Secret Rotation (5–15 min)
1. Rotate Discord Client Secret & Public Key.
2. Rotate third-party API keys (AI providers, webhooks, databases).
3. Update `.env` or secrets vault with new tokens.

## Phase 3: Forensic Preservation (15–45 min)
1. Export tamper-resistant audit logs (`audit.log`).
2. Run integrity scan on git history:
   ```bash
   git log -S "DISCORD_TOKEN" --oneline
   ```
3. Check `npm audit` for supply chain tampering.

## Phase 4: Notification & Remediation (1–24 hr)
1. Inform server administrators of affected guilds.
2. Verify and enforce least-privilege gateway intents and OAuth2 scopes.
3. Publish post-mortem report.
