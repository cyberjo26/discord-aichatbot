import { EmbedBuilder } from 'discord.js';

const DEFAULT_TITLE = 'Selamat datang di {server}!';
const DEFAULT_MESSAGE = 'Halo {mention}, selamat datang! Semoga betah dan menikmati server ini. 🎉';
const WELCOME_TITLE_MAX = 80;
const WELCOME_MESSAGE_MAX = 600;

function renderTemplate(template, member) {
  const values = {
    '{server}': member.guild.name,
    '{user}': member.displayName,
    '{mention}': `<@${member.id}>`,
    '@{user}': `<@${member.id}>`,
  };

  return String(template).replaceAll(/@\{user\}|\{server\}|\{user\}|\{mention\}/g, (placeholder) => values[placeholder]);
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildWelcomeEmbed(member, { title, message, image } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    // Discord renders image separately; compact text keeps card balanced on mobile.
    .setTitle(renderTemplate(title || DEFAULT_TITLE, member).slice(0, WELCOME_TITLE_MAX))
    .setDescription(renderTemplate(message || DEFAULT_MESSAGE, member).slice(0, WELCOME_MESSAGE_MAX))
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: member.guild.name.slice(0, 2048) })
    .setTimestamp();

  if (image && isHttpUrl(image)) embed.setImage(image);
  return embed;
}

export { DEFAULT_TITLE, DEFAULT_MESSAGE, WELCOME_TITLE_MAX, WELCOME_MESSAGE_MAX };
