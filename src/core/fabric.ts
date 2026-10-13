// 面料：从成分、子类和名称推断单品的面料，以及面料的质感、厚重、正式程度、透气和保暖。
// 有吊牌成分时以成分为准，没有时按子类的常见面料估计（例如西裤多为西装料、T恤多为棉质针织）。
// 这些属性是穿搭经验上的大致刻度（0~1），用于"面料搭配"打分和说明。

import { mainFiber } from './tag';
import type { Item } from './types';

export type FabricKind =
  | 'cotton'
  | 'jersey'
  | 'linen'
  | 'silk'
  | 'satin'
  | 'chiffon'
  | 'viscose'
  | 'wool'
  | 'cashmere'
  | 'suiting'
  | 'knit'
  | 'fleece'
  | 'denim'
  | 'corduroy'
  | 'polyester'
  | 'nylon'
  | 'down'
  | 'leather'
  | 'suede'
  | 'canvas'
  | 'mesh';

export type Texture = 'smooth' | 'matte' | 'textured' | 'sheen';

export interface FabricTraits {
  label: string;
  texture: Texture;
  /** 视觉上的厚重感 */
  heavy: number;
  /** 正式程度 */
  formality: number;
  /** 透气 */
  breath: number;
  /** 保暖 */
  warm: number;
}

export const FABRICS: Record<FabricKind, FabricTraits> = {
  cotton: { label: '棉', texture: 'matte', heavy: 0.4, formality: 0.5, breath: 0.8, warm: 0.4 },
  jersey: { label: '棉质针织', texture: 'matte', heavy: 0.3, formality: 0.3, breath: 0.8, warm: 0.3 },
  linen: { label: '麻', texture: 'textured', heavy: 0.3, formality: 0.45, breath: 1, warm: 0.1 },
  silk: { label: '真丝', texture: 'sheen', heavy: 0.1, formality: 0.85, breath: 0.85, warm: 0.2 },
  satin: { label: '缎面', texture: 'sheen', heavy: 0.2, formality: 0.8, breath: 0.5, warm: 0.2 },
  chiffon: { label: '雪纺', texture: 'smooth', heavy: 0.05, formality: 0.65, breath: 0.9, warm: 0.05 },
  viscose: { label: '粘纤', texture: 'smooth', heavy: 0.25, formality: 0.6, breath: 0.85, warm: 0.25 },
  wool: { label: '羊毛', texture: 'matte', heavy: 0.7, formality: 0.8, breath: 0.5, warm: 0.9 },
  cashmere: { label: '羊绒', texture: 'matte', heavy: 0.6, formality: 0.85, breath: 0.5, warm: 1 },
  suiting: { label: '西装面料', texture: 'smooth', heavy: 0.55, formality: 0.95, breath: 0.5, warm: 0.6 },
  knit: { label: '针织', texture: 'textured', heavy: 0.65, formality: 0.5, breath: 0.55, warm: 0.8 },
  fleece: { label: '卫衣绒面', texture: 'matte', heavy: 0.7, formality: 0.2, breath: 0.4, warm: 0.75 },
  denim: { label: '牛仔', texture: 'textured', heavy: 0.75, formality: 0.3, breath: 0.45, warm: 0.5 },
  corduroy: { label: '灯芯绒', texture: 'textured', heavy: 0.7, formality: 0.35, breath: 0.5, warm: 0.7 },
  polyester: { label: '涤纶', texture: 'smooth', heavy: 0.4, formality: 0.5, breath: 0.25, warm: 0.4 },
  nylon: { label: '锦纶', texture: 'smooth', heavy: 0.35, formality: 0.3, breath: 0.3, warm: 0.4 },
  down: { label: '羽绒', texture: 'smooth', heavy: 1, formality: 0.25, breath: 0.2, warm: 1 },
  leather: { label: '皮革', texture: 'sheen', heavy: 0.8, formality: 0.75, breath: 0.1, warm: 0.6 },
  suede: { label: '麂皮', texture: 'textured', heavy: 0.7, formality: 0.6, breath: 0.2, warm: 0.6 },
  canvas: { label: '帆布', texture: 'textured', heavy: 0.6, formality: 0.2, breath: 0.6, warm: 0.4 },
  mesh: { label: '网面', texture: 'textured', heavy: 0.3, formality: 0.15, breath: 0.9, warm: 0.3 },
};

export interface FabricProfile extends FabricTraits {
  kind: FabricKind;
  /** material：来自成分或名称里的面料字样；subtype：按子类的常见面料估计 */
  source: 'material' | 'subtype';
}

/** 名称、子类、成分里直接写明的面料字样，优先级最高 */
const KEYWORDS: Array<[RegExp, FabricKind]> = [
  [/牛仔|丹宁|DENIM/i, 'denim'],
  [/灯芯绒|条绒|CORDUROY/i, 'corduroy'],
  [/麂皮|绒面革|SUEDE/i, 'suede'],
  [/雪纺|CHIFFON/i, 'chiffon'],
  [/缎|SATIN/i, 'satin'],
  [/羽绒|鸭绒|鹅绒/, 'down'],
  [/帆布|CANVAS/i, 'canvas'],
  [/网面|网布|MESH/i, 'mesh'],
  [/卫衣|抓绒|摇粒绒|FLEECE/i, 'fleece'],
];

