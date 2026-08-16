<div align="center">

# ⚡ PC Monitor & Security Optimizer

[![CI / Security Audit](https://github.com/cyberjo26/discord-aichatbot/actions/workflows/security.yml/badge.svg)](https://github.com/cyberjo26/discord-aichatbot/actions)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/cyberjo26/discord-aichatbot/pulls)

**Lightweight, non-intrusive system performance diagnostic engine & enterprise-grade security architecture.**

[Features](#-core-features) • [Security Suite](#-security-architecture) • [Getting Started](#-getting-started) • [Incident Playbook](#-incident-response) • [Testing](#-testing)

---

</div>

## 🚀 Core Features

### 1. Intelligent Folder Analysis & Quarantine
- **Duplicate Detection**: Merkle tree sampled SHA-256 fingerprinting.
- **Corrupt & Stale Identification**: Detects unreadable files and directories stale for 60/90 days.
- **Custom Ignore Patterns**: Built-in cache filters (`node_modules`, `.git`, `.vscode`) plus `.pcmonignore` support.
- **30-Day Safe Quarantine**: Move files to quarantine with 1-click restore or automated 30-day purge.

### 2. Automated RAM Optimization Scheduler
- **Adaptive Scheduling**: Configurable intervals (15m, 1h, 2h, custom).
- **Smart Deferral**: Automatically pauses during fullscreen gaming, presentations (`SHQueryUserNotificationState`), or high CPU usage (>25%).
- **Native Windows System Tray**: Context menu with instant optimization and web dashboard launcher.

### 3. Real-Time Performance Diagnostics
- **Launch Baseline Profiler**: Flags slow application startups (>2x historical median).
- **Multi-Factor Slowdown Analysis**: Correlates RAM exhaustion, CPU bottlenecks, and disk load.
- **Behavioral Scanner**: Detects suspicious script host execution (PowerShell/CMD from temporary paths).

---

## 🛡️ Security Architecture

Hardened defense layers implemented following zero-trust principles:

| Module | Defense Mechanism | Attack Vector Mitigation |
| :--- | :--- | :--- |
| `src/security/config.js` | Strict runtime environment secret validation | Credential leakage |
| `src/security/rotation.js` | Automated token rotation & manual override via `SIGHUP` | Credential leakage, Social engineering |
| `src/security/validator.js` | Ed25519 webhook signature validation & sliding rate limiter | Spoofing, Denial of Service |
| `src/security/audit.js` | HMAC-SHA256 hash-chained tamper-resistant audit logs | Tampering, Unauthorized admin actions |
| `src/security/intents.js` | Least-privilege intent bitmask & OAuth2 permission limits | Excessive privilege abuse |
| `.github/workflows/` | Daily automated vulnerability auditing via Dependabot | Supply chain & dependency exploits |

---

## 📦 Getting Started

### Prerequisites
- **OS**: Windows 10 / 11
- **Runtime**: Node.js `>= 22.12.0`

### Installation

```bash
# Clone the repository
git clone https://github.com/cyberjo26/discord-aichatbot.git
cd discord-aichatbot

# Install dependencies
npm install
```

### Configuration

Copy `.env.example` to `.env` and provide your secrets:

```env
DISCORD_TOKEN=your_secure_discord_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_PUBLIC_KEY=your_public_key_here
AUDIT_HMAC_SECRET=your_hmac_secret_here
```

### Running the Engine

```bash
npm start
```
- Starts daemon engine and system tray integration.
- Dashboard available at: `http://127.0.0.1:3899`

---

## 🚨 Incident Response

Refer to [`COMPROMISE_RESPONSE.md`](COMPROMISE_RESPONSE.md) for standard operating procedures during suspected security incidents:
1. **0–5 min**: Immediate token revocation and process termination.
2. **5–15 min**: Credential & secret rotation across dependent services.
3. **15–45 min**: Audit log forensic preservation and git integrity check.
4. **1–24 hr**: Guild notification, least-privilege verification, and post-mortem.

---

## 🧪 Testing

Execute the test suite (17/17 tests covering unit, diagnostics, and security modules):

```bash
npm test
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
