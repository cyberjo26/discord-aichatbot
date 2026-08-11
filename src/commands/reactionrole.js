import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import {
  getReactionRoles,
  addReactionRole,
  removeReactionRole,
  removeAllReactionRoles,
  updateReactionRoleEmoji,
  findMessageInGuild,
} from '../utils/reaction-roles.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('reactionrole')
  .setDescription('Atur reaction roles — role otomatis dari reaksi emoji')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Tambah binding: emoji → role di sebuah pesan')
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('ID pesan yang akan dipasang reaction role').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('emoji').setDescription('Emoji (contoh: 🎉 atau :custom:)').setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role yang diberikan saat user react').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Hapus satu binding reaction role')
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('ID pesan').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('emoji').setDescription('Emoji yang akan dihapus').setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role yang dihapus (opsional, hapus semua untuk emoji ini)').setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove-all')
      .setDescription('Hapus semua reaction role dari sebuah pesan')
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('ID pesan').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Lihat semua reaction role di server ini')
  )
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Buat panel reaction role otomatis di channel ini')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Judul embed panel').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('description').setDescription('Deskripsi panel (opsional)').setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('ID pesan yang sudah ada — gunakan ini sebagai panel, skip embed baru').setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('set-emoji')
      .setDescription('Ganti emoji untuk binding reaction role yang sudah ada')
      .addStringOption((opt) =>
        opt.setName('message_id').setDescription('ID pesan reaction role').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('old_emoji').setDescription('Emoji lama yang mau diganti').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('new_emoji').setDescription('Emoji baru pengganti').setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role yang terikat dengan emoji lama').setRequired(true)
      )
  );

/**
 * Resolve emoji input into a canonical key.
 * Handles: raw unicode emoji ('🎉'), custom emoji ID string ('123456'),
 *          or Discord-format '<:name:123456>' / '<a:name:123456>'.
 * Returns the emoji.id string (custom) or the raw name (unicode).
 */
function resolveEmoji(input) {
  const trimmed = input.trim();

  // Discord custom emoji format: <:name:123456> or <a:name:123456>
  const match = trimmed.match(/^<a?:(\w+):(\d+)>$/);
  if (match) return match[2]; // return the numeric ID as string

  // Plain numeric ID
  if (/^\d{15,}$/.test(trimmed)) return trimmed;

  // Unicode emoji
  return trimmed;
}

export async function execute(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: '❌ Perintah ini hanya bisa digunakan di server.', ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  logger.command(interaction.user.tag, `reactionrole ${sub}`);

  switch (sub) {
    case 'setup':
      return handleSetup(interaction);
    case 'add':
      return handleAdd(interaction);
    case 'remove':
      return handleRemove(interaction);
    case 'remove-all':
      return handleRemoveAll(interaction);
    case 'list':
      return handleList(interaction);
    case 'set-emoji':
      return handleSetEmoji(interaction);
  }
}

async function handleSetup(interaction) {
  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description') || '';
  const existingMsgId = interaction.options.getString('message_id');

  // Mode: reuse existing message
  if (existingMsgId) {
    const guild = interaction.guild;
    const found = await findMessageInGuild(guild, existingMsgId, interaction.channelId);
    if (!found) {
      return interaction.reply({ content: `❌ Pesan \`${existingMsgId}\` tidak ditemukan di server ini.`, ephemeral: true });
    }
    return interaction.reply({
      content: `✅ Pesan \`${existingMsgId}\` dari <#${found.channelId}> dijadikan panel reaction role!\nGunakan \`/reactionrole add\` untuk menambah binding.`,
      ephemeral: true,
    });
  }

  // Mode: create new embed panel
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(description || null)
    .setFooter({ text: 'Reaction Roles — klik emoji di bawah untuk dapat role!' })
    .setTimestamp();

  await interaction.reply({ content: '✅ Panel reaction role dibuat. Gunakan `/reactionrole add` untuk menambah binding ke pesan ini.', ephemeral: true });
  const panelMsg = await interaction.channel.send({ embeds: [embed] });

  // Follow up with the message ID for easy copying
  await interaction.followUp({
    content: `📋 **ID pesan panel:** \`${panelMsg.id}\`\nGunakan ID ini dengan \`/reactionrole add\` untuk menambah reaction role.`,
    ephemeral: true,
  });
}