/** 主要纤维 → 面料 */
const FIBER_KIND: Record<string, FabricKind> = {
  棉: 'cotton',
  麻: 'linen',
  真丝: 'silk',
  羊毛: 'wool',
  羊驼毛: 'wool',
  马海毛: 'wool',
  兔毛: 'wool',
  羊绒: 'cashmere',
  牦牛绒: 'cashmere',
  聚酯纤维: 'polyester',
  腈纶: 'polyester',
  醋酯纤维: 'satin',
  锦纶: 'nylon',
  粘纤: 'viscose',
  莫代尔: 'viscose',
  莱赛尔: 'viscose',
  皮革: 'leather',
  聚氨酯: 'leather',
  麂皮: 'suede',
  羽绒: 'down',
  鸭绒: 'down',
  鹅绒: 'down',
};

const KNIT_SUBTYPES = new Set(['针织衫', '毛衣', '开衫', '针织裙', '针织帽']);
const JERSEY_SUBTYPES = new Set(['T恤', '打底衫', '背心', 'Polo衫', '运动上衣', '运动裤']);
const SUIT_SUBTYPES = new Set(['西装外套', '西裤']);
const LEATHER_SUBTYPES = new Set(['皮衣', '皮鞋', '靴子', '乐福鞋', '高跟鞋', '凉鞋', '皮带', '托特包', '手提包', '斜挎包']);

/** 没有成分信息时，各子类最常见的面料 */
const SUBTYPE_DEFAULT: Record<string, FabricKind> = {
  衬衫: 'cotton',
  衬衫裙: 'cotton',
  吊带: 'satin',
  吊带裙: 'satin',
  连衣裙: 'viscose',
  半身裙: 'polyester',
  百褶裙: 'polyester',
  休闲裤: 'cotton',
  阔腿裤: 'cotton',
  工装裤: 'cotton',
  短裤: 'cotton',
  风衣: 'cotton',
  夹克: 'cotton',
  大衣: 'wool',
  羽绒服: 'down',
  棉服: 'polyester',
  冲锋衣: 'nylon',
  马甲: 'wool',
  运动鞋: 'mesh',
  双肩包: 'nylon',
  腰包: 'nylon',
  围巾: 'wool',
  丝巾: 'silk',
  棒球帽: 'cotton',
  渔夫帽: 'cotton',
  礼帽: 'wool',
  编织腰带: 'canvas',
};

function profile(kind: FabricKind, source: FabricProfile['source']): FabricProfile {
  return { kind, source, ...FABRICS[kind] };
}

/** 单品的面料；首饰返回 null（不参与面料搭配） */
export function fabricOf(item: Pick<Item, 'category' | 'subtype' | 'name' | 'material'>): FabricProfile | null {
  if (item.category === 'jewelry') return null;
  const text = `${item.name} ${item.subtype} ${item.material ?? ''}`;
  for (const [re, kind] of KEYWORDS) if (re.test(text)) return profile(kind, 'material');
  const fiber = mainFiber(item.material);
  const fromFiber = fiber ? FIBER_KIND[fiber] : undefined;
  // 针织类：按纤维决定厚薄，羊毛、羊绒针织更保暖
  if (KNIT_SUBTYPES.has(item.subtype)) {
    const p = profile('knit', fromFiber ? 'material' : 'subtype');
    if (fromFiber === 'cashmere' || fromFiber === 'wool') return { ...p, label: `${FABRICS[fromFiber].label}针织`, warm: 0.95, formality: 0.6 };
    if (fromFiber === 'cotton' || fromFiber === 'viscose') return { ...p, label: '棉质针织', heavy: 0.45, warm: 0.55 };
    return p;
  }
  if (SUIT_SUBTYPES.has(item.subtype) && (!fromFiber || fromFiber === 'wool' || fromFiber === 'polyester' || fromFiber === 'viscose')) {
    return profile('suiting', fromFiber ? 'material' : 'subtype');
  }
  if (JERSEY_SUBTYPES.has(item.subtype) && (!fromFiber || fromFiber === 'cotton')) return profile('jersey', fromFiber ? 'material' : 'subtype');
  if (fromFiber) {
    const p = profile(fromFiber, 'material');
    // 衬衫用的棉布更挺括、更正式
    if (fromFiber === 'cotton' && (item.subtype === '衬衫' || item.subtype === '衬衫裙')) return { ...p, label: '棉质衬衫布', texture: 'smooth', formality: 0.7 };
    return p;
  }
  if (LEATHER_SUBTYPES.has(item.subtype)) return profile('leather', 'subtype');
  const def = SUBTYPE_DEFAULT[item.subtype];
  if (def) {
    const p = profile(def, 'subtype');
    if (def === 'cotton' && (item.subtype === '衬衫' || item.subtype === '衬衫裙')) return { ...p, label: '棉质衬衫布', texture: 'smooth', formality: 0.7 };
    if (item.subtype === '棉服') return { ...p, label: '棉服面料', heavy: 0.9, warm: 0.9 };
    return p;
  }
  return profile('cotton', 'subtype');
}
