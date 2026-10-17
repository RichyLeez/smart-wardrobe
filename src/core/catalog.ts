// 类别、子类、标签的中文名称和默认值。
// 子类默认值让录入时只需点一下子类，大部分字段就能自动填好。

import type {
  BodyGoal,
  Category,
  Fit,
  Length,
  Occasion,
  Pattern,
  Rise,
  Season,
  Style,
  Warmth,
} from './types';

export const CATEGORY_LABELS: Record<Category, string> = {
  top: '上衣',
  bottom: '下装',
  dress: '连衣裙',
  outer: '外套',
  shoes: '鞋',
  bag: '包',
  hat: '帽子',
  scarf: '围巾',
  belt: '腰带',
  jewelry: '配饰',
};

export const CATEGORIES: Category[] = [
  'top',
  'bottom',
  'dress',
  'outer',
  'shoes',
  'bag',
  'hat',
  'scarf',
  'belt',
  'jewelry',
];

/** 构成一套搭配主体的类别 */
export const MAIN_CATEGORIES: Category[] = ['top', 'bottom', 'dress', 'outer'];
export const ACCESSORY_CATEGORIES: Category[] = ['bag', 'hat', 'scarf', 'belt', 'jewelry'];

/** 人台上的叠放顺序，数字越大越靠上 */
export const LAYER_ORDER: Record<Category, number> = {
  shoes: 1,
  bottom: 2,
  dress: 3,
  top: 4,
  belt: 5,
  outer: 6,
  scarf: 7,
  jewelry: 8,
  bag: 9,
  hat: 10,
};

export const SEASON_LABELS: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const OCCASION_LABELS: Record<Occasion, string> = {
  commute: '通勤',
  formal: '正式',
  casual: '休闲',
  sport: '运动',
  date: '约会',
  travel: '出行',
};
export const OCCASIONS: Occasion[] = ['commute', 'casual', 'formal', 'date', 'sport', 'travel'];

export const STYLE_LABELS: Record<Style, string> = {
  minimal: '简约',
  casual: '休闲',
  business: '商务',
  sporty: '运动',
  street: '街头',
  vintage: '复古',
  sweet: '甜美',
  outdoor: '户外',
};
export const STYLES: Style[] = [
  'minimal',
  'casual',
  'business',
  'sporty',
  'street',
  'vintage',
  'sweet',
  'outdoor',
];

export const FIT_LABELS: Record<Fit, string> = { slim: '修身', regular: '常规', loose: '宽松' };
export const RISE_LABELS: Record<Rise, string> = { high: '高腰', mid: '中腰', low: '低腰' };
export const WARMTH_LABELS: Record<Warmth, string> = { 1: '轻薄', 2: '适中', 3: '厚实' };
export const PATTERN_LABELS: Record<Pattern, string> = {
  solid: '纯色',
  stripe: '条纹',
  check: '格纹',
  print: '印花',
  colorblock: '拼色',
};

/** 长度在不同类别下的说明文字 */
export function lengthLabels(category: Category, subtype?: string): Record<Length, string> {
  if (category === 'bottom') {
    if (subtype && isSkirtLike(subtype)) return { short: '短裙', regular: '及膝/中长', long: '长裙' };
    return { short: '短裤', regular: '七分/九分', long: '长裤' };
  }
  if (category === 'dress') return { short: '短款', regular: '及膝', long: '长款' };
  return { short: '短款', regular: '常规', long: '长款' };
}

export function isSkirtLike(subtype: string): boolean {
  return subtype.includes('裙');
}

export const GOAL_LABELS: Record<BodyGoal, string> = {
  lengthen_legs: '拉长腿部比例',
  balance_upper: '平衡偏宽的上身',
  balance_lower: '平衡偏宽的下身',
  define_waist: '突出腰线',
};

export const GOAL_HINTS: Record<BodyGoal, string> = {
  lengthen_legs: '优先高腰下装、短款或常规长度上衣，鞋裤颜色相近',
  balance_upper: '下装选有体量的版型，避免上宽下窄',
  balance_lower: '下装颜色比上衣深，避免过紧的下装',
  define_waist: '腰带、高腰下装、修身或短款上衣',
};

/** 哪些类别使用版型、长度、腰线字段 */
export const FIELD_APPLICABILITY: Record<Category, { fit: boolean; length: boolean; rise: boolean }> = {
  top: { fit: true, length: true, rise: false },
  bottom: { fit: true, length: true, rise: true },
  dress: { fit: true, length: true, rise: true },
  outer: { fit: true, length: true, rise: false },
  shoes: { fit: false, length: false, rise: false },
  bag: { fit: false, length: false, rise: false },
  hat: { fit: false, length: false, rise: false },
  scarf: { fit: false, length: false, rise: false },
  belt: { fit: false, length: false, rise: false },
  jewelry: { fit: false, length: false, rise: false },
};

