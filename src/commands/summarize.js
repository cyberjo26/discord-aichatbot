import { SlashCommandBuilder } from 'discord.js';
import { scrapeUrl } from '../rag/scraper.js';
import { chatCompletion } from '../ai/openrouter.js';
import { SUMMARIZE_PROMPT } from '../ai/prompts.js';
import { buildSummaryEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { isSafeUrl } from '../utils/security.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription('Ringkas isi dari sebuah URL artikel.')
  .addStringOption((opt) =>
    opt
      .setName('url')
      .setDescription('URL artikel yang ingin diringkas')
      .setRequired(true)
  );

export async function execute(interaction) {
  const url = interaction.options.getString('url');

  logger.command(interaction.user.tag, 'summarize', url);

  // URL validation to prevent SSRF
  if (!(await isSafeUrl(url))) {
    const errorEmbed = buildErrorEmbed('URL tidak valid atau dilarang (misalnya IP private/lokal).');
    return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }

  await interaction.deferReply();

  try {
    // Scrape the URL
    const content = await scrapeUrl(url);

    if (!content) {
      const errorEmbed = buildErrorEmbed(
        'Gagal mengambil konten dari URL tersebut. Pastikan URL valid dan bisa diakses.'
      );
      return interaction.editReply({ embeds: [errorEmbed] });
    }

    // Summarize with AI
    const summary = await chatCompletion([
      { role: 'system', content: SUMMARIZE_PROMPT },
      { role: 'user', content: `Ringkas konten berikut:\n\n${content}` },
    ]);

    const embed = buildSummaryEmbed({ url, summary });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error(`/summarize error: ${err.message}`);
    const errorEmbed = buildErrorEmbed(
      'Maaf, terjadi kesalahan saat meringkas artikel. Coba lagi nanti.'
    );
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}
