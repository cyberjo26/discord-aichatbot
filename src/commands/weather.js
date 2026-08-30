import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { fetchWeather, getWeatherCodeInfo } from '../utils/weather.js';

export const data = new SlashCommandBuilder()
  .setName('weather')
  .setDescription('Melihat cuaca realtime di kota/negara pilihanmu.')
  .addStringOption((opt) =>
    opt
      .setName('lokasi')
      .setDescription('Nama kota atau negara yang ingin diperiksa')
      .setRequired(true)
  );

export async function execute(interaction) {
  const location = interaction.options.getString('lokasi');
  await interaction.deferReply();

  const weatherData = await fetchWeather(location);
  if (!weatherData) {
    const errorEmbed = new EmbedBuilder()
      .setColor('#ff4757')
      .setTitle('❌ Lokasi Tidak Ditemukan')
      .setDescription(`Maaf, tidak bisa menemukan informasi cuaca untuk lokasi **"${location}"**.`);
    return await interaction.editReply({ embeds: [errorEmbed] });
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

  await interaction.editReply({ embeds: [embed] });
}
