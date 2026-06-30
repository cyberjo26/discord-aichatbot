import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { chatCompletion } from '../ai/openrouter.js';
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { condenseForVoice, synthesize } from '../voice/tts.js';
import { playInVoiceChannel, getMemberVoiceChannel } from '../voice/player.js';
import { buildChatEmbed, buildErrorEmbed } from '../utils/formatter.js';
import { getHistory, addMessage } from '../utils/memory.js';
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

    // Build messages array
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message },
    ];

    // Get AI response
    const answer = await chatCompletion(messages);

    // Save to memory
    addMessage(interaction.user.id, 'user', message);
    addMessage(interaction.user.id, 'assistant', answer);

    // Build embed
    const embed = buildChatEmbed({ answer, mode });
    const replyOptions = { embeds: [embed] };

    if (mode === 'voice') {
      try {
        const voiceText = await condenseForVoice(answer);
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
          replyOptions.content = '🔊 *Kamu tidak sedang di voice channel, jadi aku kirim audionya di sini.*';
          await interaction.editReply(replyOptions);
        }
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
