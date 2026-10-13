// 气温与保暖：把当天天气换算成对搭配的要求。

import type { Season, WeatherInput } from './types';

export type OuterNeed = 'required' | 'optional' | 'avoid';

export interface WarmthTarget {
  /** 上身总保暖度（上衣或连衣裙 + 外套 + 围巾）的合适区间 */
  min: number;
  max: number;
  outer: OuterNeed;
  /** 用于界面展示的简短说明 */
  label: string;
}

/**
 * 气温分档。保暖度：轻薄 1、适中 2、厚实 3。
 * 例如 15°C 时，薄衬衫 + 夹克（1+2）或一件厚毛衣（3）都算合适。
 */
export function warmthTarget(tempC: number): WarmthTarget {
  if (tempC >= 28) return { min: 1, max: 1, outer: 'avoid', label: '炎热' };
  if (tempC >= 24) return { min: 1, max: 2, outer: 'avoid', label: '温暖' };
  if (tempC >= 19) return { min: 1, max: 3, outer: 'optional', label: '舒适' };
  if (tempC >= 14) return { min: 2, max: 4, outer: 'optional', label: '微凉' };
  if (tempC >= 9) return { min: 3, max: 5, outer: 'required', label: '凉' };
  if (tempC >= 3) return { min: 4, max: 6, outer: 'required', label: '冷' };
  return { min: 5, max: 7, outer: 'required', label: '寒冷' };
}

/** 当前气温下合适的季节标签 */
export function seasonsForTemp(tempC: number): Season[] {
  if (tempC >= 26) return ['summer'];
  if (tempC >= 19) return ['spring', 'summer', 'autumn'];
  if (tempC >= 10) return ['spring', 'autumn'];
  if (tempC >= 4) return ['autumn', 'winter'];
  return ['winter'];
}

/** 早晚温差大时提醒带外套 */
export function bigDiurnalRange(w: WeatherInput): boolean {
  return w.tempMax !== undefined && w.tempMin !== undefined && w.tempMax - w.tempMin >= 10;
}

/** 由最高/最低温估算白天穿衣的代表温度 */
export function representativeTemp(tempMin: number, tempMax: number): number {
  return Math.round(tempMin * 0.4 + tempMax * 0.6);
}

/** Open-Meteo 天气代码中表示降水的范围 */
export function isRainCode(code: number): boolean {
  return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99);
}

export function isSnowCode(code: number): boolean {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

export function weatherCodeLabel(code: number): string {
  if (code === 0) return '晴';
  if (code <= 2) return '多云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 67) return '雨';
  if (isSnowCode(code)) return '雪';
  if (code >= 80 && code <= 82) return '阵雨';
  if (code >= 95) return '雷雨';
  return '—';
}
