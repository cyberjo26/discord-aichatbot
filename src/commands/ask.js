import {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { ragPipeline } from '../rag/pipeline.js';
import { condenseForVoice, synthesize } from '../voice/tts.js';
import { playInVoiceChannel, getMemberVoiceChannel } from '../voice/player.js';
import { buildAnswerEmbed, buildErrorEmbed } from '../utils/formatter.js';
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
    // ── Step 1: Answer naturally (no web search) ──────────────────
    const answer = await chatCompletion([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: query },
    ]);

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
      await handleVoiceResponse(interaction, answer, replyOptions);
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

/**
 * Handle voice response — condense, synthesize, and play/send audio
 */
async function handleVoiceResponse(interaction, answer, replyOptions) {
  try {
    const voiceText = await condenseForVoice(answer);
    logger.debug(`Voice text: "${voiceText}"`);

    const audioBuffer = await synthesize(voiceText);
    const voiceChannel = getMemberVoiceChannel(interaction.member);

    if (voiceChannel) {
      await interaction.editReply(replyOptions);
      await playInVoiceChannel(voiceChannel, audioBuffer);
    } else {
      const attachment = new AttachmentBuilder(audioBuffer, {
        name: 'bot-response.mp3',
        description: 'Jawaban voice dari bot',
      });
      replyOptions.files = [attachment];
      replyOptions.content =
        '🔊 *Kamu tidak sedang di voice channel, jadi aku kirim audionya di sini.*';
      await interaction.editReply(replyOptions);
    }
  } catch (voiceErr) {
    logger.error(`Voice error: ${voiceErr.message}`);
    replyOptions.content = '⚠️ *Voice gagal, menampilkan jawaban teks saja.*';
    await interaction.editReply(replyOptions);
  }
}
