// 联网获取当天天气（Open-Meteo，免费、无需密钥）。失败时由用户手动输入气温。

import type { SavedLocation } from '../core/types';
import { isRainCode, isSnowCode, representativeTemp } from '../core/weather';

export interface FetchedWeather {
  tempC: number;
  tempMin: number;
  tempMax: number;
  rain: boolean;
  code: number;
}

export function getPosition(timeoutMs = 10000): Promise<SavedLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('当前浏览器不支持定位，请手动输入气温'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED ? '没有定位权限，请在浏览器设置里允许定位，或手动输入气温' : '定位失败，请手动输入气温',
          ),
        ),
      { timeout: timeoutMs, maximumAge: 6 * 3600 * 1000, enableHighAccuracy: false },
    );
  });
}

export async function fetchWeather(loc: SavedLocation, timeoutMs = 9000): Promise<FetchedWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&timezone=auto&forecast_days=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`天气服务返回 ${res.status}`);
    const json = await res.json();
    const d = json?.daily;
    const max = Number(d?.temperature_2m_max?.[0]);
    const min = Number(d?.temperature_2m_min?.[0]);
    const code = Number(d?.weather_code?.[0] ?? 0);
    const pop = Number(d?.precipitation_probability_max?.[0] ?? 0);
    if (!Number.isFinite(max) || !Number.isFinite(min)) throw new Error('天气数据不完整');
    return {
      tempC: representativeTemp(min, max),
      tempMin: Math.round(min),
      tempMax: Math.round(max),
      rain: isRainCode(code) || isSnowCode(code) || pop >= 50,
      code,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('获取天气超时，请手动输入气温');
    if (e instanceof Error && e.message.startsWith('天气')) throw e;
    throw new Error('无法连接天气服务，请手动输入气温');
  } finally {
    clearTimeout(timer);
  }
}
