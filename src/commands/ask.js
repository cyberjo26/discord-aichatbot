import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { ragPipeline } from '../rag/pipeline.js';
import { buildAnswerEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { buildStyleInstruction } from '../utils/user-prefs.js';
import { handleVoiceResponse } from '../utils/voice-response.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Tanya apapun — aku jawab dulu, lalu kamu bisa minta sumber artikel.')
  .addStringOption((opt) =>
    opt
      .setName('pertanyaan')
      .setDescription('Pertanyaan yang ingin kamu tanyakan')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('mode')
      .setDescription('Mode jawaban: text atau voice')
      .addChoices(
        { name: '📝 Text', value: 'text' },
        { name: '🔊 Voice', value: 'voice' }
      )
  );

export async function execute(interaction) {
  const query = interaction.options.getString('pertanyaan');
  const mode = interaction.options.getString('mode') || 'text';

  logger.command(interaction.user.tag, 'ask', `"${query}" mode:${mode}`);

  await interaction.deferReply();

  try {
    // Build personalized system prompt with style instructions
    const styleInstruction = buildStyleInstruction(interaction.user.id);
    const systemPrompt = buildSystemPrompt(styleInstruction);

    // ── Step 1: Answer naturally (no web search) ──────────────────
    const answer = await chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ], { task: 'chat' });

    // Build embed (no sources yet)
    const embed = buildAnswerEmbed({ query, answer, sources: [], mode });

    // Build "add sources" button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rag_${interaction.id}`)
        .setLabel('📚 Tambahkan Sumber Artikel')
        .setStyle(ButtonStyle.Secondary)
    );

    const replyOptions = { embeds: [embed], components: [row] };

    // ── Step 2: Handle voice mode ─────────────────────────────────
    if (mode === 'voice') {
      try {
        await handleVoiceResponse(interaction.member, answer, interaction, replyOptions);
      } catch (voiceErr) {
        logger.error(`Voice error: ${voiceErr.message}`);
        replyOptions.content = '⚠️ *Voice gagal, menampilkan jawaban teks saja.*';
        await interaction.editReply(replyOptions);
      }
    } else {
      await interaction.editReply(replyOptions);
    }

    // ── Step 3: Wait for button click (60 seconds) ────────────────
    const message = await interaction.fetchReply();

    try {
      const btnInteraction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.customId === `rag_${interaction.id}`,
        time: 60_000, // 60 seconds to click
      });

      // User clicked "Tambahkan Sumber Artikel"
      await btnInteraction.deferUpdate();

      // Disable the button while loading
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rag_${interaction.id}`)
          .setLabel('⏳ Sedang mencari sumber...')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
      await interaction.editReply({ components: [disabledRow] });

      // Run RAG pipeline
      logger.info(`User requested RAG sources for: "${query}"`);
      const { answer: ragAnswer, sources } = await ragPipeline(query);

      // Update embed with RAG answer + sources
      const ragEmbed = buildAnswerEmbed({
        query,
        answer: ragAnswer,
        sources,
        mode,
      });

      // Remove button after RAG is done
      await interaction.editReply({ embeds: [ragEmbed], components: [] });
    } catch (collectErr) {
      // Timeout or error — remove the button quietly
      try {
        await interaction.editReply({ components: [] });
      } catch {
        // Message may have been deleted
      }
    }
  } catch (err) {
    logger.error(`/ask error: ${err.message}`);
    const errorEmbed = buildErrorEmbed(
      'Maaf, terjadi kesalahan saat memproses pertanyaanmu. Coba lagi nanti ya!'
    );
    await interaction.editReply({ embeds: [errorEmbed], components: [] });
  }
}
