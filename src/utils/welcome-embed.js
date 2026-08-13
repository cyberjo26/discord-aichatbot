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

  return String(template)
    .replaceAll(/@\{user\}|\{server\}|\{user\}|\{mention\}/g, (placeholder) => values[placeholder])
    .replaceAll('\\n', '\n');
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Invisible wide spacer (Braille Blank Space U+2800) forces Discord embed container to max width (520px)
const WIDE_SPACER = '⠀'.repeat(45);

export function buildWelcomeEmbed(member, { title, message, image, fullWidth = false } = {}) {
  let description = renderTemplate(message || DEFAULT_MESSAGE, member).slice(0, WELCOME_MESSAGE_MAX);

  if (fullWidth && !description.includes('⠀') && !description.includes('━') && !description.includes('─')) {
    description += `\n${WIDE_SPACER}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(renderTemplate(title || DEFAULT_TITLE, member).slice(0, WELCOME_TITLE_MAX))
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: member.guild.name.slice(0, 2048) })
    .setTimestamp();

  if (image && isHttpUrl(image)) embed.setImage(image);
  return embed;
}

export { DEFAULT_TITLE, DEFAULT_MESSAGE, WELCOME_TITLE_MAX, WELCOME_MESSAGE_MAX, WIDE_SPACER };
