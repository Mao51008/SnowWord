import fs from 'fs';
import path from 'path';

import { DATA_DIR, TIMEZONE } from './config.js';
import { readEnvFile } from './env.js';

export interface CurrentTimeSnapshot {
  iso: string;
  timezone: string;
  formatted: string;
  weekday: string;
}

export interface WeatherSummary {
  location: string;
  description: string;
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidity: number | null;
  windSpeed: number | null;
  advice: string | null;
  isRainy: boolean;
  raw: unknown;
}

interface WeatherConfig {
  baseUrl?: string;
  apiKey?: string;
  authParam: string;
  locationParam: string;
  adcodeParam: string;
}

type JsonObject = Record<string, unknown>;

function getWeatherConfig(): WeatherConfig {
  const env = readEnvFile([
    'WEATHER_BASE_URL',
    'WEATHER_API_KEY',
    'WEATHER_AUTH_PARAM',
    'WEATHER_LOCATION_PARAM',
    'WEATHER_ADCODE_PARAM',
  ]);

  return {
    baseUrl: process.env.WEATHER_BASE_URL || env.WEATHER_BASE_URL,
    apiKey: process.env.WEATHER_API_KEY || env.WEATHER_API_KEY,
    authParam:
      process.env.WEATHER_AUTH_PARAM || env.WEATHER_AUTH_PARAM || 'key',
    locationParam:
      process.env.WEATHER_LOCATION_PARAM ||
      env.WEATHER_LOCATION_PARAM ||
      'city',
    adcodeParam:
      process.env.WEATHER_ADCODE_PARAM || env.WEATHER_ADCODE_PARAM || 'adcode',
  };
}

function getSoulPath(accountId: string): string {
  return path.join(DATA_DIR, 'soul', `${accountId}.md`);
}

function toLocalizedNow(date = new Date()): CurrentTimeSnapshot {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    weekday: 'long',
  }).format(date);

  return {
    iso: date.toISOString(),
    timezone: TIMEZONE,
    formatted: formatter.format(date).replace(/\//g, '-'),
    weekday,
  };
}

function normalizeLocationCandidate(value: string): string | null {
  const cleaned = value
    .replace(/[，。、“”"'（）()\[\]【】]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 32) {
    return null;
  }
  return cleaned;
}

export function inferLocationFromMemory(accountId: string): string | null {
  const soulPath = getSoulPath(accountId);
  if (!fs.existsSync(soulPath)) return null;

  const content = fs.readFileSync(soulPath, 'utf-8');

  const explicitPatterns = [
    /(?:城市|所在地|位置|常住地|居住地|住在|在)\s*[：:]\s*([^\n]+)/,
    /(?:住在|在)\s*([^\n，。]{2,24}(?:省|市|区|县|州|镇|乡))/,
    /(?:天气|下雨|带伞).{0,18}(?:在|住在)\s*([^\n，。]{2,24}(?:省|市|区|县|州|镇|乡))/,
  ];

  for (const pattern of explicitPatterns) {
    const match = content.match(pattern);
    const candidate = match?.[1] ? normalizeLocationCandidate(match[1]) : null;
    if (candidate) return candidate;
  }

  return null;
}

export function isWeatherConfigured(): boolean {
  const config = getWeatherConfig();
  return Boolean(config.baseUrl);
}

export function getCurrentTimeSnapshot(): CurrentTimeSnapshot {
  return toLocalizedNow();
}

function unwrapPayload(data: unknown): JsonObject {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }

  const root = data as JsonObject;
  const nestedKeys = ['data', 'result', 'weather', 'now', 'live', 'current'];
  for (const key of nestedKeys) {
    const nested = root[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as JsonObject;
    }
  }

  return root;
}

function getNestedValue(source: unknown, ...paths: string[][]): unknown {
  for (const pathSegments of paths) {
    let current: unknown = source;
    let matched = true;
    for (const segment of pathSegments) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        matched = false;
        break;
      }
      current = (current as JsonObject)[segment];
      if (current == null) {
        matched = false;
        break;
      }
    }
    if (matched) return current;
  }
  return undefined;
}

