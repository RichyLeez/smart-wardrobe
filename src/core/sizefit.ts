// 号型与身材对比：判断一件衣服对你来说偏大、合身还是偏小，并据此推算"你穿上的实际版型"。
//
// 依据 GB/T 1335 服装号型：号 = 身高，型 = 净胸围（上装）或净腰围（下装），
// 字母是体型（按胸腰差分 Y、A、B、C）。相邻号型之间，上装胸围差 4cm，下装腰围差 2cm，身高差 5cm。
// 这些都是对"设计时参照的人体"的估算，同一号型在不同品牌的实际尺寸仍有差别。

import type { BodyProfile, Category, Fit, Gender, Note } from './types';

export type BodyType = 'Y' | 'A' | 'B' | 'C';

export interface SizeCode {
  height: number;
  girth: number;
  bodyType?: BodyType;
}

export function parseSizeCode(text: string | undefined): SizeCode | null {
  if (!text) return null;
  const m = text
    .normalize('NFKC')
    .toUpperCase()
    .match(/(1[4-9]\d)\s*\/\s*(\d{2,3})\s*([YABC])?/);
  if (!m) return null;
  const girth = Number(m[2]);
  if (girth < 50 || girth > 140) return null;
  return { height: Number(m[1]), girth, bodyType: m[3] as BodyType | undefined };
}

/** 牛仔裤常用英寸腰围尺码：29、W29、W29L32 */
export function jeansWaistInches(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/^\s*W?\s*(2[3-9]|3\d|4[0-4])(?:\s*L\s*\d{2})?\s*$/);
  return m ? Number(m[1]) : null;
}

/** 胸腰差对应的体型（GB/T 1335.1 男子、1335.2 女子） */
const BODY_TYPE_RANGES: Record<Exclude<Gender, 'unspecified'>, Record<BodyType, [number, number]>> = {
  male: { Y: [17, 22], A: [12, 16], B: [7, 11], C: [2, 6] },
  female: { Y: [19, 24], A: [14, 18], B: [9, 13], C: [4, 8] },
};
const TYPE_ORDER: BodyType[] = ['Y', 'A', 'B', 'C'];

