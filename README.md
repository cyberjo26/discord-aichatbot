# 🤖 Discord Bot dengan RAG, Voice, & Hybrid Self-Learning

Bot Discord AI multifungsi yang terasa "hidup" — bisa menjawab dari pencarian web (RAG), berbicara langsung di voice channel, mempelajari instruksi baru secara otomatis (Self-Learning), serta memiliki modul utilitas lengkap (Cuaca realtime, Ping koneksi, & Link Undang Bot).

---

## ✨ Fitur Utama

| Fitur | Deskripsi | Cara Panggilan |
|---|---|---|
| 🔍 **RAG Search** | Mencari informasi dari web dan menjawab dengan sumber terpercaya. | `/ask <tanya>` atau `!ask <tanya>` |
| 💬 **Chat Memory** | Ngobrol langsung secara natural. Bot mengingat 10 pesan terakhir. | `/chat <pesan>` atau `!chat <pesan>` |
| 🔊 **Voice Mode** | Bot masuk ke voice channel dan berbicara langsung membacakan jawaban. | Pilihan mode: `Voice` di slash command, atau `!ask-voice` / `!chat-voice` |
| 📋 **Summarize URL** | Meringkas artikel lengkap secara otomatis langsung dari link URL. | `/summarize <url>` atau `!summarize <url>` |
| 🧠 **Hybrid Self-Learning** | AI mengekstrak pola perintah baru saat user memberikan penjelasan (`UPDATE`). | Otomatis diaktifkan jika AI bingung |
| 🌦️ **Real-time Weather** | Menampilkan info cuaca kota/negara di seluruh dunia via Open-Meteo. | `/weather` atau `!weather <lokasi>` |
| 🏓 **Ping Latency** | Menguji latensi bot ke Discord Gateway dan Google HTTP response. | `/ping` atau `!ping` |
| 🤖 **Invite Link** | Membuat tautan undangan OAuth2 bot instan dengan tombol interaktif. | `/invite` atau `!invite` |
| 🔀 **Multi-provider AI** | Load-balancing & Failover otomatis: OpenRouter, Gemini, Groq, Cerebras. | Otomatis |

---

## 🧠 Fitur Unggulan: Hybrid Self-Learning Pattern
Bot dilengkapi dengan **Self-Learning Pattern System** cerdas yang bekerja dalam 3 lapis perlindungan (*Triple Fallback*) tanpa membebani CPU, RAM, atau GPU lokal:

```
[Pesan Masuk] 
      │
      ├───► (Layer 1) Gemini Embedding API (Pencarian Semantik)
      │     Matches synonyms (e.g. "sematkan" matches "pin message").
      │     [Jika API Gagal / Limit]
      │
      ├───► (Layer 2) Local TF-IDF Vectorizer (Pencarian Kata Kunci Offline)
      │     Matches keywords in memory in under 1ms.
      │     [Jika Tidak Ada Pola Cocok]
      │
      └───► (Layer 3) Emergency LLM Router Fallback
            Injects all patterns into the prompt to let the router model analyze directly.
```

### Cara Kerja Pembelajaran:
1. Ketika AI tidak memahami pesan Anda, bot akan merespons dengan **"Ask Clarification"**.
2. Berikan penjelasan maksud Anda secara langsung di chat (tanpa tag/mention bot).
3. Setelah selesai menjelaskan, ketik **`UPDATE`**.
4. AI akan mengekstrak data tersebut menjadi JSON, menyimpannya di `/data/learned-patterns.json`, dan secara otomatis melakukan **background backfill embedding** untuk pencarian semantik berikutnya.

---

## 🚀 Panduan Setup & Instalasi

