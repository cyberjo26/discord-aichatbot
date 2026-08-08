import { PermissionFlagsBits } from 'discord.js';
import { scrapeUrl } from '../rag/scraper.js';
import { chatCompletion } from '../ai/openrouter.js';
import logger from '../utils/logger.js';

// ─── Summarize ─────────────────────────────────────────────────────
export async function execSummarize(message, params, plan) {
  const url = params.url;
  const text = params.text || plan.rawQuery;

  await message.channel.sendTyping();

  try {
    let contentToSummarize;
    let systemPrompt;

    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      const scraped = await scrapeUrl(url);
      if (!scraped) return { success: false, error: 'Gagal ambil konten dari URL' };
      contentToSummarize = scraped;
      systemPrompt = 'Ringkas konten berikut dalam 3-5 poin utama. Plain text, bullet points.';
    } else if (text) {
      contentToSummarize = text;
      systemPrompt = 'Ringkas teks berikut secara singkat dan jelas. Plain text.';
    } else {
      return { success: false, error: 'Tidak ada teks/URL untuk diringkas' };
    }

    const summary = await chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Ringkas:\n\n${contentToSummarize.slice(0, 6000)}` },
    ]);
    await message.reply(`📋 **Ringkasan:**\n\n${summary.slice(0, 1900)}`);
    return { success: true, type: 'summarize', replied: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Summarize Channel ──────────────────────────────────────────────
export async function execSummarizeChannel(message, params, _plan) {
  const guild = message.guild;
  if (!guild) return { success: false, error: 'Bukan di server' };

  // Check if bot can read message history
  const botPerms = message.channel.permissionsFor(guild.members.me);
  if (!botPerms || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
    return { success: false, error: 'Bot tidak punya permission ReadMessageHistory di channel ini. Aktifkan permission tersebut agar bot bisa membaca riwayat pesan.' };
  }

  const count = Math.min(Math.max(params.count || 50, 10), 100);

  await message.channel.sendTyping();

  try {
    const messages = await message.channel.messages.fetch({ limit: count, before: message.id });
    if (messages.size === 0) {
      return { success: false, error: 'Tidak ada pesan yang bisa diringkas.' };
    }

    // Build conversation text from messages (oldest first)
    const sorted = [...messages.values()].reverse();
    const conversationLines = sorted
      .filter(m => !m.author.bot && m.content?.trim())
      .map(m => {
        const time = m.createdAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${m.author.username}: ${m.content.slice(0, 300)}`;
      });

    if (conversationLines.length === 0) {
      return { success: false, error: 'Tidak ada pesan teks dari user yang bisa diringkas.' };
    }

    const conversationText = conversationLines.join('\n');

    const summary = await chatCompletion([
      {
        role: 'system',
        content: `Ringkas percakapan Discord berikut menjadi poin-poin utama yang mudah dipahami.
ATURAN:
- Buat ringkasan dalam 3-7 poin utama
- Sebutkan topik yang dibahas dan siapa yang membahasnya
- Gunakan bahasa Indonesia
- Gunakan bullet points
- Fokus pada informasi penting, keputusan, dan diskusi kunci
- Jika ada kesimpulan atau keputusan, highlight itu`
      },
      { role: 'user', content: `Ringkas percakapan berikut (${conversationLines.length} pesan):\n\n${conversationText.slice(0, 6000)}` },
    ]);

    await message.reply(`📋 **Ringkasan ${conversationLines.length} pesan terakhir di #${message.channel.name}:**\n\n${summary.slice(0, 1900)}`);
    return { success: true, type: 'summarize_channel', replied: true };
  } catch (err) {
    logger.error(`Summarize channel error: ${err.message}`);
    return { success: false, error: `Gagal membaca riwayat pesan: ${err.message}` };
  }
}