export function bodyTypeOf(body: BodyProfile): BodyType | null {
  if (body.gender === 'unspecified') return null;
  const drop = body.chest - body.waist;
  const ranges = BODY_TYPE_RANGES[body.gender];
  let best: BodyType = 'A';
  let bestDist = Infinity;
  for (const t of TYPE_ORDER) {
    const [lo, hi] = ranges[t];
    const dist = drop < lo ? lo - drop : drop > hi ? drop - hi : 0;
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

const FIT_ORDER: Fit[] = ['slim', 'regular', 'loose'];
const FIT_NAMES: Record<Fit, string> = { slim: '修身', regular: '常规', loose: '宽松' };

function sizeWord(steps: number): string {
  const n = Math.abs(steps);
  if (n < 1.25) return '一号';
  if (n < 1.75) return '一号半';
  if (n < 2.5) return '两号';
  return `${Math.round(n)} 号`;
}

function shiftFit(base: Fit, steps: number): Fit {
  const shift = steps >= 1.75 ? 2 : steps >= 0.75 ? 1 : steps <= -1.75 ? -2 : steps <= -0.75 ? -1 : 0;
  const i = Math.min(2, Math.max(0, FIT_ORDER.indexOf(base) + shift));
  return FIT_ORDER[i];
}

export interface SizeFitResult {
  notes: Note[];
  /** 结合吊牌版型和尺码差，估计你穿上的实际版型 */
  effectiveFit?: Fit;
  /** 正数表示衣服比你的身材大，单位：号 */
  steps?: number;
}

export interface SizeFitInput {
  category: Category;
  subtype?: string;
  /** 吊牌标注的版型（没有时按常规算） */
  fit?: Fit;
  /** 尺码或号型原文 */
  size?: string;
}

/** 下装（裤、半身裙）的号型按腰围，其余按胸围 */
function isLowerGarment(category: Category): boolean {
  return category === 'bottom';
}

export function analyzeSizeFit(input: SizeFitInput, body: BodyProfile | null): SizeFitResult | null {
  if (!['top', 'bottom', 'dress', 'outer'].includes(input.category)) return null;
  const size = input.size?.trim();
  if (!size) return null;
  const code = parseSizeCode(size);
  const inches = input.category === 'bottom' ? jeansWaistInches(size) : null;
  if (!code && !inches) {
    return {
      notes: [
        {
          kind: 'info',
          text: `只有尺码 ${size}，各品牌对应的身材不一样，没法和你的身材精确比较。吊牌上如果印有 170/92A 这样的号型，填进去就能对比。`,
        },
      ],
    };
  }
  if (!body) {
    return { notes: [{ kind: 'info', text: '填写身材数据后，可以判断这件对你偏大还是偏小。' }] };
  }

  const notes: Note[] = [];
  const lower = isLowerGarment(input.category);
  const base = input.fit ?? 'regular';
  let steps = 0;

  if (code) {
    const ref = lower ? body.waist : body.chest;
    const part = lower ? '腰围' : '胸围';
    const perStep = lower ? 2 : 4;
    const delta = code.girth - ref;
    steps = Math.round((delta / perStep) * 2) / 2;
    const design = `号型 ${code.height}/${code.girth}${code.bodyType ?? ''} 按${part} ${code.girth}cm 的身材设计`;
    if (Math.abs(delta) <= perStep / 2) {
      notes.push({ kind: 'good', text: `${design}，和你的${part}（${ref}cm）基本一致，是你的标准号。` });
    } else if (delta > 0) {
      notes.push({ kind: 'info', text: `${design}，比你的${part}大 ${delta}cm，约大${sizeWord(steps)}，穿上更宽松。` });
    } else {
      notes.push({
        kind: steps <= -1 ? 'warn' : 'info',
        text: `${design}，比你的${part}小 ${-delta}cm，约小${sizeWord(steps)}，可能偏紧。`,
      });
    }
    // 身高：影响衣长、袖长或裤长
    const dh = code.height - body.height;
    const what = lower ? '裤长' : input.category === 'dress' ? '裙长' : '衣长和袖长';
    if (dh >= 5) notes.push({ kind: 'info', text: `按 ${code.height}cm 身高设计，比你高 ${dh}cm，${what}可能偏长。` });
    else if (dh <= -5) notes.push({ kind: 'warn', text: `按 ${code.height}cm 身高设计，比你矮 ${-dh}cm，${what}可能偏短。` });
    // 体型：只对上装比较，下装的体型字母主要影响臀围，这里不展开
    const mine = bodyTypeOf(body);
    if (!lower && code.bodyType && mine && code.bodyType !== mine) {
      const garmentDrop = TYPE_ORDER.indexOf(code.bodyType);
      const myDrop = TYPE_ORDER.indexOf(mine);
      notes.push({
        kind: 'info',
        text:
          myDrop > garmentDrop
            ? `这件按 ${code.bodyType} 体型做（腰比胸收得多），你更接近 ${mine} 体型，腰腹位置可能偏紧。`
            : `这件按 ${code.bodyType} 体型做，你更接近 ${mine} 体型（腰更细），腰部可能略显空。`,
      });
    }
  } else if (inches) {
    const garmentWaist = Math.round(inches * 2.54);
    const delta = garmentWaist - body.waist;
    steps = Math.round((delta / 2.54) * 2) / 2;
    const head = `腰围尺码 ${inches} 大约对应 ${garmentWaist}cm 腰围（各品牌略有差异）`;
    if (Math.abs(delta) <= 2) notes.push({ kind: 'good', text: `${head}，和你的腰围（${body.waist}cm）基本一致。` });
    else if (delta > 0) notes.push({ kind: 'info', text: `${head}，比你的腰围大 ${delta}cm，腰部偏松，可能需要腰带。` });
    else notes.push({ kind: steps <= -1 ? 'warn' : 'info', text: `${head}，比你的腰围小 ${-delta}cm，可能偏紧。` });
  }

  const effectiveFit = shiftFit(base, steps);
  if (effectiveFit !== base) {
    notes.push({
      kind: 'info',
      text: `${input.fit ? `吊牌标注${FIT_NAMES[base]}版` : '按常规版型算'}，${steps > 0 ? '大' : '小'}${sizeWord(steps)}穿，你穿上接近${FIT_NAMES[effectiveFit]}。`,
    });
  } else if (steps <= -0.75 && base === 'slim') {
    notes.push({ kind: 'warn', text: '本来就是修身版，又小了一号，穿着可能紧绷。' });
  }
  return { notes, effectiveFit, steps };
}