export interface SubtypeDefaults {
  warmth: Warmth;
  seasons: Season[];
  occasions: Occasion[];
  styles: Style[];
  fit?: Fit;
  length?: Length;
  rise?: Rise;
}

const ALL_SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
const WARM_SEASONS: Season[] = ['spring', 'summer', 'autumn'];
const MILD_SEASONS: Season[] = ['spring', 'autumn'];
const COLD_SEASONS: Season[] = ['autumn', 'winter'];

function d(
  warmth: Warmth,
  seasons: Season[],
  occasions: Occasion[],
  styles: Style[],
  extra: Partial<Pick<SubtypeDefaults, 'fit' | 'length' | 'rise'>> = {},
): SubtypeDefaults {
  return { warmth, seasons, occasions, styles, ...extra };
}

export const SUBTYPES: Record<Category, Record<string, SubtypeDefaults>> = {
  top: {
    T恤: d(1, WARM_SEASONS, ['casual', 'travel', 'sport'], ['casual', 'minimal'], { fit: 'regular', length: 'regular' }),
    衬衫: d(1, WARM_SEASONS, ['commute', 'formal', 'date', 'casual'], ['minimal', 'business'], { fit: 'regular', length: 'regular' }),
    Polo衫: d(1, ['spring', 'summer'], ['commute', 'casual'], ['casual', 'business'], { fit: 'regular', length: 'regular' }),
    针织衫: d(2, MILD_SEASONS, ['commute', 'casual', 'date'], ['minimal', 'casual'], { fit: 'regular', length: 'regular' }),
    毛衣: d(3, COLD_SEASONS, ['casual', 'commute', 'date'], ['casual', 'minimal'], { fit: 'regular', length: 'regular' }),
    卫衣: d(2, MILD_SEASONS.concat('winter'), ['casual', 'travel', 'sport'], ['casual', 'street'], { fit: 'loose', length: 'regular' }),
    背心: d(1, ['summer'], ['casual', 'sport'], ['casual', 'sporty'], { fit: 'slim', length: 'regular' }),
    吊带: d(1, ['summer'], ['casual', 'date'], ['sweet', 'minimal'], { fit: 'slim', length: 'short' }),
    打底衫: d(1, ALL_SEASONS, ['casual', 'commute'], ['minimal'], { fit: 'slim', length: 'regular' }),
    运动上衣: d(1, ALL_SEASONS, ['sport'], ['sporty'], { fit: 'slim', length: 'regular' }),
  },
  bottom: {
    牛仔裤: d(2, ALL_SEASONS, ['casual', 'travel', 'date'], ['casual', 'street'], { fit: 'regular', length: 'long', rise: 'mid' }),
    休闲裤: d(2, ALL_SEASONS, ['casual', 'commute', 'travel'], ['casual', 'minimal'], { fit: 'regular', length: 'long', rise: 'mid' }),
    西裤: d(2, ALL_SEASONS, ['commute', 'formal'], ['business', 'minimal'], { fit: 'regular', length: 'long', rise: 'high' }),
    阔腿裤: d(2, ALL_SEASONS, ['commute', 'casual', 'date'], ['minimal', 'vintage'], { fit: 'loose', length: 'long', rise: 'high' }),
    工装裤: d(2, ALL_SEASONS, ['casual', 'travel'], ['street', 'outdoor'], { fit: 'loose', length: 'long', rise: 'mid' }),
    运动裤: d(2, ALL_SEASONS, ['sport', 'casual'], ['sporty'], { fit: 'regular', length: 'long', rise: 'mid' }),
    短裤: d(1, ['summer'], ['casual', 'sport', 'travel'], ['casual', 'sporty'], { fit: 'regular', length: 'short', rise: 'mid' }),
    半身裙: d(1, WARM_SEASONS, ['commute', 'date', 'casual'], ['minimal', 'sweet'], { fit: 'regular', length: 'regular', rise: 'high' }),
    百褶裙: d(1, WARM_SEASONS, ['casual', 'date'], ['sweet', 'vintage'], { fit: 'loose', length: 'regular', rise: 'high' }),
  },
  dress: {
    连衣裙: d(1, WARM_SEASONS, ['date', 'casual', 'commute'], ['sweet', 'minimal'], { fit: 'regular', length: 'regular', rise: 'mid' }),
    衬衫裙: d(1, WARM_SEASONS, ['commute', 'casual'], ['minimal', 'business'], { fit: 'regular', length: 'regular', rise: 'mid' }),
    针织裙: d(2, COLD_SEASONS.concat('spring'), ['commute', 'date'], ['minimal'], { fit: 'slim', length: 'long', rise: 'mid' }),
    吊带裙: d(1, ['summer'], ['date', 'casual'], ['sweet'], { fit: 'slim', length: 'long', rise: 'high' }),
  },
  outer: {
    西装外套: d(2, ALL_SEASONS, ['commute', 'formal'], ['business', 'minimal'], { fit: 'regular', length: 'regular' }),
    夹克: d(2, MILD_SEASONS, ['casual', 'travel'], ['casual', 'street'], { fit: 'regular', length: 'short' }),
    风衣: d(2, MILD_SEASONS, ['commute', 'casual', 'date'], ['minimal', 'vintage'], { fit: 'regular', length: 'long' }),
    大衣: d(3, ['winter', 'autumn'], ['commute', 'formal', 'date'], ['minimal', 'business'], { fit: 'regular', length: 'long' }),
    羽绒服: d(3, ['winter'], ['casual', 'travel', 'commute'], ['casual', 'outdoor'], { fit: 'loose', length: 'regular' }),
    棉服: d(3, ['winter'], ['casual', 'travel', 'commute'], ['casual'], { fit: 'loose', length: 'regular' }),
    开衫: d(1, MILD_SEASONS, ['casual', 'commute', 'date'], ['minimal', 'sweet'], { fit: 'regular', length: 'regular' }),
    冲锋衣: d(2, MILD_SEASONS.concat('winter'), ['travel', 'sport'], ['outdoor', 'sporty'], { fit: 'regular', length: 'regular' }),
    皮衣: d(2, MILD_SEASONS, ['casual', 'date'], ['street', 'vintage'], { fit: 'slim', length: 'short' }),
    马甲: d(1, MILD_SEASONS, ['casual', 'commute'], ['vintage', 'minimal'], { fit: 'regular', length: 'regular' }),
  },
  shoes: {
    运动鞋: d(2, ALL_SEASONS, ['casual', 'sport', 'travel'], ['casual', 'sporty', 'street']),
    帆布鞋: d(1, WARM_SEASONS, ['casual', 'travel'], ['casual', 'street']),
    皮鞋: d(2, ALL_SEASONS, ['commute', 'formal'], ['business', 'minimal']),
    乐福鞋: d(2, WARM_SEASONS, ['commute', 'casual', 'date'], ['minimal', 'vintage']),
    靴子: d(3, COLD_SEASONS, ['casual', 'date', 'commute'], ['street', 'vintage']),
    凉鞋: d(1, ['summer'], ['casual', 'travel', 'date'], ['casual', 'sweet']),
    高跟鞋: d(1, ALL_SEASONS, ['formal', 'date', 'commute'], ['business', 'sweet']),
  },
  bag: {
    双肩包: d(1, ALL_SEASONS, ['travel', 'casual', 'commute'], ['casual', 'sporty']),
    托特包: d(1, ALL_SEASONS, ['commute', 'casual'], ['minimal']),
    斜挎包: d(1, ALL_SEASONS, ['casual', 'travel', 'date'], ['casual', 'street']),
    手提包: d(1, ALL_SEASONS, ['commute', 'formal', 'date'], ['business', 'minimal']),
    腰包: d(1, ALL_SEASONS, ['travel', 'sport', 'casual'], ['street', 'sporty']),
  },
  hat: {
    棒球帽: d(1, ALL_SEASONS, ['casual', 'sport', 'travel'], ['casual', 'sporty', 'street']),
    渔夫帽: d(1, WARM_SEASONS, ['casual', 'travel'], ['street', 'casual']),
    针织帽: d(3, ['winter'], ['casual', 'travel'], ['casual', 'street']),
    礼帽: d(1, ALL_SEASONS, ['date', 'formal'], ['vintage']),
  },
  scarf: {
    围巾: d(3, ['winter', 'autumn'], ['casual', 'commute', 'date', 'travel'], ['minimal', 'casual']),
    丝巾: d(1, WARM_SEASONS, ['commute', 'date', 'formal'], ['vintage', 'sweet']),
  },
  belt: {
    皮带: d(1, ALL_SEASONS, ['commute', 'formal', 'casual', 'date'], ['business', 'minimal']),
    编织腰带: d(1, WARM_SEASONS, ['casual', 'date'], ['vintage', 'casual']),
  },
  jewelry: {
    项链: d(1, ALL_SEASONS, ['date', 'formal', 'casual'], ['minimal', 'sweet']),
    耳饰: d(1, ALL_SEASONS, ['date', 'formal', 'casual'], ['minimal', 'sweet']),
    手表: d(1, ALL_SEASONS, ['commute', 'formal', 'casual'], ['business', 'minimal']),
    手链: d(1, ALL_SEASONS, ['casual', 'date'], ['minimal']),
    眼镜: d(1, ALL_SEASONS, ['commute', 'casual'], ['minimal', 'vintage']),
  },
};

