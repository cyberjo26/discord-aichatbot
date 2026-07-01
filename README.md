# 🤖 Discord AI Bot (Voice, RAG, Self-Learning)

[🇮🇩 Bahasa Indonesia](#-bahasa-indonesia) | [🇬🇧 English](#-english)

---

## 🇮🇩 Bahasa Indonesia

Bot Discord AI multifungsi yang terasa "hidup". Dilengkapi dengan fitur pencarian web (RAG), mode suara (Voice), pembelajaran otomatis (Self-Learning), serta load-balancer AI dengan multi-provider.

### ✨ Fitur Utama
- **🔍 RAG Search** (`/ask`): Mencari informasi dari web dan menjawab dengan sumber terpercaya.
- **💬 Chat Memory** (`/chat`): Ngobrol natural, bot mengingat konteks percakapan terakhir.
- **🔊 Voice Mode**: Bot dapat masuk ke *voice channel* dan membacakan jawaban layaknya asisten pribadi.
- **🧠 Hybrid Self-Learning**: Bot otomatis belajar pola perintah baru jika pengguna memberikan penjelasan (`UPDATE`).
- **🔀 Multi-Provider AI**: Load-balancing & Failover otomatis ke berbagai API (OpenRouter, Gemini, Groq, Cerebras, Pollinations, Puter).
- **🛠️ Utilitas Tambahan**: Ringkas URL (`/summarize`), Status Cuaca (`/weather`), Latensi (`/ping`), dan Tautan Undangan (`/invite`).

### 🚀 Cara Menjalankan (Instalasi)
1. **Persiapan**: Clone repositori ini dan ketik `npm install`.
2. **Konfigurasi**: 
   - Salin file `.env.example` menjadi `.env`.
   - Isi `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, dan setidaknya salah satu kunci API AI (Gemini, Puter, OpenRouter, dll).
3. **Deploy Commands**: Jalankan `npm run deploy-commands` untuk mendaftarkan perintah garis miring (*slash commands*) ke server Discord kamu.
4. **Jalankan Bot**: 
   - Mode pengembangan: `npm run dev`
   - Mode produksi: `npm start`

> **Info Database**: Bot ini menggunakan SQLite lokal (dibuat otomatis di folder `data/`). Pastikan folder `data/` memiliki izin tulis (writable) dan bersifat persisten jika melakukan deployment ke *cloud* atau Docker.

---

## 🇬🇧 English

A multi-functional AI Discord Bot that feels "alive". It features web search integration (RAG), Voice channel capabilities, automatic self-learning, and an AI multi-provider load balancer.

### ✨ Key Features
- **🔍 RAG Search** (`/ask`): Searches the web to provide accurate, grounded answers.
- **💬 Chat Memory** (`/chat`): Natural conversations with short-term memory context.
- **🔊 Voice Mode**: The bot can join voice channels and speak its responses out loud like a virtual assistant.
- **🧠 Hybrid Self-Learning**: The bot learns new command patterns automatically when you explain what you meant.
- **🔀 Multi-Provider AI**: Automatic load-balancing & failover routing (OpenRouter, Gemini, Groq, Cerebras, Pollinations, Puter).
- **🛠️ Utilities**: URL Summarization (`/summarize`), Live Weather (`/weather`), Ping Latency (`/ping`), and Invite links (`/invite`).

### 🚀 How to Run (Installation)
1. **Setup**: Clone this repository and run `npm install`.
2. **Configuration**: 
   - Copy `.env.example` to `.env`.
   - Fill in your `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and at least one AI API key (Gemini, Puter, OpenRouter, etc.).
3. **Deploy Commands**: Run `npm run deploy-commands` to register the slash commands to your Discord server.
4. **Start the Bot**: 
   - Development mode: `npm run dev`
   - Production mode: `npm start`

> **Database Note**: The bot uses a local SQLite database (auto-generated inside the `data/` folder). Make sure the `data/` folder is persistent and writable if deploying via Docker or remote hosts.
