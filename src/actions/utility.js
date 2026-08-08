import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { fetchWeather, getWeatherCodeInfo } from '../utils/weather.js';
import { buildInviteUrl } from '../utils/invite-permissions.js';

// ─── Ping ──────────────────────────────────────────────────────────

export async function execPing(message) {
  const msg = await message.reply('🏓 Pinging...');
  const discordPing = message.client.ws.ping;

  let googlePing = -1;
  try {
    const gStart = Date.now();
    // 5s cap so a hung outbound request can't stall !ping / @bot ping
    await fetch('https://www.google.com', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    googlePing = Date.now() - gStart;
  } catch (err) {
    // ignore (timeout/network error -> shows 'Error' in embed)
  }

  const embed = new EmbedBuilder()
    .setColor('#00ffcc')
    .setTitle('🏓 Pong!')
    .addFields(
      { name: '🌐 Discord Gateway Latency', value: `${discordPing}ms`, inline: true },
      { name: '🔍 Google HTTP Latency', value: googlePing !== -1 ? `${googlePing}ms` : 'Error', inline: true }
    )
    .setFooter({ text: `Total round-trip time: ${Date.now() - message.createdTimestamp}ms` })
    .setTimestamp();

  await msg.edit({ content: null, embeds: [embed] });
  return { success: true, type: 'ping', replied: true };
}

// ─── Weather ───────────────────────────────────────────────────────

export async function execWeather(message, params) {
  const location = (typeof params === 'string' ? params : params?.location) || 'Jakarta';
  const msg = await message.reply('🔍 Memeriksa cuaca...');

  const weatherData = await fetchWeather(location);
  if (!weatherData) {
    const errorEmbed = new EmbedBuilder()
      .setColor('#ff4757')
      .setTitle('❌ Lokasi Tidak Ditemukan')
      .setDescription(`Maaf, tidak bisa menemukan informasi cuaca untuk lokasi **"${location}"**.`);
    await msg.edit({ content: null, embeds: [errorEmbed] });
    return { success: true, type: 'weather', replied: true };
  }

  const info = getWeatherCodeInfo(weatherData.current.weather_code);
  const embed = new EmbedBuilder()
    .setColor('#37b24d')
    .setTitle(`${info.emoji} Cuaca Realtime di ${weatherData.name}, ${weatherData.country}`)
    .addFields(
      { name: '🌡️ Suhu Saat Ini', value: `${weatherData.current.temperature_2m}°C (Terasa seperti ${weatherData.current.apparent_temperature}°C)`, inline: true },
      { name: '💧 Kelembapan', value: `${weatherData.current.relative_humidity_2m}%`, inline: true },
      { name: '💨 Kecepatan Angin', value: `${weatherData.current.wind_speed_10m} km/h`, inline: true },
      { name: '📊 Kondisi', value: info.label, inline: true },
      { name: '📍 Koordinat', value: `${weatherData.latitude.toFixed(4)}, ${weatherData.longitude.toFixed(4)}`, inline: true },
      { name: '🌍 Wilayah', value: weatherData.admin1 || '-', inline: true }
    )
    .setTimestamp();

  await msg.edit({ content: null, embeds: [embed] });
  return { success: true, type: 'weather', replied: true };
}

// ─── Invite ────────────────────────────────────────────────────────

export async function execInvite(message) {
  const clientId = message.client.user.id;
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

  await message.reply({ embeds: [embed], components: [row] });
  return { success: true, type: 'invite', replied: true };
}
