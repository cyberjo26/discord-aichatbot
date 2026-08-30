import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildInviteUrl } from '../utils/invite-permissions.js';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Mendapatkan link invite bot untuk ditambahkan ke server lain.');

export async function execute(interaction) {
  const clientId = interaction.client.user.id;
  const inviteUrl = buildInviteUrl(clientId);

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🤖 Undang Bot Ini Ke Server Kamu!')
    .setDescription(
      'Klik tombol di bawah untuk mengundang bot dengan **semua permission** yang dibutuhkan (moderasi, voice control, manage channels/roles/nicknames, dsb).'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Undang Bot (Invite Link)')
      .setStyle(ButtonStyle.Link)
      .setURL(inviteUrl)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}
