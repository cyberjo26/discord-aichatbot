import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Melihat latensi bot ke Discord dan Google.');

export async function execute(interaction) {
  const start = Date.now();
  await interaction.deferReply();
  const discordPing = interaction.client.ws.ping;

  let googlePing = -1;
  try {
    const gStart = Date.now();
    await fetch('https://www.google.com', { method: 'HEAD' });
    googlePing = Date.now() - gStart;
  } catch (err) {
    // Ignore error
  }

  const embed = new EmbedBuilder()
    .setColor('#00ffcc')
    .setTitle('🏓 Pong!')
    .addFields(
      { name: '🌐 Discord Gateway Latency', value: `${discordPing}ms`, inline: true },
      { name: '🔍 Google HTTP Latency', value: googlePing !== -1 ? `${googlePing}ms` : 'Error', inline: true }
    )
    .setFooter({ text: `Total round-trip time: ${Date.now() - start}ms` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
