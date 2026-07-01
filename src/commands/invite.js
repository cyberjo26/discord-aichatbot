import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Mendapatkan link invite bot untuk ditambahkan ke server lain.');

export async function execute(interaction) {
  const clientId = interaction.client.user.id;
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=3230720&scope=bot%20applications.commands`;

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🤖 Undang Bot Ini Ke Server Kamu!')
    .setDescription('Klik tombol di bawah ini untuk mengundang bot ini ke server lain dengan hak akses standar.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Undang Bot (Invite Link)')
      .setStyle(ButtonStyle.Link)
      .setURL(inviteUrl)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}
