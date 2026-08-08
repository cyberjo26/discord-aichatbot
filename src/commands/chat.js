import { SlashCommandBuilder } from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { buildChatEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { getHistory, addMessage } from '../utils/memory.js';
import { buildStyleInstruction } from '../utils/user-prefs.js';
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
    // Get conversation history
    const history = getHistory(interaction.user.id);

    // Build personalized system prompt with style instructions
    const styleInstruction = buildStyleInstruction(interaction.user.id);
    const systemPrompt = buildSystemPrompt(styleInstruction);

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    // Get AI response
    const answer = await chatCompletion(messages, { task: 'chat' });

    // Save to memory
    addMessage(interaction.user.id, 'user', message);
    addMessage(interaction.user.id, 'assistant', answer);

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
