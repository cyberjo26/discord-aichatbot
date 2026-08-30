import axios from 'axios';
import logger from './logger.js';

/**
 * Maps WMO weather interpretation codes to descriptive Indonesian text and emojis.
 * Reference: https://open-meteo.com/en/docs
 */
export function getWeatherCodeInfo(code) {
  const codes = {
    0: { label: 'Cerah', emoji: '☀️' },
    1: { label: 'Cerah Berawan', emoji: '🌤️' },
    2: { label: 'Berawan Sebagian', emoji: '⛅' },
    3: { label: 'Mendung', emoji: '☁️' },
    45: { label: 'Kabut', emoji: '🌫️' },
    48: { label: 'Kabut Deposisi Es', emoji: '🌫️' },
    51: { label: 'Gerimis Ringan', emoji: '🌧️' },
    53: { label: 'Gerimis Sedang', emoji: '🌧️' },
    55: { label: 'Gerimis Lebat', emoji: '🌧️' },
    56: { label: 'Gerimis Beku Ringan', emoji: '🌧️' },
    57: { label: 'Gerimis Beku Lebat', emoji: '🌧️' },
    61: { label: 'Hujan Ringan', emoji: '🌧️' },
    63: { label: 'Hujan Sedang', emoji: '🌧️' },
    65: { label: 'Hujan Lebat', emoji: '🌧️' },
    66: { label: 'Hujan Beku Ringan', emoji: '🌧️' },
    67: { label: 'Hujan Beku Lebat', emoji: '🌧️' },
    71: { label: 'Salju Ringan', emoji: '❄️' },
    73: { label: 'Salju Sedang', emoji: '❄️' },
    75: { label: 'Salju Lebat', emoji: '❄️' },
    77: { label: 'Butiran Salju', emoji: '❄️' },
    80: { label: 'Hujan Shower Ringan', emoji: '🌦️' },
    81: { label: 'Hujan Shower Sedang', emoji: '🌦️' },
    82: { label: 'Hujan Shower Lebat', emoji: '🌦️' },
    85: { label: 'Hujan Salju Ringan', emoji: '🌨️' },
    86: { label: 'Hujan Salju Lebat', emoji: '🌨️' },
    95: { label: 'Badai Petir', emoji: '⛈️' },
    96: { label: 'Badai Petir dengan Hujan Es Ringan', emoji: '⛈️' },
    99: { label: 'Badai Petir dengan Hujan Es Lebat', emoji: '⛈️' }
  };
  return codes[code] || { label: 'Tidak Diketahui', emoji: '🌡️' };
}

/**
 * Fetches real-time weather information for a given city or country.
 * Returns formatted weather details or null if location not found.
 */
export async function fetchWeather(location) {
  try {
    logger.debug(`Weather search for: "${location}"`);

    // Step 1: Geocoding (find lat/lon for the location)
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search`;
    const geoResponse = await axios.get(geocodeUrl, {
      params: {
        name: location,
        count: 1,
        language: 'en',
        format: 'json'
      },
      timeout: 8000
    });

    if (!geoResponse.data?.results?.length) {
      logger.warn(`Location not found: "${location}"`);
      return null;
    }

    const geo = geoResponse.data.results[0];
    const { latitude, longitude, name, country, admin1 } = geo;
    logger.debug(`Geocoding resolved: ${name}, ${country} (${latitude}, ${longitude})`);

    // Step 2: Fetch current weather for resolved coordinates
    const weatherUrl = `https://api.open-meteo.com/v1/forecast`;
    const weatherResponse = await axios.get(weatherUrl, {
      params: {
        latitude,
        longitude,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
        timezone: 'auto'
      },
      timeout: 8000
    });

    if (!weatherResponse.data?.current) {
      logger.warn(`Could not fetch current weather for coordinates: ${latitude}, ${longitude}`);
      return null;
    }

    return {
      name,
      country,
      admin1,
      latitude,
      longitude,
      current: weatherResponse.data.current
    };
  } catch (err) {
    logger.error(`fetchWeather failed: ${err.message}`);
    return null;
  }
}

export default { fetchWeather, getWeatherCodeInfo };