/**
 * 只知道大类、款式没认出来时用的默认值（按轮廓只猜到"上衣"的长袖衣服最常见）。
 * 取这一类里最常见、最不容易出错的值：上衣按春秋的长袖、外套按春秋的薄外套。
 */
export const CATEGORY_DEFAULTS: Record<Category, SubtypeDefaults> = {
  top: d(2, MILD_SEASONS, ['casual', 'commute'], ['casual', 'minimal'], { fit: 'regular', length: 'regular' }),
  bottom: d(2, ALL_SEASONS, ['casual', 'commute'], ['casual', 'minimal'], { fit: 'regular', length: 'long', rise: 'mid' }),
  dress: d(1, WARM_SEASONS, ['casual', 'date'], ['minimal', 'sweet'], { fit: 'regular', length: 'regular', rise: 'mid' }),
  outer: d(2, MILD_SEASONS, ['casual', 'commute'], ['casual', 'minimal'], { fit: 'regular', length: 'regular' }),
  shoes: d(2, ALL_SEASONS, ['casual', 'commute', 'travel'], ['casual', 'minimal']),
  bag: d(1, ALL_SEASONS, ['casual', 'commute'], ['casual', 'minimal']),
  hat: d(1, ALL_SEASONS, ['casual', 'travel'], ['casual']),
  scarf: d(2, COLD_SEASONS, ['casual', 'commute'], ['minimal', 'casual']),
  belt: d(1, ALL_SEASONS, ['casual', 'commute'], ['minimal']),
  jewelry: d(1, ALL_SEASONS, ['casual', 'date'], ['minimal']),
};

