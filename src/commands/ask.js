import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { freshAnswer } from '../ai/fresh.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { ragPipeline } from '../rag/pipeline.js';
import { buildAnswerEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { buildStyleInstruction } from '../utils/user-prefs.js';
import { isQuiet, setQuiet, detectQuietIntent, buildMemoryInjection, extractFacts } from '../utils/user-memory.js';
import { isOwner } from '../utils/permissions.js';
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
    // Per-user quiet gate: muted users get silence. Only a short explicit
    // directive toggles state — a real question mentioning "diam" must not.
    const quietIntent = query.trim().length <= 40 ? detectQuietIntent(query) : null;
    if (quietIntent === 'quiet' && !isOwner(interaction.user.id)) {
      setQuiet(interaction.user.id, true);
      await interaction.editReply({ content: 'Oke, diam. 🙂' });
      return;
    }
    if (quietIntent === 'unquiet' && isQuiet(interaction.user.id)) {
      setQuiet(interaction.user.id, false);
      await interaction.editReply({ content: 'Oke, gue ngomong lagi! 🗣️' });
      return;
    }
    if (isQuiet(interaction.user.id)) {
      await interaction.editReply({ content: '🤫' });
      return;
    }

    // Freshness check: questions beyond the model's knowledge cutoff get the
    // live-web pipeline (Find → Compare → Select → Connect → Conclude).
    // Evergreen questions fall through to the model's internal knowledge.
    const fresh = await freshAnswer(query);
    if (fresh.usedFreshData) {
      const embed = buildAnswerEmbed({ query, answer: fresh.answer, sources: fresh.sources, mode });
      const replyOptions = { embeds: [embed] };

      if (mode === 'voice') {
        try {
          await handleVoiceResponse(interaction.member, fresh.answer, interaction, replyOptions);
        } catch (voiceErr) {
          logger.error(`Voice error: ${voiceErr.message}`);
          replyOptions.content = '⚠️ *Voice gagal, menampilkan jawaban teks saja.*';
          await interaction.editReply(replyOptions);
        }
      } else {
        await interaction.editReply(replyOptions);
      }
      return;
    }

    // Build personalized system prompt with style instructions
    const styleInstruction = buildStyleInstruction(interaction.user.id);
    const systemPrompt = buildSystemPrompt(styleInstruction, buildMemoryInjection(interaction.user.id, query));

    // ── Step 1: Answer naturally (no web search) ──────────────────
    const answer = await chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ], { task: 'chat' });

    // Passive learning — fire-and-forget, never blocks the reply.
    void extractFacts(interaction.user.id, [{ role: 'user', content: query }, { role: 'assistant', content: answer }]).catch(() => {});

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
    // Fire-and-forget: execute() must resolve once the answer is delivered,
    // otherwise the interaction handler's global rate-limit token is held
    // for the whole 60 s idle button wait (50 such waits lock out the bot).
    const message = await interaction.fetchReply();
    void watchArticleButton(interaction, message, query, mode).catch(() => {});
  } catch (err) {
    logger.error(`/ask error: ${err.message}`);
    const errorEmbed = buildErrorEmbed(
      'Maaf, terjadi kesalahan saat memproses pertanyaanmu. Coba lagi nanti ya!'
    );
    await interaction.editReply({ embeds: [errorEmbed], components: [] });
  }
}

/**
 * Detached button watcher: waits up to 60 s for the "add sources" click and
 * runs the RAG pipeline if it comes. Runs after execute() has resolved, so
 * it never holds the command's rate-limit token.
 */
async function watchArticleButton(interaction, message, query, mode) {
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
}
