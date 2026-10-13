// 本地规则推荐引擎。
// 流程：筛选可用单品 → 枚举上下装/连衣裙 → 叠加外套 → 选鞋 → 按需加配饰 → 打分 → 选出彼此差异较大的几套。
// 每一项得分都附带中文理由，界面直接展示"为什么这样搭"。

import {
  CATEGORY_LABELS,
  LAYER_ORDER,
  MAIN_CATEGORIES,
  OCCASION_LABELS,
  STYLE_LABELS,
  styleCompat,
} from './catalog';
import { chroma, hexToLab, hue, hueDiff, isNeutralColor, seededRandom, type Lab } from './color';
import { daysBetween, wearStats, type WearStat } from './stats';
import type {
  BodyGoal,
  Category,
  FeedbackState,
  Item,
  Note,
  Occasion,
  Style,
  WearRecord,
  WeatherInput,
} from './types';
import { bigDiurnalRange, seasonsForTemp, warmthTarget } from './weather';

export interface RecommendContext {
  items: Item[];
  weather: WeatherInput;
  occasion: Occasion | null;
  goals: BodyGoal[];
  records: WearRecord[];
  feedback: FeedbackState;
  /** YYYY-MM-DD */
  today: string;
  rotation: boolean;
}

export type PartKey = 'color' | 'weather' | 'occasion' | 'style' | 'body' | 'rotation' | 'feedback';

export const PART_LABELS: Record<PartKey, string> = {
  color: '配色',
  weather: '天气',
  occasion: '场合',
  style: '风格',
  body: '身材',
  rotation: '轮换',
  feedback: '偏好',
};

export const PART_KEYS: PartKey[] = ['color', 'weather', 'occasion', 'style', 'body', 'rotation', 'feedback'];

export const WEIGHTS: Record<PartKey, number> = {
  color: 0.28,
  weather: 0.22,
  occasion: 0.16,
  style: 0.12,
  body: 0.1,
  rotation: 0.07,
  feedback: 0.05,
};

export interface ScorePart {
  /** 0~1 */
  score: number;
  notes: Note[];
}

export interface OutfitEvaluation {
  /** 按人台叠放顺序排列 */
  items: Item[];
  /** 0~100 */
  score: number;
  parts: Record<PartKey, ScorePart>;
  signature: string;
}

export interface RecommendResult {
  outfits: OutfitEvaluation[];
  /** 全局提示，如衣橱单品不足、已放宽筛选条件 */
  notes: Note[];
}

interface Prepared extends RecommendContext {
  stats: Map<string, WearStat>;
  recentSignatures: Set<string>;
  labCache: Map<string, Lab>;
}

// ---------- 工具函数 ----------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function byCat(items: Item[], c: Category): Item | undefined {
  return items.find((i) => i.category === c);
}

function isMain(i: Item): boolean {
  return MAIN_CATEGORIES.includes(i.category);
}

