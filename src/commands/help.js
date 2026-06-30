import { SlashCommandBuilder } from 'discord.js';
import { buildHelpEmbed } from '../utils/formatter.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Tampilkan panduan penggunaan bot.');

export async function execute(interaction) {
  logger.command(interaction.user.tag, 'help');
  const embed = buildHelpEmbed();
  await interaction.reply({ embeds: [embed] });
}