### 1. Prasyarat & API Keys
Siapkan API Key berikut di file konfigurasi:
* **Discord Bot Token**: Buat aplikasi di [Discord Developer Portal](https://discord.com/developers/applications). Aktifkan `Server Members Intent` dan `Message Content Intent` pada tab **Bot**.
* **Gemini API Key** (*Sangat Direkomendasikan*): Gratis dari [Google AI Studio](https://aistudio.google.com/app/apikey). Digunakan untuk semantic search pattern (Embeddings) dan failover LLM.
* **OpenRouter API Key** (*Opsional*): Buat key di [OpenRouter](https://openrouter.ai/).
* **Groq / Cerebras API Keys** (*Opsional*): Untuk pilihan load balancing tambahan.

### 2. Jalankan Project

```bash
# 1. Clone atau download repositori ini
cd discord-ai-bot

# 2. Install library pendukung
npm install

# 3. Salin file environment variables
cp .env.example .env
```

Buka dan isi `.env` sesuai kredensial Anda:
```env
DISCORD_TOKEN=your_token_here
DISCORD_CLIENT_ID=your_client_id_here
GUILD_ID=your_development_guild_id_here
GEMINI_API_KEY=your_gemini_key_here
AI_PROVIDER_ORDER=gemini,openrouter,groq
```

### 3. Deploy & Jalankan
```bash
# Daftarkan slash commands ke server Discord (instan untuk server pengembangan)
npm run deploy-commands

# Jalankan bot dalam mode produksi
npm start

# Atau jalankan dalam mode pengembangan (auto-restart)
npm run dev
```

---

## 📝 Panduan Perintah

### Slash Commands & Prefix Commands

| Slash Command | Prefix Command | Deskripsi / Argumen |
|---|---|---|
| `/ask` | `!ask <pertanyaan>` | Tanya AI + pencarian web (RAG) |
| `/chat` | `!chat <pesan>` | Ngobrol biasa dengan ingatan percakapan |
| `/summarize` | `!summarize <url>` | Meringkas artikel dari URL |
| `/ping` | `!ping` | Melihat latensi Discord dan Google |
| `/weather` | `!weather <lokasi>` | Cek cuaca realtime kota/negara |
| `/invite` | `!invite` | Mendapatkan link undang bot |
| `/help` | `!help` | Menampilkan bantuan perintah |

> **Mode Voice**: Di Slash Command terdapat opsi mode `Text` atau `Voice`. Di Prefix Command, tambahkan akhiran `-voice` seperti `!ask-voice <tanya>` atau `!chat-voice <pesan>` untuk membuat bot masuk ke channel suara Anda.

---

## ⚙️ Konfigurasi Lanjutan (.env)

| Kunci Konfigurasi | Nilai Bawaan | Deskripsi |
|---|---|---|
| `AI_PROVIDER_ORDER` | `openrouter,gemini` | Urutan fallback penyedia LLM |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Model default untuk Gemini |
| `TTS_VOICE` | `id-ID-ArdiNeural` | Pengisi suara TTS (GadisNeural untuk perempuan) |
| `TTS_RATE` | `+0%` | Kecepatan berbicara bot di voice |
| `TTS_PITCH` | `+0Hz` | Pitch suara TTS |
| `TIMEZONE` | `Asia/Jakarta` | Zona waktu reminder (format IANA) |
| `DATABASE_PATH` | `./data/voice-reminders.db` | Lokasi SQLite reminder; arahkan ke persistent volume saat deploy |
| `LOG_LEVEL` | `info` | Level log (debug, info, warn, error) |

---

## Deployment SQLite

Database dan tabel dibuat otomatis saat bot pertama kali hidup. Tidak perlu server SQLite,
username, password, atau migrasi manual. Gunakan satu replica bot dan pastikan folder
`data/` writable serta persisten. Untuk Docker, mount volume ke `/app/data`.

File JSON reminder lama akan diimpor sekali dari `LEGACY_REMINDERS_FILE`. Database SQLite,
file `-wal`, dan file `-shm` tidak boleh dimasukkan ke Git. Tutup bot secara normal sebelum
menyalin database untuk backup.

---

## 🏗️ Struktur Direktori Project

```
discord-ai-bot/
├── data/
│   └── learned-patterns.json  # Data pola pembelajaran (JSON + Embeddings)
├── src/
│   ├── index.js               # Titik masuk bot utama
│   ├── config.js              # Manajemen konfigurasi environment
│   ├── deploy-commands.js     # Registrasi Slash Command Discord
│   ├── ai/
│   │   ├── router.js          # Routing & Failover AI
│   │   ├── prompts.js         # Prompt instruksi AI & Kepribadian
│   │   └── providers/         # Integrasi API (Gemini, OpenRouter, Groq, dll)
│   ├── rag/
│   │   ├── pipeline.js        # Alur RAG (Pencarian + Scraping + AI)
│   │   ├── search.js          # DuckDuckGo & Tavily Search
│   │   └── scraper.js         # Pengambil konten web
│   ├── voice/
│   │   ├── tts.js             # Edge-TTS (Text-to-Speech)
│   │   └── player.js          # Pemutar audio di Voice Channel Discord
│   ├── commands/              # Modul Slash Commands
│   │   ├── ask.js, chat.js, summarize.js, help.js, admin.js
│   │   └── ping.js, weather.js, invite.js  [NEW]
│   └── utils/                 # Utilitas helper
│       ├── weather.js         # API integrator Open-Meteo [NEW]
│       ├── learned-patterns.js# Sistem pembelajaran (Embeddings + TF-IDF) [NEW]
│       ├── formatter.js       # Format tampilan Discord Embed
│       ├── memory.js          # Manajemen memori chat per user
│       └── logger.js          # Logger konsol informatif
└── package.json               # Dependensi proyek
```

---

## ❓ Pertanyaan Umum (FAQ)

**Q: Mengapa bot saya tidak masuk ke voice channel?**
A: Pastikan bot memiliki hak akses *Connect* dan *Speak* pada kategori/channel suara yang Anda tempati di server Discord.

**Q: Apakah model cuaca Open-Meteo berbayar?**
A: Tidak. Open-Meteo sepenuhnya gratis untuk penggunaan non-komersial dan tidak membutuhkan pendaftaran ataupun kunci API sama sekali.

**Q: Bagaimana jika Gemini API saya terkena batasan gratis (quota limit)?**
A: Bot secara otomatis mendeteksi kegagalan tersebut dan mengaktifkan sirkuit pengaman (*circuit breaker*), lalu beralih (*failover*) ke provider aktif berikutnya seperti OpenRouter atau Groq yang telah Anda konfigurasi di `.env`.