/** 用于识别"同一套"的签名：主体单品 + 鞋 */
export function signatureOf(items: Item[]): string {
  return items
    .filter((i) => isMain(i) || i.category === 'shoes')
    .map((i) => i.id)
    .sort()
    .join(',');
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function sortByLayer(items: Item[]): Item[] {
  return items.slice().sort((a, b) => LAYER_ORDER[a.category] - LAYER_ORDER[b.category]);
}

function names(items: Item[]): string {
  return items.map((i) => i.name).join('、');
}

function prepare(ctx: RecommendContext): Prepared {
  const stats = wearStats(ctx.records);
  const recentSignatures = new Set<string>();
  for (const r of ctx.records) {
    const d = daysBetween(r.date, ctx.today);
    if (d >= 0 && d <= 14) {
      const sig = r.itemIds
        .map((id) => ctx.items.find((i) => i.id === id))
        .filter((i): i is Item => !!i);
      recentSignatures.add(signatureOf(sig));
    }
  }
  return { ...ctx, stats, recentSignatures, labCache: new Map() };
}

function labOf(p: Prepared, item: Item): Lab {
  let lab = p.labCache.get(item.id);
  if (!lab) {
    lab = hexToLab(item.color.hex);
    p.labCache.set(item.id, lab);
  }
  return lab;
}

function lightness(p: Prepared, item: Item): number {
  return labOf(p, item)[0];
}

// ---------- 各项打分 ----------

const COLOR_WEIGHT: Partial<Record<Category, number>> = {
  top: 1,
  bottom: 1,
  dress: 1.6,
  outer: 1.1,
  shoes: 0.6,
  bag: 0.5,
  hat: 0.5,
  scarf: 0.5,
  belt: 0.3,
};

interface AccentGroup {
  name: string;
  hue: number;
  chroma: number;
  weight: number;
}

function colorPart(p: Prepared, items: Item[]): ScorePart {
  const notes: Note[] = [];
  const pieces = items
    .filter((i) => i.category !== 'jewelry')
    .map((i) => ({ item: i, lab: labOf(p, i), w: COLOR_WEIGHT[i.category] ?? 0.3 }));
  const groups: AccentGroup[] = [];
  const addAccent = (name: string, lab: Lab, w: number) => {
    const h = hue(lab);
    const g = groups.find((x) => hueDiff(x.hue, h) < 30);
    if (g) {
      g.weight += w;
      if (w > 0.5) g.name = g.name || name;
    } else {
      groups.push({ name, hue: h, chroma: chroma(lab), weight: w });
    }
  };
  for (const pc of pieces) {
    if (!isNeutralColor(pc.item.color.hex, pc.item.color.name)) addAccent(pc.item.color.name, pc.lab, pc.w);
    if (pc.item.color2 && pc.item.pattern !== 'solid' && !isNeutralColor(pc.item.color2.hex, pc.item.color2.name)) {
      addAccent(pc.item.color2.name, hexToLab(pc.item.color2.hex), pc.w * 0.4);
    }
  }
  groups.sort((a, b) => b.weight - a.weight);
  const major = groups.filter((g) => g.weight >= 0.45);
  let score: number;
  if (major.length === 0) {
    if (groups.length > 0) {
      score = 0.95;
      notes.push({ kind: 'good', text: `中性色为主，${groups[0].name}做小面积点缀` });
    } else {
      const ls = pieces.filter((x) => isMain(x.item)).map((x) => x.lab[0]);
      const spread = ls.length ? Math.max(...ls) - Math.min(...ls) : 0;
      if (ls.length >= 2 && spread < 12) {
        score = 0.74;
        notes.push({ kind: 'info', text: '全身中性色且深浅接近，略显平淡，可加一件亮色配饰' });
      } else {
        score = 0.86;
        notes.push({ kind: 'good', text: '中性色搭配，深浅有层次，稳妥耐看' });
      }
    }
  } else if (major.length === 1) {
    const g = major[0];
    if (g.weight >= 2.2) {
      score = 0.86;
      notes.push({ kind: 'good', text: `${g.name}同色系一身，整体统一` });
    } else {
      score = 1;
      notes.push({ kind: 'good', text: `中性色打底，${g.name}作为重点色` });
    }
    for (const minor of groups.slice(1)) {
      if (hueDiff(minor.hue, g.hue) > 60 && minor.chroma > 40 && g.chroma > 40) {
        score -= 0.1;
        notes.push({ kind: 'warn', text: `${minor.name}与${g.name}不太协调` });
        break;
      }
    }
  } else if (major.length === 2) {
    const [a, b] = major;
    const dh = hueDiff(a.hue, b.hue);
    const minC = Math.min(a.chroma, b.chroma);
    if (dh < 40) {
      score = 0.88;
      notes.push({ kind: 'good', text: `${a.name}与${b.name}是邻近色，过渡自然` });
    } else if (dh >= 150) {
      if (minC < 38) {
        score = 0.74;
        notes.push({ kind: 'info', text: `${a.name}与${b.name}互为对比色，其中一方较柔和，对比可控` });
      } else {
        score = 0.5;
        notes.push({ kind: 'warn', text: `${a.name}与${b.name}撞色强烈，适合想要醒目效果的时候` });
      }
    } else if (minC > 42) {
      score = 0.38;
      notes.push({ kind: 'warn', text: `${a.name}和${b.name}两种鲜艳颜色不太协调` });
    } else {
      score = 0.62;
      notes.push({ kind: 'info', text: `有两个重点色（${a.name}、${b.name}），略显杂` });
    }
  } else {
    let maxDiff = 0;
    for (let i = 0; i < major.length; i++)
      for (let j = i + 1; j < major.length; j++) maxDiff = Math.max(maxDiff, hueDiff(major[i].hue, major[j].hue));
    if (maxDiff < 60) {
      score = 0.72;
      notes.push({ kind: 'info', text: '多个颜色同属一个色系' });
    } else {
      score = 0.28;
      notes.push({ kind: 'warn', text: `颜色偏多（${major.map((g) => g.name).join('、')}），建议换成中性色单品` });
    }
  }

  const upper = byCat(items, 'top') ?? byCat(items, 'dress');
  const lower = byCat(items, 'bottom');
  if (upper && lower && major.length <= 1) {
    const dl = Math.abs(lightness(p, upper) - lightness(p, lower));
    if (dl >= 25) score += 0.03;
  }

  const patterned = items.filter((i) => isMain(i) && i.pattern !== 'solid');
  if (patterned.length >= 2) {
    score -= 0.25;
    notes.push({ kind: 'warn', text: `${names(patterned)}都有花纹，同时穿容易显乱` });
  }
  return { score: clamp01(score), notes };
}

function weatherPart(p: Prepared, items: Item[]): ScorePart {
  const w = p.weather;
  const t = w.tempC;
  const notes: Note[] = [];
  const target = warmthTarget(t);
  const base = byCat(items, 'top') ?? byCat(items, 'dress');
  const outer = byCat(items, 'outer');
  const scarf = byCat(items, 'scarf');
  const insulation = (base?.warmth ?? 1) + (outer?.warmth ?? 0) + (scarf && scarf.warmth >= 2 ? 1 : 0);
  let score = 1;
  if (insulation < target.min) {
    score -= 0.3 * (target.min - insulation);
    notes.push({ kind: 'warn', text: `${t}°C 保暖不够，建议再加一层或换厚一点的` });
  } else if (insulation > target.max) {
    score -= 0.3 * (insulation - target.max);
    notes.push({ kind: 'warn', text: `穿得偏厚，${t}°C 可能会热` });
  } else {
    notes.push({ kind: 'good', text: `厚薄适合 ${t}°C（${target.label}）` });
  }
  if (target.outer === 'required' && !outer) {
    score -= 0.25;
    notes.push({ kind: 'warn', text: '气温较低，建议加外套' });
  }
  if (target.outer === 'avoid' && outer) {
    score -= 0.3;
    notes.push({ kind: 'warn', text: '天气较热，可以不穿外套' });
  }
  if (bigDiurnalRange(w) && t < 24) {
    const diff = (w.tempMax ?? 0) - (w.tempMin ?? 0);
    if (!outer) {
      score -= 0.08;
      notes.push({ kind: 'info', text: `早晚温差 ${diff}°C，可以带一件外套` });
    } else {
      notes.push({ kind: 'good', text: `有外套应对 ${diff}°C 的早晚温差` });
    }
  }
  const bottom = byCat(items, 'bottom');
  if (bottom?.length === 'short' && t < 20) {
    score -= t < 15 ? 0.45 : 0.2;
    notes.push({ kind: 'warn', text: `${bottom.name}偏短，${t}°C 腿部会冷` });
  }
  if (bottom && bottom.warmth >= 3 && t >= 26) {
    score -= 0.25;
    notes.push({ kind: 'warn', text: `${bottom.name}偏厚，天气较热` });
  }
  const dress = byCat(items, 'dress');
  if (dress?.length === 'short' && t < 16) {
    score -= 0.25;
    notes.push({ kind: 'warn', text: `${dress.name}偏短，${t}°C 会冷` });
  }
  const shoes = byCat(items, 'shoes');
  if (shoes?.subtype === '凉鞋' && t < 20) {
    score -= 0.3;
    notes.push({ kind: 'warn', text: '凉鞋不适合当前气温' });
  }
  if (shoes?.subtype === '靴子' && t >= 25) {
    score -= 0.25;
    notes.push({ kind: 'warn', text: '靴子在这个气温下偏热' });
  }
  if (w.rain) {
    const risky = items.filter(
      (i) =>
        (i.category === 'shoes' && (i.subtype === '帆布鞋' || /麂皮|绒面|帆布/.test(i.material ?? ''))) ||
        (i.category === 'bottom' && i.length !== 'short' && lightness(p, i) > 82),
    );
    if (risky.length) {
      score -= 0.15;
      notes.push({ kind: 'warn', text: `有雨，${names(risky)}容易弄脏或进水` });
    }
  }
  const allowed = seasonsForTemp(t);
  const off = items.filter(
    (i) => (isMain(i) || i.category === 'shoes') && i.seasons.length > 0 && !i.seasons.some((s) => allowed.includes(s)),
  );
  if (off.length) {
    score -= 0.12 * off.length;
    notes.push({ kind: 'info', text: `${names(off)}的季节标签与当前气温不太符合` });
  }
  return { score: clamp01(score), notes };
}

function occasionPart(p: Prepared, items: Item[]): ScorePart {
  const occ = p.occasion;
  if (!occ) return { score: 0.8, notes: [] };
  const label = OCCASION_LABELS[occ];
  const notes: Note[] = [];
  let sum = 0;
  let wsum = 0;
  const mismatched: Item[] = [];
  for (const i of items) {
    const w = isMain(i) ? 1 : i.category === 'shoes' ? 0.6 : i.category === 'bag' ? 0.3 : 0;
    if (w === 0) continue;
    let s: number;
    if (i.occasions.length === 0) s = 0.7;
    else if (i.occasions.includes(occ)) s = 1;
    else {
      s = 0.15;
      mismatched.push(i);
    }
    sum += s * w;
    wsum += w;
  }
  if (wsum === 0) return { score: 0.8, notes: [] };
  if (mismatched.length) notes.push({ kind: 'warn', text: `${names(mismatched)}不太适合${label}场合` });
  else if (items.filter(isMain).every((i) => i.occasions.includes(occ)))
    notes.push({ kind: 'good', text: `主要单品都适合${label}` });
  return { score: clamp01(sum / wsum), notes };
}

function bestStyleCompat(a: Style[], b: Style[]): number {
  let best = 0;
  for (const s of a) for (const t of b) best = Math.max(best, styleCompat(s, t));
  return best;
}

function stylePart(items: Item[]): ScorePart {
  const pieces = items.filter((i) => (isMain(i) || i.category === 'shoes') && i.styles.length > 0);
  if (pieces.length < 2) return { score: 0.75, notes: [] };
  const notes: Note[] = [];
  let sum = 0;
  let n = 0;
  let worst: { a: Item; b: Item; v: number } | null = null;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const v = bestStyleCompat(pieces[i].styles, pieces[j].styles);
      sum += v;
      n++;
      if (!worst || v < worst.v) worst = { a: pieces[i], b: pieces[j], v };
    }
  }
  const avg = sum / n;
  if (worst && worst.v < 0.45) {
    notes.push({
      kind: 'warn',
      text: `${worst.a.name}偏${STYLE_LABELS[worst.a.styles[0]]}，${worst.b.name}偏${STYLE_LABELS[worst.b.styles[0]]}，风格有点跳`,
    });
  } else if (avg >= 0.85) {
    const counts = new Map<Style, number>();
    for (const pc of pieces) for (const s of pc.styles) counts.set(s, (counts.get(s) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    notes.push({ kind: 'good', text: `风格统一，整体偏${STYLE_LABELS[top]}` });
  }
  return { score: clamp01(avg), notes };
}

function bodyPart(p: Prepared, items: Item[]): ScorePart {
  if (p.goals.length === 0) return { score: 0.75, notes: [] };
  const top = byCat(items, 'top');
  const bottom = byCat(items, 'bottom');
  const dress = byCat(items, 'dress');
  const belt = byCat(items, 'belt');
  const shoes = byCat(items, 'shoes');
  const notes: Note[] = [];
  const good = (text: string) => notes.push({ kind: 'good', text });
  const warn = (text: string) => notes.push({ kind: 'warn', text });
  const scores: number[] = [];

  for (const goal of p.goals) {
    let s = 0.7;
    switch (goal) {
      case 'lengthen_legs':
        if (bottom?.rise === 'high') {
          s += 0.18;
          good('高腰下装拉长腿部线条');
        } else if (bottom?.rise === 'low') {
          s -= 0.15;
          warn('低腰下装会让腿显短');
        }
        if (dress?.rise === 'high') {
          s += 0.12;
          good('高腰线连衣裙拉长下半身');
        }
        if (top && bottom) {
          if (top.length === 'short') {
            s += 0.08;
            good('短款上衣露出腰线，腿部显长');
          } else if (top.length === 'long') {
            s -= 0.15;
            warn('长款上衣盖住腰线，腿部显短，可以塞进裤腰');
          }
        }
        if (bottom && shoes && bottom.length !== 'short' && Math.abs(lightness(p, bottom) - lightness(p, shoes)) < 15) {
          s += 0.06;
          good('鞋裤颜色接近，腿部线条延伸');
        }
        break;
      case 'balance_upper':
        if (bottom?.fit === 'loose') {
          s += 0.15;
          good('下装有体量，平衡上身');
        }
        if (top?.fit === 'loose' && bottom?.fit === 'slim') {
          s -= 0.18;
          warn('上宽下窄会放大上身');
        }
        if (top && bottom && lightness(p, top) < lightness(p, bottom) - 15) {
          s += 0.06;
          good('上深下浅，上身视觉收敛');
        }
        break;
      case 'balance_lower':
        if (top && bottom) {
          const lt = lightness(p, top);
          const lb = lightness(p, bottom);
          if (lb < lt - 15) {
            s += 0.15;
            good('下深上浅，视觉重心上移');
          } else if (lb > lt + 15) {
            s -= 0.08;
            warn('下装比上衣浅，会放大下半身');
          }
        }
        if (bottom?.fit === 'slim') {
          s -= 0.1;
          warn('紧身下装会突出下半身');
        }
        if (dress?.fit === 'loose' || (bottom && bottom.subtype.includes('裙') && bottom.fit !== 'slim')) s += 0.06;
        break;
      case 'define_waist':
        if (belt) {
          s += 0.15;
          good('腰带强调腰线');
        }
        if (bottom?.rise === 'high' || dress?.rise === 'high') s += 0.08;
        if (top && (top.length === 'short' || top.fit === 'slim')) {
          s += 0.06;
          good('短款或修身上衣勾勒腰线');
        }
        if (dress?.fit === 'slim') s += 0.06;
        if (top?.fit === 'loose' && top.length !== 'short' && bottom?.fit === 'loose' && !belt) {
          s -= 0.18;
          warn('上下都宽松又没有腰带，腰线不明显');
        }
        break;
    }
    scores.push(clamp01(s));
  }
  const unique = notes.filter((n, i) => notes.findIndex((m) => m.text === n.text) === i);
  return { score: scores.reduce((a, b) => a + b, 0) / scores.length, notes: unique };
}

function rotationPart(p: Prepared, items: Item[]): ScorePart {
  if (!p.rotation) return { score: 0.7, notes: [] };
  let s = 0.7;
  const notes: Note[] = [];
  let goodCount = 0;
  for (const i of items.filter(isMain)) {
    const last = p.stats.get(i.id)?.last ?? null;
    const days = last ? daysBetween(last, p.today) : null;
    if (days === null) {
      s += 0.1;
      if (goodCount++ < 1) notes.push({ kind: 'good', text: `${i.name}还没穿过，可以试试` });
    } else if (days <= 0) {
      s -= 0.3;
      notes.push({ kind: 'warn', text: `${i.name}今天已经记录过` });
    } else if (days <= 2) {
      s -= 0.3;
      notes.push({ kind: 'warn', text: `${i.name}${days === 1 ? '昨天' : '前天'}刚穿过` });
    } else if (days <= 5) {
      s -= 0.1;
    } else if (days >= 21) {
      s += 0.12;
      if (goodCount++ < 1) notes.push({ kind: 'good', text: `${i.name}已经 ${days} 天没穿了` });
    }
  }
  if (p.recentSignatures.has(signatureOf(items))) {
    s -= 0.25;
    notes.push({ kind: 'warn', text: '两周内穿过完全相同的一套' });
  }
  return { score: clamp01(s), notes };
}

function feedbackPart(p: Prepared, items: Item[]): ScorePart {
  const notes: Note[] = [];
  if (p.feedback.dislikedOutfits.includes(signatureOf(items))) {
    return { score: 0, notes: [{ kind: 'warn', text: '你之前标记过不喜欢这一套' }] };
  }
  const pieces = items.filter((i) => isMain(i) || i.category === 'shoes');
  let sum = 0;
  let worst: { a: Item; b: Item; v: number } | null = null;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const v = p.feedback.pairs[pairKey(pieces[i].id, pieces[j].id)] ?? 0;
      sum += v;
      if (!worst || v < worst.v) worst = { a: pieces[i], b: pieces[j], v };
    }
  }
  if (worst && worst.v <= -2) notes.push({ kind: 'warn', text: `你之前不喜欢${worst.a.name}和${worst.b.name}一起穿` });
  else if (sum >= 2) notes.push({ kind: 'good', text: '和你喜欢的组合相近' });
  return { score: clamp01(0.7 + 0.08 * sum), notes };
}