export function subtypesOf(category: Category): string[] {
  return Object.keys(SUBTYPES[category]);
}

export function defaultsFor(category: Category, subtype: string): SubtypeDefaults | undefined {
  return SUBTYPES[category][subtype];
}

/** 自动分类用的默认值：认出款式时按款式，只认出大类时按大类 */
export function classificationDefaults(category: Category, subtype: string): SubtypeDefaults {
  return (subtype ? SUBTYPES[category][subtype] : undefined) ?? CATEGORY_DEFAULTS[category];
}

// 风格兼容度（0~1，对称）。未列出的组合默认 0.65。
const STYLE_COMPAT_PAIRS: Array<[Style, Style, number]> = [
  ['minimal', 'casual', 0.85],
  ['minimal', 'business', 0.9],
  ['minimal', 'sporty', 0.6],
  ['minimal', 'street', 0.7],
  ['minimal', 'vintage', 0.8],
  ['minimal', 'sweet', 0.8],
  ['minimal', 'outdoor', 0.6],
  ['casual', 'business', 0.55],
  ['casual', 'sporty', 0.8],
  ['casual', 'street', 0.85],
  ['casual', 'vintage', 0.75],
  ['casual', 'sweet', 0.7],
  ['casual', 'outdoor', 0.8],
  ['business', 'sporty', 0.2],
  ['business', 'street', 0.35],
  ['business', 'vintage', 0.6],
  ['business', 'sweet', 0.5],
  ['business', 'outdoor', 0.2],
  ['sporty', 'street', 0.8],
  ['sporty', 'vintage', 0.35],
  ['sporty', 'sweet', 0.35],
  ['sporty', 'outdoor', 0.85],
  ['street', 'vintage', 0.65],
  ['street', 'sweet', 0.45],
  ['street', 'outdoor', 0.7],
  ['vintage', 'sweet', 0.7],
  ['vintage', 'outdoor', 0.45],
  ['sweet', 'outdoor', 0.3],
];

const STYLE_COMPAT = new Map<string, number>();
for (const [a, b, v] of STYLE_COMPAT_PAIRS) {
  STYLE_COMPAT.set(`${a}|${b}`, v);
  STYLE_COMPAT.set(`${b}|${a}`, v);
}

export function styleCompat(a: Style, b: Style): number {
  if (a === b) return 1;
  return STYLE_COMPAT.get(`${a}|${b}`) ?? 0.65;
}
