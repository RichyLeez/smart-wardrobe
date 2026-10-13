// 身材数据：校验、比例计算、搭配目标建议，以及 2D 人台的几何与衣物摆放。
// 坐标系：单位为 cm，x 以身体中线为 0（向右为正），y 从头顶向下为正。

import { isSkirtLike } from './catalog';
import type { BodyGoal, BodyProfile, Category, Gender, Item, Placement } from './types';

export const DEFAULT_BODY: BodyProfile = {
  height: 170,
  shoulder: 41,
  chest: 90,
  waist: 74,
  hip: 94,
  inseam: 78,
  gender: 'unspecified',
};

export const BODY_FIELDS: Array<{ key: keyof Omit<BodyProfile, 'gender'>; label: string; min: number; max: number; hint: string }> = [
  { key: 'height', label: '身高', min: 120, max: 220, hint: '赤脚站直' },
  { key: 'shoulder', label: '肩宽', min: 28, max: 65, hint: '两侧肩峰之间的直线距离' },
  { key: 'chest', label: '胸围', min: 60, max: 150, hint: '胸部最丰满处水平一周' },
  { key: 'waist', label: '腰围', min: 45, max: 150, hint: '腰部最细处水平一周' },
  { key: 'hip', label: '臀围', min: 60, max: 160, hint: '臀部最丰满处水平一周' },
  { key: 'inseam', label: '内侧腿长', min: 50, max: 115, hint: '裆部到地面的距离' },
];

export function validateBody(b: BodyProfile): string[] {
  const errors: string[] = [];
  for (const f of BODY_FIELDS) {
    const v = b[f.key];
    if (!Number.isFinite(v) || v < f.min || v > f.max) {
      errors.push(`${f.label}应在 ${f.min}–${f.max} cm 之间`);
    }
  }
  if (errors.length === 0) {
    if (b.inseam > b.height * 0.56) errors.push('内侧腿长超过身高的 56%，请确认是否从裆部量到地面');
    if (b.inseam < b.height * 0.36) errors.push('内侧腿长不足身高的 36%，请确认测量方式');
    if (b.waist > b.chest * 1.4) errors.push('腰围明显大于胸围，请确认数据');
  }
  return errors;
}

export interface BodyRatios {
  /** 内侧腿长 / 身高 */
  legRatio: number;
  /** 胸围 / 臀围 */
  chestHip: number;
  /** 腰围 / 臀围 */
  waistHip: number;
  /** 肩宽 / 估算臀宽 */
  shoulderHip: number;
}

export function bodyRatios(b: BodyProfile): BodyRatios {
  return {
    legRatio: b.inseam / b.height,
    chestHip: b.chest / b.hip,
    waistHip: b.waist / b.hip,
    shoulderHip: b.shoulder / (b.hip * 0.35),
  };
}

/** 不同性别的参考基准（成年人大致平均值，仅作为判断偏离程度的起点） */
const BASELINES: Record<Gender, { chestHip: number; shoulderHip: number; waistHipDefined: number }> = {
  female: { chestHip: 0.93, shoulderHip: 1.12, waistHipDefined: 0.74 },
  male: { chestHip: 1.0, shoulderHip: 1.25, waistHipDefined: 0.82 },
  unspecified: { chestHip: 0.96, shoulderHip: 1.18, waistHipDefined: 0.76 },
};

export interface GoalSuggestion {
  goal: BodyGoal;
  reason: string;
}

/**
 * 根据身材比例给出建议的搭配目标。
 * 这些是常见的穿搭经验，不是精确的科学结论，用户可以自行开关。
 */