// ---------- 整体评估 ----------

function evaluateWith(p: Prepared, items: Item[], skipWeather = false): OutfitEvaluation {
  const sorted = sortByLayer(items);
  const parts: Record<PartKey, ScorePart> = {
    color: colorPart(p, sorted),
    weather: skipWeather ? { score: 0.8, notes: [] } : weatherPart(p, sorted),
    occasion: occasionPart(p, sorted),
    style: stylePart(sorted),
    body: bodyPart(p, sorted),
    rotation: rotationPart(p, sorted),
    feedback: feedbackPart(p, sorted),
  };
  let total = 0;
  for (const k of PART_KEYS) total += WEIGHTS[k] * parts[k].score;
  const favBonus = Math.min(4, sorted.filter((i) => i.favorite && isMain(i)).length * 2);
  const score = Math.max(0, Math.min(100, Math.round(total * 100 + favBonus)));
  return { items: sorted, score, parts, signature: signatureOf(sorted) };
}

/** 评估任意一组单品（试搭页使用） */
export function evaluateOutfit(items: Item[], ctx: RecommendContext): OutfitEvaluation {
  return evaluateWith(prepare(ctx), items);
}

/** 汇总展示用的理由：优点在前，问题在后 */
export function summarizeNotes(e: OutfitEvaluation, maxGood = 3, maxWarn = 3): Note[] {
  const goods: Note[] = [];
  const warns: Note[] = [];
  const infos: Note[] = [];
  const order = PART_KEYS.slice().sort((a, b) => WEIGHTS[b] - WEIGHTS[a]);
  for (const k of order) {
    for (const n of e.parts[k].notes) {
      if (n.kind === 'good') goods.push(n);
      else if (n.kind === 'warn') warns.push(n);
      else infos.push(n);
    }
  }
  return goods.slice(0, maxGood).concat(warns.slice(0, maxWarn), infos.slice(0, 1));
}