function readString(source: unknown, ...paths: string[][]): string | null {
  const value = getNestedValue(source, ...paths);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(source: unknown, ...paths: string[][]): number | null {
  const value = getNestedValue(source, ...paths);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseWeatherError(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const root = data as JsonObject;
  const success = root.success;
  if (success === false) {
    return (
      readString(root, ['message']) ||
      readString(root, ['msg']) ||
      'Weather API returned success=false'
    );
  }

  const code =
    readString(root, ['code']) ||
    readString(root, ['status']) ||
    readString(root, ['error_code']) ||
    readString(root, ['errno']);
  if (code && !['0', '200', 'ok', 'OK', 'success', 'SUCCESS'].includes(code)) {
    return readString(root, ['message']) || readString(root, ['msg']) || code;
  }

  return null;
}

function buildAdvice(summary: {
  description: string;
  temperatureC: number | null;
}): { advice: string | null; isRainy: boolean } {
  const description = summary.description;
  const temperatureC = summary.temperatureC;
  const isRainy = /(雨|雷|阵雨|雷阵雨|小雨|中雨|大雨|暴雨|雨夹雪)/.test(
    description,
  );

  let advice: string | null = null;
  if (isRainy) {
    advice = '出门记得带伞。';
  } else if (temperatureC != null && temperatureC <= 10) {
    advice = '天气偏冷，出门多穿一点。';
  } else if (temperatureC != null && temperatureC >= 30) {
    advice = '天气偏热，记得补水。';
  }

  return { advice, isRainy };
}

function buildWeatherSummary(data: unknown, fallbackLocation: string): WeatherSummary {
  const payload = unwrapPayload(data);
  const location =
    readString(
      payload,
      ['city'],
      ['district'],
      ['location'],
      ['name'],
      ['province'],
      ['adcode'],
    ) || fallbackLocation;

  const description =
    readString(
      payload,
      ['weather'],
      ['text'],
      ['condition'],
      ['phenomenon'],
      ['type'],
      ['dayweather'],
      ['wea'],
    ) || '天气信息未知';

  const temperatureC = readNumber(
    payload,
    ['temp'],
    ['temperature'],
    ['temp_c'],
    ['daytemp'],
    ['temperature_float'],
  );
  const feelsLikeC = readNumber(
    payload,
    ['feels_like'],
    ['feelsLike'],
    ['apparent_temperature'],
    ['realfeel'],
  );
  const humidity = readNumber(payload, ['humidity'], ['rh']);
  const windSpeed = readNumber(
    payload,
    ['wind_speed'],
    ['windSpeed'],
    ['windspeed'],
    ['speed'],
  );

  const { advice, isRainy } = buildAdvice({ description, temperatureC });

  return {
    location,
    description,
    temperatureC: temperatureC == null ? null : Math.round(temperatureC),
    feelsLikeC: feelsLikeC == null ? null : Math.round(feelsLikeC),
    humidity: humidity == null ? null : Math.round(humidity),
    windSpeed: windSpeed == null ? null : windSpeed,
    advice,
    isRainy,
    raw: data,
  };
}

function buildWeatherUrl(
  baseUrl: string,
  location: string,
  config: WeatherConfig,
): URL {
  const url = new URL(baseUrl);
  const trimmed = location.trim();
  const adcodeMatch = trimmed.match(/\b\d{6,9}\b/);

  if (adcodeMatch) {
    url.searchParams.set(config.adcodeParam, adcodeMatch[0]);
  } else {
    url.searchParams.set(config.locationParam, trimmed);
  }

  if (config.apiKey) {
    url.searchParams.set(config.authParam, config.apiKey);
  }

  return url;
}

export async function getWeatherSummary(params: {
  accountId: string;
  location?: string;
}): Promise<WeatherSummary | null> {
  const config = getWeatherConfig();
  if (!config.baseUrl) {
    return null;
  }

  const location = params.location || inferLocationFromMemory(params.accountId);
  if (!location) {
    return null;
  }

  const url = buildWeatherUrl(config.baseUrl, location, config);
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Weather API ${res.status}: ${text}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Weather API returned non-JSON response: ${text}`);
  }

  const apiError = parseWeatherError(data);
  if (apiError) {
    throw new Error(`Weather API error: ${apiError}`);
  }

  return buildWeatherSummary(data, location);
}