export function suggestGoals(b: BodyProfile): GoalSuggestion[] {
  const r = bodyRatios(b);
  const base = BASELINES[b.gender];
  const out: GoalSuggestion[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (r.legRatio < 0.45) {
    out.push({
      goal: 'lengthen_legs',
      reason: `内侧腿长约占身高的 ${pct(r.legRatio)}，略低于常见的 45%–47%`,
    });
  }
  // 上下身宽度：综合胸臀比和肩臀比
  const upperIndex = (r.chestHip / base.chestHip + r.shoulderHip / base.shoulderHip) / 2;
  if (upperIndex > 1.07) {
    out.push({ goal: 'balance_upper', reason: '肩部和胸部相对臀部偏宽' });
  } else if (upperIndex < 0.93) {
    out.push({ goal: 'balance_lower', reason: '臀部相对肩部和胸部偏宽' });
  }
  if (r.waistHip <= base.waistHipDefined) {
    out.push({ goal: 'define_waist', reason: `腰臀比约 ${r.waistHip.toFixed(2)}，腰线明显，适合强调` });
  }
  return out;
}

// ---------- 人台几何 ----------

export interface MannequinGeometry {
  height: number;
  headTop: number;
  chinY: number;
  headRx: number;
  headRy: number;
  neckHalf: number;
  shoulderY: number;
  shoulderHalf: number;
  chestY: number;
  chestHalf: number;
  waistY: number;
  waistHalf: number;
  hipY: number;
  hipHalf: number;
  crotchY: number;
  kneeY: number;
  ankleY: number;
  legCenter: number;
  thighHalf: number;
  kneeHalf: number;
  calfHalf: number;
  ankleHalf: number;
  wristY: number;
  armHalf: number;
}

export function mannequinGeometry(b: BodyProfile): MannequinGeometry {
  const H = b.height;
  const crotchY = H - b.inseam;
  const shoulderY = H * 0.18;
  const waistY = shoulderY + (crotchY - shoulderY) * 0.57;
  const hipY = crotchY - H * 0.04;
  // 膝盖约在裆部到地面的 47% 处
  const kneeY = crotchY + (H - crotchY) * 0.47;
  const hipHalf = b.hip * 0.175;
  const chestHalf = Math.min(b.chest * 0.165, b.shoulder / 2 - 0.5);
  return {
    height: H,
    headTop: 0,
    chinY: H * 0.13,
    headRx: H * 0.046,
    headRy: H * 0.065,
    neckHalf: H * 0.034,
    shoulderY,
    shoulderHalf: b.shoulder / 2,
    chestY: shoulderY + (waistY - shoulderY) * 0.48,
    chestHalf,
    waistY,
    waistHalf: b.waist * 0.158,
    hipY,
    hipHalf,
    crotchY,
    kneeY,
    ankleY: H * 0.955,
    legCenter: hipHalf * 0.5,
    thighHalf: hipHalf * 0.5,
    kneeHalf: H * 0.03,
    calfHalf: H * 0.032,
    ankleHalf: H * 0.017,
    wristY: crotchY + H * 0.01,
    armHalf: H * 0.026,
  };
}

type Pt = [number, number];

/** Catmull-Rom 样条转贝塞尔，得到平滑轮廓 */
function smoothPath(points: Pt[], closed: boolean): string {
  if (points.length < 2) return '';
  const p = points;
  const n = p.length;
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  const get = (i: number): Pt => {
    if (closed) return p[(i + n) % n];
    return p[Math.max(0, Math.min(n - 1, i))];
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return closed ? d + ' Z' : d;
}

function f(v: number): string {
  return v.toFixed(2);
}

export interface MannequinShapes {
  head: { cx: number; cy: number; rx: number; ry: number };
  body: string;
  armLeft: string;
  armRight: string;
  viewBox: { x: number; y: number; width: number; height: number };
}

/** 生成无五官的正面人台轮廓 */
export function mannequinShapes(g: MannequinGeometry): MannequinShapes {
  const H = g.height;
  const neckTop = g.chinY - H * 0.012;
  // 右半边从脖子往下，再沿腿内侧回到裆部
  const kneeC = g.legCenter * 0.82;
  const ankleC = g.legCenter * 0.76;
  const footY = H;
  const right: Pt[] = [
    [g.neckHalf, neckTop],
    [g.neckHalf * 1.08, g.shoulderY - H * 0.015],
    [g.shoulderHalf * 0.82, g.shoulderY - H * 0.002],
    [g.shoulderHalf * 0.97, g.shoulderY + H * 0.018],
    [g.chestHalf * 0.98, g.shoulderY + H * 0.06],
    [g.chestHalf, g.chestY],
    [g.waistHalf, g.waistY],
    [g.hipHalf, g.hipY],
    [g.legCenter + g.thighHalf * 0.98, g.crotchY + H * 0.03],
    [kneeC + g.kneeHalf, g.kneeY],
    [kneeC + g.calfHalf * 0.95, g.kneeY + (g.ankleY - g.kneeY) * 0.3],
    [ankleC + g.ankleHalf, g.ankleY],
    [ankleC + g.ankleHalf * 1.6, footY],
    [ankleC - g.ankleHalf * 1.1, footY],
    [ankleC - g.ankleHalf, g.ankleY],
    [kneeC - g.calfHalf * 0.8, g.kneeY + (g.ankleY - g.kneeY) * 0.3],
    [kneeC - g.kneeHalf * 0.9, g.kneeY],
    [Math.max(0.6, g.legCenter - g.thighHalf * 0.85), g.crotchY + H * 0.03],
    [0.4, g.crotchY],
  ];
  const left: Pt[] = right
    .slice()
    .reverse()
    .map(([x, y]) => [-x, y] as Pt);
  const outline = right.concat(left);
  const body = smoothPath(outline, true);

  const arm = (side: 1 | -1): string => {
    const sx = side * g.shoulderHalf * 0.93;
    const pts: Pt[] = [
      [sx, g.shoulderY + H * 0.005],
      [side * (g.shoulderHalf + g.armHalf * 0.9), g.shoulderY + H * 0.05],
      [side * (g.chestHalf + g.armHalf * 1.7), g.waistY],
      [side * (g.hipHalf + g.armHalf * 1.3), g.wristY],
      [side * (g.hipHalf + g.armHalf * 1.2), g.wristY + H * 0.055],
      [side * (g.hipHalf + g.armHalf * 0.2), g.wristY + H * 0.05],
      [side * (g.hipHalf + g.armHalf * 0.2), g.wristY],
      [side * (g.chestHalf + g.armHalf * 0.15), g.waistY],
      [side * (g.chestHalf * 0.98), g.shoulderY + H * 0.07],
    ];
    return smoothPath(pts, true);
  };

  const margin = H * 0.04;
  const halfWidth = Math.max(g.hipHalf + g.armHalf * 3, g.shoulderHalf * 1.6) + H * 0.12;
  return {
    head: { cx: 0, cy: g.chinY - g.headRy, rx: g.headRx, ry: g.headRy },
    body,
    armLeft: arm(-1),
    armRight: arm(1),
    viewBox: { x: -halfWidth, y: -margin, width: halfWidth * 2, height: H + margin * 2 },
  };
}

// ---------- 衣物摆放 ----------

export interface GarmentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type PlaceableItem = Pick<Item, 'category' | 'subtype' | 'length' | 'rise' | 'imageAspect'>;

/** 按目标高度放置，宽度由图片宽高比决定，再限制在合理范围内 */
function fitRect(
  aspect: number,
  centerX: number,
  top: number,
  targetH: number,
  minW: number,
  maxW: number,
): GarmentRect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let h = targetH;
  let w = h * a;
  if (w > maxW) {
    w = maxW;
    h = w / a;
  } else if (w < minW) {
    w = minW;
    h = w / a;
  }
  return { x: centerX - w / 2, y: top, width: w, height: h };
}

function centeredRect(aspect: number, cx: number, cy: number, targetH: number, minW: number, maxW: number): GarmentRect {
  const r = fitRect(aspect, cx, 0, targetH, minW, maxW);
  return { ...r, y: cy - r.height / 2 };
}

/** 按类别把衣物贴图放到人台对应位置 */
export function placeGarment(item: PlaceableItem, g: MannequinGeometry): GarmentRect {
  const H = g.height;
  const shoulderW = g.shoulderHalf * 2;
  const hipW = g.hipHalf * 2;
  const a = item.imageAspect;
  switch (item.category as Category) {
    case 'top': {
      const top = g.shoulderY - H * 0.022;
      const hem =
        item.length === 'short' ? g.waistY + H * 0.01 : item.length === 'long' ? g.crotchY + H * 0.06 : g.crotchY - H * 0.015;
      return fitRect(a, 0, top, hem - top, shoulderW * 1.0, shoulderW * 2.5);
    }
    case 'outer': {
      const top = g.shoulderY - H * 0.028;
      const hem =
        item.length === 'short' ? g.waistY + H * 0.05 : item.length === 'long' ? g.kneeY + H * 0.03 : g.crotchY + H * 0.035;
      return fitRect(a, 0, top, hem - top, shoulderW * 1.08, shoulderW * 2.7);
    }
    case 'dress': {
      const top = g.shoulderY - H * 0.015;
      const hem =
        item.length === 'short' ? g.crotchY + H * 0.11 : item.length === 'long' ? g.ankleY - H * 0.035 : g.kneeY + H * 0.02;
      return fitRect(a, 0, top, hem - top, shoulderW * 0.95, shoulderW * 2.6);
    }
    case 'bottom': {
      const top =
        item.rise === 'high' ? g.waistY - H * 0.012 : item.rise === 'low' ? g.waistY + H * 0.055 : g.waistY + H * 0.028;
      const skirt = isSkirtLike(item.subtype);
      let hem: number;
      if (item.length === 'short') hem = g.crotchY + H * (skirt ? 0.12 : 0.09);
      else if (item.length === 'regular') hem = skirt ? g.kneeY + H * 0.06 : g.ankleY - H * 0.045;
      else hem = skirt ? g.ankleY - H * 0.02 : H - H * 0.008;
      return fitRect(a, 0, top, hem - top, hipW * 0.85, hipW * 2.4);
    }
    case 'shoes': {
      const targetH = H * 0.07;
      const r = fitRect(a, 0, 0, targetH, H * 0.07, H * 0.25);
      return { ...r, y: H + H * 0.006 - r.height };
    }
    case 'bag': {
      const cx = g.hipHalf + g.armHalf * 2.4 + H * 0.05;
      return centeredRect(a, cx, g.wristY - H * 0.01, H * 0.15, H * 0.06, H * 0.2);
    }
    case 'hat': {
      const w = g.headRx * 2 * 1.75;
      const r = fitRect(a, 0, 0, w / (a || 1), w * 0.8, w * 1.2);
      const bottom = g.headTop + g.headRy * 0.95;
      return { ...r, y: bottom - r.height };
    }
    case 'scarf':
      return fitRect(a, 0, g.chinY - H * 0.012, H * 0.2, shoulderW * 0.5, shoulderW * 0.9);
    case 'belt': {
      const w = g.waistHalf * 2 * 1.18;
      const y = item.rise === 'low' ? g.waistY + H * 0.04 : g.waistY;
      return centeredRect(a, 0, y, w / (a || 1), w * 0.95, w * 1.05);
    }
    case 'jewelry': {
      const st = item.subtype;
      if (st === '手表' || st === '手链') {
        const cx = -(g.hipHalf + g.armHalf * 0.75);
        return centeredRect(a, cx, g.wristY, H * 0.035, H * 0.02, H * 0.05);
      }
      if (st === '耳饰') return centeredRect(a, g.headRx * 0.95, g.chinY - g.headRy * 0.6, H * 0.03, H * 0.012, H * 0.03);
      if (st === '眼镜') return centeredRect(a, 0, g.chinY - g.headRy * 1.05, H * 0.025, g.headRx * 2, g.headRx * 2.3);
      return fitRect(a, 0, g.shoulderY - H * 0.01, H * 0.07, H * 0.03, shoulderW * 0.5);
    }
    default:
      return fitRect(a, 0, g.shoulderY, H * 0.2, H * 0.05, H * 0.4);
  }
}

export function applyPlacement(rect: GarmentRect, p?: Placement): GarmentRect {
  if (!p) return rect;
  const cx = rect.x + rect.width / 2 + p.dx;
  const cy = rect.y + rect.height / 2 + p.dy;
  const w = rect.width * p.scale;
  const h = rect.height * p.scale;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

// ---------- 正面 / 背面 ----------

export type ViewSide = 'front' | 'back';

type SideItem = PlaceableItem & Pick<Item, 'images' | 'backAspect'>;

/** 从身后看不到的配饰 */
export function hiddenFromBack(item: Pick<Item, 'category' | 'subtype'>): boolean {
  return item.category === 'jewelry' && (item.subtype === '眼镜' || item.subtype === '项链');
}

export interface GarmentView {
  rect: GarmentRect;
  /** 使用的贴图 */
  image: string;
  /** 没有背面照片时，从身后看到的是正面照片的镜像 */
  mirrored: boolean;
  hasBack: boolean;
}

/**
 * 某一面看到的衣物：位置和贴图。
 * 背面视图的坐标同样以观察者的右手方向为 x 正方向，所以正面在右侧的东西（例如包）背面在左侧。
 * 手动微调（placement）以正面为准，背面跟着镜像。
 */
export function garmentView(item: SideItem, g: MannequinGeometry, side: ViewSide, placement?: Placement): GarmentView {
  const hasBack = !!item.images.backCutout;
  if (side === 'front') {
    return { rect: applyPlacement(placeGarment(item, g), placement), image: item.images.cutout, mirrored: false, hasBack };
  }
  const aspect = hasBack ? item.backAspect ?? item.imageAspect : item.imageAspect;
  const r = applyPlacement(placeGarment({ ...item, imageAspect: aspect }, g), placement);
  return {
    rect: { ...r, x: -(r.x + r.width) },
    image: hasBack ? item.images.backCutout! : item.images.cutout,
    mirrored: !hasBack,
    hasBack,
  };
}