// ---------- 候选生成 ----------

/**
 * 单品是否可进入候选池。
 * level 0：季节和场合都要匹配；level 1：忽略季节标签；level 2：只排除明显不合时宜的单品。
 */
function eligible(p: Prepared, item: Item, level: number): boolean {
  if (item.status !== 'active') return false;
  const t = p.weather.tempC;
  // 极端不合适的情况任何级别都排除
  if ((item.category === 'top' || item.category === 'dress' || item.category === 'outer') && item.warmth === 3 && t >= 26)
    return false;
  if (item.category === 'outer' && t >= 28) return false;
  if (item.category === 'bottom' && item.length === 'short' && t < 12) return false;
  if (item.category === 'dress' && item.length === 'short' && t < 10) return false;
  if (item.category === 'shoes' && item.subtype === '凉鞋' && t < 12) return false;
  if (item.category === 'outer' && item.subtype === '羽绒服' && t >= 18) return false;
  if (item.category === 'scarf' && item.warmth >= 2 && t >= 15) return false;
  if (item.category === 'hat' && item.subtype === '针织帽' && t >= 15) return false;
  if (level <= 1 && p.occasion && item.occasions.length > 0 && !item.occasions.includes(p.occasion)) {
    if (isMain(item) || item.category === 'shoes' || item.category === 'bag') return false;
  }
  if (level === 0 && item.seasons.length > 0) {
    const allowed = seasonsForTemp(t);
    if (!item.seasons.some((s) => allowed.includes(s))) return false;
  }
  return true;
}

