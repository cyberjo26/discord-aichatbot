import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getProvider } from '../ai/router.js';
import { isOwner } from '../utils/permissions.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('test-ai')
  .setDescription('🧪 Diagnostic test untuk AI provider tertentu (cek latency, status & respon).')
  // Diagnostic fires real API calls — restrict to server admins by default.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt
      .setName('provider')
      .setDescription('Nama provider (misal: 9router, hcnsec, groq, gemini, sambanova, openrouter)')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('prompt')
      .setDescription('Prompt custom untuk ditest (opsional, default: "Tes koneksi.")')
      .setRequired(false)
  );

export async function execute(interaction) {
  // Defense in depth: default permissions can be overridden by server admins,
  // but the bot owner should always pass and non-admins in DMs should not.
  if (!isOwner(interaction.user.id) && interaction.member &&
      !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '🔒 Perintah ini hanya untuk admin server atau owner bot.',
      ephemeral: true,
    });
  }

  const providerName = interaction.options.getString('provider').toLowerCase().trim();
  const testPrompt = interaction.options.getString('prompt') || 'Tes koneksi dan latency. Balas satu kalimat singkat.';

  logger.command(interaction.user.tag, 'test-ai', `provider=${providerName} prompt="${testPrompt}"`);
  await interaction.deferReply();

  const provider = getProvider(providerName);
  if (!provider || !provider.enabled()) {
    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`❌ Provider [${providerName}] Tidak Aktif / Belum Dikonfigurasi`)
      .setDescription(`Provider \`${providerName}\` belum memiliki API key atau Base URL di file \`.env\`.\n\nPastikan sudah menambahkan:\n\`${providerName.toUpperCase()}_BASE_URL\` & \`${providerName.toUpperCase()}_API_KEY\`\natau cek nama provider yang tersedia.`)
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  const startedAt = Date.now();
  try {
    const result = await provider.complete([
      { role: 'user', content: testPrompt },
    ], { timeoutMs: 40000 });

    const latencyMs = Date.now() - startedAt;
    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`✅ Test AI: [${providerName}] Berhasil!`)
      .addFields(
        { name: '⏱️ Latency', value: `\`${latencyMs} ms\` (~${(latencyMs / 1000).toFixed(2)}s)`, inline: true },
        { name: '🤖 Model Digunakan', value: `\`${result.model || 'default'}\``, inline: true },
        { name: '💬 Input Prompt', value: `\`\`\`\n${testPrompt.slice(0, 500)}\n\`\`\``, inline: false },
        { name: '📤 Respon Provider', value: `\`\`\`\n${(result.text || '(empty)').slice(0, 1000)}\n\`\`\``, inline: false }
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`❌ Test AI: [${providerName}] Gagal`)
      .addFields(
        { name: '⏱️ Latency sebelum gagal', value: `\`${latencyMs} ms\``, inline: true },
        { name: '⚠️ Error Code', value: `\`${error.code || 'UNKNOWN'}\``, inline: true },
        { name: '📋 Detail Pesan Error', value: `\`\`\`\n${error.message.slice(0, 900)}\n\`\`\``, inline: false }
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