async function handleAdd(interaction) {
  const guildId = interaction.guildId;
  const messageId = interaction.options.getString('message_id');
  const emojiRaw = interaction.options.getString('emoji');
  const role = interaction.options.getRole('role');

  const emoji = resolveEmoji(emojiRaw);

  // Validate message exists (scan all guild channels)
  const guild = interaction.guild;
  const msg = await findMessageInGuild(guild, messageId, interaction.channelId);
  if (!msg) {
    return interaction.reply({ content: `❌ Pesan \`${messageId}\` tidak ditemukan di server ini. Pastikan ID benar dan bot punya akses ke channel-nya.`, ephemeral: true });
  }

  // React to the message so users can click it
  try {
    const reactEmoji = /^\d{15,}$/.test(emoji)
      ? guild.emojis.cache.get(emoji) ?? emoji
      : emoji;
    await msg.react(reactEmoji);
  } catch (err) {
    return interaction.reply({ content: `❌ Gagal menambahkan reaksi: ${err.message}`, ephemeral: true });
  }

  const added = addReactionRole(guildId, {
    messageId,
    channelId: msg.channelId,
    emoji,
    roleId: role.id,
  });

  if (!added) {
    return interaction.reply({
      content: `⚠️ Binding untuk emoji **${emojiRaw}** → <@&${role.id}> di pesan \`${messageId}\` **sudah ada**.`,
      ephemeral: true,
    });
  }

  await interaction.reply({
    content: `✅ **Reaction role ditambahkan!**\n📌 Pesan: \`${messageId}\`\n🎨 Emoji: ${emojiRaw}\n👤 Role: <@&${role.id}>`,
    ephemeral: true,
  });
}

async function handleRemove(interaction) {
  const guildId = interaction.guildId;
  const messageId = interaction.options.getString('message_id');
  const emojiRaw = interaction.options.getString('emoji');
  const role = interaction.options.getRole('role');

  const emoji = resolveEmoji(emojiRaw);
  const removed = removeReactionRole(guildId, messageId, emoji, role?.id);

  if (removed === 0) {
    return interaction.reply({ content: `⚠️ Tidak ada binding yang cocok.`, ephemeral: true });
  }

  await interaction.reply({
    content: `✅ **${removed}** binding dihapus dari pesan \`${messageId}\` untuk emoji ${emojiRaw}.`,
    ephemeral: true,
  });
}

async function handleRemoveAll(interaction) {
  const guildId = interaction.guildId;
  const messageId = interaction.options.getString('message_id');

  const removed = removeAllReactionRoles(guildId, messageId);

  if (removed === 0) {
    return interaction.reply({ content: `⚠️ Tidak ada reaction role di pesan \`${messageId}\`.`, ephemeral: true });
  }

  await interaction.reply({
    content: `✅ **${removed}** binding dihapus dari pesan \`${messageId}\`.`,
    ephemeral: true,
  });
}

async function handleList(interaction) {
  const guildId = interaction.guildId;
  const list = getReactionRoles(guildId);

  if (list.length === 0) {
    return interaction.reply({ content: '📭 Belum ada reaction role di server ini.', ephemeral: true });
  }

  // Group by message
  const byMessage = new Map();
  for (const entry of list) {
    if (!byMessage.has(entry.messageId)) byMessage.set(entry.messageId, []);
    byMessage.get(entry.messageId).push(entry);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📌 Reaction Roles — Server Ini')
    .setFooter({ text: `${list.length} total binding` })
    .setTimestamp();

  for (const [messageId, entries] of byMessage) {
    const lines = entries.map((e) => {
      const emojiDisplay = /^\d{15,}$/.test(e.emoji)
        ? `<:custom:${e.emoji}>`
        : e.emoji;
      return `${emojiDisplay} → <@&${e.roleId}>`;
    });
    embed.addFields({
      name: `📋 Pesan \`${messageId}\` (${entries.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleSetEmoji(interaction) {
  const guildId = interaction.guildId;
  const messageId = interaction.options.getString('message_id');
  const oldEmojiRaw = interaction.options.getString('old_emoji');
  const newEmojiRaw = interaction.options.getString('new_emoji');
  const role = interaction.options.getRole('role');

  const oldEmoji = resolveEmoji(oldEmojiRaw);
  const newEmoji = resolveEmoji(newEmojiRaw);

  const updated = updateReactionRoleEmoji(guildId, messageId, oldEmoji, newEmoji, role.id);
  if (!updated) {
    return interaction.reply({ content: `❌ Binding tidak ditemukan: \`${messageId}\` ${oldEmojiRaw} → ${role}`, ephemeral: true });
  }

  // Remove old reaction + add new reaction on the message
  const guild = interaction.guild;
  const msg = await findMessageInGuild(guild, messageId, interaction.channelId);
  if (msg) {
    try {
      const oldReact = /^\d{15,}$/.test(oldEmoji)
        ? guild.emojis.cache.get(oldEmoji) ?? oldEmoji
        : oldEmoji;
      const reactKey = typeof oldReact === 'string' ? oldReact : oldReact.id;
      const reaction = msg.reactions.cache.get(reactKey);
      if (reaction) {
        await reaction.users.remove(interaction.client.user.id);
      }
    } catch { /* ignore */ }

    try {
      const newReact = /^\d{15,}$/.test(newEmoji)
        ? guild.emojis.cache.get(newEmoji) ?? newEmoji
        : newEmoji;
      await msg.react(newReact);
    } catch (err) {
      return interaction.reply({ content: `⚠️ Binding diupdate, tapi gagal react emoji baru: ${err.message}`, ephemeral: true });
    }
  }

  await interaction.reply({
    content: `✅ Emoji diubah: ${oldEmojiRaw} → ${newEmojiRaw} untuk ${role} di pesan \`${messageId}\`.`,
    ephemeral: true,
  });
}