export interface RecommendOptions {
  count?: number;
  /** 不再推荐的签名（例如"换一批"时排除已展示过的） */
  exclude?: string[];
  /** 给排序加入少量随机扰动，用于"换一批" */
  seed?: number;
}

function countCats(items: Item[]): Record<Category, number> {
  const c = { top: 0, bottom: 0, dress: 0, outer: 0, shoes: 0, bag: 0, hat: 0, scarf: 0, belt: 0, jewelry: 0 } as Record<
    Category,
    number
  >;
  for (const i of items) c[i.category]++;
  return c;
}

export function recommend(ctx: RecommendContext, options: RecommendOptions = {}): RecommendResult {
  const count = options.count ?? 3;
  const p = prepare(ctx);
  const notes: Note[] = [];
  const active = ctx.items.filter((i) => i.status === 'active');
  const all = countCats(active);
  if (all.dress === 0 && (all.top === 0 || all.bottom === 0)) {
    const need: string[] = [];
    if (all.top === 0) need.push('上衣');
    if (all.bottom === 0) need.push('下装');
    notes.push({
      kind: 'info',
      text: `衣橱里还缺少${need.join('和')}。至少需要 1 件上衣 + 1 件下装，或 1 件连衣裙，才能生成推荐。`,
    });
    return { outfits: [], notes };
  }

  const exclude = new Set(options.exclude ?? []);
  const rand = options.seed !== undefined ? seededRandom(options.seed) : null;
  const jitter = new Map<string, number>();
  const rankScore = (e: OutfitEvaluation) => {
    if (!rand) return e.score;
    let j = jitter.get(e.signature);
    if (j === undefined) {
      j = (rand() - 0.5) * 8;
      jitter.set(e.signature, j);
    }
    return e.score + j;
  };

  let pool: Item[] = [];
  let final: OutfitEvaluation[] = [];
  const relaxed = active.filter((i) => eligible(p, i, 2));
  for (let level = 0; level <= 2; level++) {
    pool = active.filter((i) => eligible(p, i, level));
    // 鞋和外套如果在严格条件下一件都没有，就用放宽后的候选补上，避免整套缺鞋或冷天缺外套
    for (const cat of ['shoes', 'outer'] as Category[]) {
      if (!pool.some((i) => i.category === cat)) pool = pool.concat(relaxed.filter((i) => i.category === cat));
    }
    final = buildCandidates(p, pool, exclude);
    if (final.length >= count || level === 2) {
      if (level === 1 && final.length > 0) notes.push({ kind: 'info', text: '符合当前季节标签的单品较少，已放宽季节条件' });
      if (level === 2 && final.length > 0 && ctx.occasion)
        notes.push({
          kind: 'info',
          text: `适合${OCCASION_LABELS[ctx.occasion]}场合的单品不足，部分推荐包含其他场合的单品`,
        });
      break;
    }
  }

  if (final.length === 0) {
    notes.push({ kind: 'info', text: '当前气温下没有合适的组合，可以检查一下单品的保暖度和长度设置' });
    return { outfits: [], notes };
  }

  // 选出彼此差异较大的几套：和已选套装共用的主体单品越多，排序分扣得越多
  const chosen: OutfitEvaluation[] = [];
  const remaining = final.slice();
  while (chosen.length < count && remaining.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const c = remaining[k];
      let penalty = 0;
      for (const prev of chosen) {
        const prevIds = new Set(prev.items.map((i) => i.id));
        for (const i of c.items) {
          if (!prevIds.has(i.id)) continue;
          if (isMain(i)) penalty += 10;
          else if (i.category === 'shoes') penalty += 4;
        }
      }
      const v = rankScore(c) - penalty;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = k;
      }
    }
    chosen.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return { outfits: chosen.sort((a, b) => b.score - a.score), notes };
}

