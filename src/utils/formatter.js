import { EmbedBuilder } from 'discord.js';
import config from '../config.js';

const COLORS = {
  primary: 0x5865f2,   // Discord blurple
  success: 0x57f287,   // Green
  warning: 0xfee75c,   // Yellow
  error: 0xed4245,     // Red
  voice: 0xe91e63,     // Pink - voice mode
  info: 0x5865f2,      // Blue
  rag: 0x00d4aa,       // Teal - RAG results
};

/**
 * Build a thinking/loading embed
 */
export function buildThinkingEmbed(query) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setDescription('⏳ **Sedang berpikir...**\nMencari informasi dan menyusun jawaban.')
    .setFooter({ text: `Pertanyaan: ${truncate(query, 100)}` })
    .setTimestamp();
}

/**
 * Build the main answer embed for /ask (RAG mode)
 */
export function buildAnswerEmbed({ query, answer, sources = [], mode = 'text' }) {
  const modeIcon = mode === 'voice' ? '🔊' : '📝';
  const embed = new EmbedBuilder()
    .setColor(mode === 'voice' ? COLORS.voice : COLORS.rag)
    .setTitle(`${modeIcon} ${truncate(query, 200)}`)
    .setDescription(truncate(answer, 4000))
    .setTimestamp()
    .setFooter({ text: `${config.botName} • Mode: ${mode === 'voice' ? 'Voice' : 'Text'}` });

  if (sources.length > 0) {
    const sourceText = sources
      .slice(0, 5)
      .map((s, i) => `${i + 1}. [${truncate(s.title, 60)}](${s.url})`)
      .join('\n');
    embed.addFields({ name: '📚 Sumber Referensi', value: truncate(sourceText, 1024) });
  }

  return embed;
}

/**
 * Build embed for /chat
 */
export function buildChatEmbed({ answer, mode = 'text' }) {
  const modeIcon = mode === 'voice' ? '🔊' : '💬';
  return new EmbedBuilder()
    .setColor(mode === 'voice' ? COLORS.voice : COLORS.primary)
    .setDescription(`${modeIcon} ${truncate(answer, 4000)}`)
    .setTimestamp()
    .setFooter({ text: `${config.botName} • Chat` });
}

/**
 * Build embed for /summarize
 */
export function buildSummaryEmbed({ url, summary }) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📋 Ringkasan')
    .setDescription(truncate(summary, 4000))
    .addFields({ name: '🔗 Sumber', value: url })
    .setTimestamp()
    .setFooter({ text: `${config.botName} • Summarize` });
}

/**
 * Build error embed
 */
export function buildErrorEmbed(message) {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('❌ Terjadi Kesalahan')
    .setDescription(message)
    .setTimestamp()
    .setFooter({ text: config.botName });
}

/**
 * Build help embed
 */
export function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🤖 ${config.botName} — Panduan`)
    .setDescription(
      `Hai! Aku **${config.botName}**, asisten digital yang bisa mencari informasi dari web dan menjawab pertanyaanmu dengan sumber terpercaya.`
    )
    .addFields(
      {
        name: '🔍 /ask <pertanyaan> [mode]',
        value:
          'Tanya apapun! Aku jawab langsung, lalu kamu bisa klik **📚 Tambahkan Sumber Artikel** untuk cari referensi web.\n' +
          '• `mode:text` — jawaban teks (default)\n' +
          '• `mode:voice` — aku jawab lewat voice channel!',
      },
      {
        name: '💬 /chat <pesan> [mode]',
        value:
          'Ngobrol langsung tanpa pencarian web. Aku ingat 10 pesan terakhirmu.\n' +
          '• `mode:text` — jawaban teks (default)\n' +
          '• `mode:voice` — aku jawab lewat voice channel!',
      },
      {
        name: '📋 /summarize <url>',
        value: 'Kirim URL artikel, aku ringkaskan isinya untukmu.',
      },
      {
        name: '❓ /help',
        value: 'Tampilkan panduan ini.',
      },
      {
        name: '🔊 Mode Voice',
        value:
          'Saat mode voice, aku akan join voice channel-mu dan **berbicara langsung** menjawab pertanyaanmu. ' +
          'Jawaban lengkap tetap ditampilkan di text channel.',
      }
    )
    .setFooter({ text: `${config.botName} • Powered by OpenRouter & Edge TTS` })
    .setTimestamp();
}

/**
 * Truncate text to max length
 */
function truncate(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export { truncate, COLORS };
