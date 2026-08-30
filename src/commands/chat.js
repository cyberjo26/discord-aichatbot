import { SlashCommandBuilder } from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { buildChatEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { getHistory, addMessage } from '../utils/memory.js';
import { buildStyleInstruction } from '../utils/user-prefs.js';
import { isQuiet, setQuiet, detectQuietIntent, buildMemoryInjection, extractFacts } from '../utils/user-memory.js';
import { isOwner } from '../utils/permissions.js';
import { handleVoiceResponse } from '../utils/voice-response.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('chat')
  .setDescription('Ngobrol langsung dengan AI — aku ingat 10 pesan terakhirmu.')
  .addStringOption((opt) =>
    opt
      .setName('pesan')
      .setDescription('Pesan yang ingin kamu kirim')
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
  const message = interaction.options.getString('pesan');
  const mode = interaction.options.getString('mode') || 'text';

  logger.command(interaction.user.tag, 'chat', `"${message}" mode:${mode}`);

  await interaction.deferReply();

  try {
    // Per-user quiet gate: muted users get silence. Only a short explicit
    // directive unmutes — a normal long message containing the word "diam"
    // (e.g. "gue diam aja deh") must not toggle state.
    const quietIntent = message.trim().length <= 40 ? detectQuietIntent(message) : null;
    if (quietIntent === 'quiet' && !isOwner(interaction.user.id)) {
      setQuiet(interaction.user.id, true);
      await interaction.editReply({ content: 'Oke, diam. 🙂', embeds: [] });
      return;
    }
    if (quietIntent === 'unquiet' && isQuiet(interaction.user.id)) {
      setQuiet(interaction.user.id, false);
      await interaction.editReply({ content: 'Oke, gue ngomong lagi! 🗣️', embeds: [] });
      return;
    }
    if (isQuiet(interaction.user.id)) {
      await interaction.editReply({ content: '🤫', embeds: [] });
      return;
    }

    // Get conversation history
    const history = getHistory(interaction.user.id);

    // Build personalized system prompt with style instructions
    const styleInstruction = buildStyleInstruction(interaction.user.id);
    const memoryInjection = buildMemoryInjection(interaction.user.id, message);
    const systemPrompt = buildSystemPrompt(styleInstruction, memoryInjection);

    // Build messages array — same 6-message window as !chat for consistent
    // context and token cost between the two entry points
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6),
      { role: 'user', content: message },
    ];

    // Get AI response
    const answer = await chatCompletion(messages, { task: 'chat' });

    // Save to memory
    addMessage(interaction.user.id, 'user', message);
    addMessage(interaction.user.id, 'assistant', answer);
    // Passive learning — fire-and-forget, never blocks the reply.
    void extractFacts(interaction.user.id, [{ role: 'user', content: message }, { role: 'assistant', content: answer }]).catch(() => {});

    // Build embed
    const embed = buildChatEmbed({ answer, mode });
    const replyOptions = { embeds: [embed] };

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
  } catch (err) {
    logger.error(`/chat error: ${err.message}`);
    const errorEmbed = buildErrorEmbed(
      'Maaf, terjadi kesalahan. Coba lagi nanti ya!'
    );
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}