function buildCandidates(p: Prepared, pool: Item[], exclude: Set<string>): OutfitEvaluation[] {
  const of = (c: Category) => pool.filter((i) => i.category === c);
  const tops = of('top');
  const bottoms = of('bottom');
  const dresses = of('dress');
  const outers = of('outer');
  const shoes = of('shoes');

  // A. 上下装 / 连衣裙
  const bases: OutfitEvaluation[] = [];
  for (const t of tops) for (const b of bottoms) bases.push(evaluateWith(p, [t, b], true));
  for (const d of dresses) bases.push(evaluateWith(p, [d], true));
  if (bases.length === 0) return [];
  bases.sort((a, b) => b.score - a.score);
  const topBases = bases.slice(0, 40);

  // B. 外套
  const need = warmthTarget(p.weather.tempC).outer;
  const withOuter: OutfitEvaluation[] = [];
  for (const base of topBases) {
    const options: Array<Item | null> =
      need === 'avoid' ? [null] : need === 'required' && outers.length > 0 ? outers : [null, ...outers];
    for (const o of options) withOuter.push(evaluateWith(p, o ? [...base.items, o] : base.items));
  }
  withOuter.sort((a, b) => b.score - a.score);
  const stageB = withOuter.slice(0, 60);

  // C. 鞋：每套选得分最高的一双
  const withShoes: OutfitEvaluation[] = [];
  for (const c of stageB) {
    if (shoes.length === 0) {
      withShoes.push(c);
      continue;
    }
    let best: OutfitEvaluation | null = null;
    for (const s of shoes) {
      const e = evaluateWith(p, [...c.items, s]);
      if (!best || e.score > best.score) best = e;
    }
    if (best) withShoes.push(best);
  }
  withShoes.sort((a, b) => b.score - a.score);

  // D. 配饰：能提高得分才加
  const result: OutfitEvaluation[] = [];
  const seen = new Set<string>();
  for (const c of withShoes.slice(0, 24)) {
    if (exclude.has(c.signature) || seen.has(c.signature)) continue;
    seen.add(c.signature);
    result.push(addAccessories(p, c, pool));
  }
  return result.sort((a, b) => b.score - a.score);
}

const ACCESSORY_ORDER: Category[] = ['scarf', 'belt', 'bag', 'hat', 'jewelry'];

function addAccessories(p: Prepared, base: OutfitEvaluation, pool: Item[]): OutfitEvaluation {
  let current = base;
  for (const cat of ACCESSORY_ORDER) {
    if (cat === 'belt' && !current.items.some((i) => i.category === 'bottom' || i.category === 'dress')) continue;
    const candidates = pool.filter((i) => i.category === cat);
    if (candidates.length === 0) continue;
    let best: OutfitEvaluation | null = null;
    for (const a of candidates) {
      const e = evaluateWith(p, [...current.items, a]);
      if (!best || e.score > best.score) best = e;
    }
    if (!best) continue;
    // 冷天优先加围巾：只要不明显拉低得分
    const coldScarf = cat === 'scarf' && p.weather.tempC < 8 && best.score >= current.score - 1;
    if (best.score > current.score || coldScarf) current = best;
  }
  return current;
}

/**
 * "换一件"：把套装中某个类别的单品换成其他候选，按得分从高到低返回。
 * 对外套和配饰，返回结果中包含"去掉这一件"的选项。
 */
export function swapAlternatives(current: Item[], category: Category, ctx: RecommendContext): OutfitEvaluation[] {
  const p = prepare(ctx);
  const rest = current.filter((i) => i.category !== category);
  const currentIds = new Set(current.map((i) => i.id));
  const pool = ctx.items.filter((i) => i.category === category && !currentIds.has(i.id) && eligible(p, i, 2));
  const out = pool.map((i) => evaluateWith(p, [...rest, i]));
  const optional = category === 'outer' || ['bag', 'hat', 'scarf', 'belt', 'jewelry'].includes(category);
  if (optional && current.some((i) => i.category === category)) out.push(evaluateWith(p, rest));
  return out.sort((a, b) => b.score - a.score);
}

export type FeedbackKind = 'like' | 'dislike' | 'worn';

/** 根据用户操作更新组合偏好 */
export function applyFeedback(state: FeedbackState, items: Item[], kind: FeedbackKind): FeedbackState {
  const pieces = items.filter((i) => isMain(i) || i.category === 'shoes');
  const delta = kind === 'like' ? 1 : kind === 'worn' ? 0.5 : -1.5;
  const pairs = { ...state.pairs };
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const key = pairKey(pieces[i].id, pieces[j].id);
      pairs[key] = Math.max(-5, Math.min(5, (pairs[key] ?? 0) + delta));
    }
  }
  let disliked = state.dislikedOutfits;
  if (kind === 'dislike') {
    const sig = signatureOf(items);
    disliked = [sig, ...disliked.filter((s) => s !== sig)].slice(0, 200);
  }
  return { pairs, dislikedOutfits: disliked };
}

export function emptyFeedback(): FeedbackState {
  return { pairs: {}, dislikedOutfits: [] };
}

/** 说明一个类别在套装中的角色，用于"换一件"按钮 */
export function slotLabel(category: Category): string {
  return CATEGORY_LABELS[category];
}
