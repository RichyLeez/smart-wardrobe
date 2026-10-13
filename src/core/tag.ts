// 吊牌 / 洗标文字解析：从拍照识别或粘贴的文字里提取品牌、货号、号型、尺码、成分、执行标准和版型字样。
// 纯函数，不依赖浏览器。识别结果只作为建议，由用户在界面上确认后才写入单品。

import type { Category, Fit, Length, Rise, Warmth } from './types';

export type FiberPart = 'shell' | 'lining' | 'filling' | 'trim';

export interface Fiber {
  /** 规范后的中文名，例如 棉、聚酯纤维、氨纶 */
  name: string;
  pct: number;
  part: FiberPart;
}

export interface StandardInfo {
  /** 规范写法，例如 GB/T 22849-2014 */
  code: string;
  /** 标准对应的产品，例如 针织T恤衫 */
  label?: string;
  category?: Category;
  subtype?: string;
}

export interface TagParse {
  brand?: string;
  styleNo?: string;
  productName?: string;
  /** 吊牌上的尺码原文，例如 M、29、175/92A */
  size?: string;
  /** 号型，例如 175/92A */
  sizeCode?: string;
  standards: StandardInfo[];
  fibers: Fiber[];
  /** 成分的规范写法，例如 "棉 95%，氨纶 5%" */
  materialText?: string;
  stretch: boolean;
  fit?: Fit;
  fitWord?: string;
  length?: Length;
  lengthWord?: string;
  rise?: Rise;
  riseWord?: string;
  category?: Category;
  subtype?: string;
  /** 类别建议的来源：品名、执行标准或全文关键词 */
  subtypeSource?: 'name' | 'standard' | 'keyword';
  warmthHint?: Warmth;
  warmthReason?: string;
  /** 含绒量（%） */
  downContent?: number;
}

// ---------- 文字规范化 ----------

const CJK = '\\u3400-\\u9fff';

/** 全角转半角、去掉识别时插进汉字之间的空格、修正数字里常见的误识别 */
export function normalizeTagText(raw: string): string {
  let s = raw.normalize('NFKC').replace(/\r/g, '');
  s = s.replace(/[　\t]/g, ' ');
  s = s.replace(/[，、；]/g, (c) => (c === '，' ? ',' : c === '；' ? ';' : ','));
  // 文字识别常把每个汉字分开：棉 质 → 棉质
  s = s.replace(new RegExp(`([${CJK}])[ ]+(?=[${CJK}])`, 'g'), '$1');
  // 冒号两侧空格
  s = s.replace(/[ ]*:[ ]*/g, ':');
  // 百分号前的空格
  s = s.replace(/(\d)[ ]+%/g, '$1%');
  // 数字中的 O/o → 0、l/I/| → 1（只在紧挨数字或百分号时）
  const zero = (_: string, d: string) => `${d}0`;
  s = s.replace(/(\d)[Oo](?=[\dOo]*%)/g, zero).replace(/(\d)[Oo](?=[\dOo]*%)/g, zero);
  s = s.replace(/(^|[^A-Za-z])[lI|](\d{1,2}%)/g, (_: string, pre: string, num: string) => `${pre}1${num}`);
  return s;
}

// ---------- 成分 ----------

const FIBERS: Array<[string, string[]]> = [
  // 顺序：长名在前，避免"人造棉"被认成"棉"
  ['粘纤', ['粘胶纤维', '黏胶纤维', '粘纤', '黏纤', '粘胶', '黏胶', '人造棉', '人棉', 'VISCOSE', 'RAYON']],
  ['莫代尔', ['莫代尔纤维', '莫代尔', 'MODAL']],
  ['莱赛尔', ['莱赛尔纤维', '莱赛尔', '天丝', 'LYOCELL', 'TENCEL']],
  ['醋酯纤维', ['醋酯纤维', '醋酸纤维', 'ACETATE']],
  ['聚酯纤维', ['聚酯纤维', '涤纶', 'POLYESTER']],
  ['锦纶', ['聚酰胺纤维', '锦纶', '尼龙', 'POLYAMIDE', 'NYLON']],
  ['氨纶', ['氨纶', '弹性纤维', '莱卡', 'ELASTANE', 'SPANDEX', 'LYCRA']],
  ['腈纶', ['腈纶', 'ACRYLIC']],
  ['聚氨酯', ['聚氨酯', 'POLYURETHANE']],
  ['羊绒', ['山羊绒', '羊绒', 'CASHMERE']],
  ['羊驼毛', ['羊驼毛', 'ALPACA']],
  ['马海毛', ['马海毛', 'MOHAIR']],
  ['牦牛绒', ['牦牛绒', 'YAK']],
  ['兔毛', ['兔毛', 'ANGORA']],
  ['羊毛', ['美利奴羊毛', '绵羊毛', '羊毛', 'MERINO WOOL', 'WOOL']],
  ['真丝', ['桑蚕丝', '真丝', '蚕丝', 'SILK']],
  ['麻', ['亚麻', '苎麻', '大麻', 'LINEN', 'FLAX', 'RAMIE']],
  ['棉', ['精梳棉', '长绒棉', '有机棉', '新疆棉', '全棉', '纯棉', '棉', 'COTTON']],
  ['鹅绒', ['白鹅绒', '灰鹅绒', '鹅绒', 'GOOSE DOWN']],
  ['鸭绒', ['白鸭绒', '灰鸭绒', '鸭绒', 'DUCK DOWN']],
  ['鹅毛', ['鹅毛', 'GOOSE FEATHER']],
  ['鸭毛', ['鸭毛', 'DUCK FEATHER']],
  ['羽绒', ['羽绒', 'DOWN']],
  ['麂皮', ['麂皮', '绒面革', 'SUEDE']],
  ['皮革', ['牛皮革', '羊皮革', '牛皮', '羊皮', '猪皮', '真皮', '皮革', 'LEATHER']],
  ['其他纤维', ['其他纤维', '其它纤维', 'OTHER FIBRES', 'OTHER FIBERS', 'OTHERS']],
];

const ALIAS_TO_FIBER: Array<[string, string]> = FIBERS.flatMap(([name, aliases]) => aliases.map((a) => [a, name] as [string, string])).sort(
  (a, b) => b[0].length - a[0].length,
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FIBER_RE = new RegExp(
  ALIAS_TO_FIBER.map(([a]) => (/^[A-Z ]+$/.test(a) ? `\\b${escapeRe(a).replace(/ /g, '\\s+')}\\b` : escapeRe(a))).join('|'),
  'gi',
);
const PCT_RE = /(\d{1,3}(?:\.\d+)?)%/g;

function fiberName(alias: string): string | undefined {
  const up = alias.toUpperCase().replace(/\s+/g, ' ');
  return ALIAS_TO_FIBER.find(([a]) => a === up || a === alias)?.[1];
}

const PART_MARKERS: Array<[RegExp, FiberPart]> = [
  [/里料|里布|内衬|LINING/i, 'lining'],
  [/填充物|填充|絮料|FILLING|PADDING|WADDING/i, 'filling'],
  [/罗纹|螺纹|配料|拼接|RIB|TRIM/i, 'trim'],
  [/面料|面布|外层|表层|大身|主料|SHELL|OUTER|FABRIC/i, 'shell'],
];
const PART_SPLIT = /(?=里料|里布|内衬|填充物|填充|絮料|罗纹|螺纹|配料|面料|面布|外层|表层|大身|主料|LINING|FILLING|PADDING|SHELL)/i;

interface Token {
  kind: 'name' | 'pct';
  index: number;
  value: string | number;
}

/** 明确在写成分的文字，例如"面料：纯棉"；只有这种情况下才把没有百分比的纤维名当作 100% */
const MATERIAL_LABEL = /成分|面料|材质|材料|含量|里料|里布|填充|COMPOSITION|FABRIC|MATERIAL|SHELL|LINING/i;

/** 一段文字里按"名称在前"或"百分比在前"的顺序把纤维名和百分比配对 */
function pairSegment(seg: string, part: FiberPart, out: Fiber[]): void {
  const tokens: Token[] = [];
  for (const m of seg.matchAll(FIBER_RE)) {
    const name = fiberName(m[0]);
    if (name) tokens.push({ kind: 'name', index: m.index ?? 0, value: name });
  }
  for (const m of seg.matchAll(PCT_RE)) {
    const v = Number(m[1]);
    if (v > 0 && v <= 100) tokens.push({ kind: 'pct', index: m.index ?? 0, value: v });
  }
  if (!tokens.some((t) => t.kind === 'name')) return;
  tokens.sort((a, b) => a.index - b.index);
  const pcts = tokens.filter((t) => t.kind === 'pct');
  if (pcts.length === 0) {
    // 只有名称没有百分比，例如"面料：纯棉"；"品名：棉服"这类不算
    const names = [...new Set(tokens.map((t) => t.value as string))];
    if (names.length === 1 && MATERIAL_LABEL.test(seg)) out.push({ name: names[0], pct: 100, part });
    return;
  }
  const nameFirst = tokens[0].kind === 'name';
  let run: string[] = [];
  const flush = (pct: number) => {
    if (run.length === 0) return;
    out.push({ name: run[run.length - 1], pct, part });
    run = [];
  };
  if (nameFirst) {
    for (const t of tokens) {
      if (t.kind === 'name') run.push(t.value as string);
      else flush(t.value as number);
    }
  } else {
    let pending: number | null = null;
    for (const t of tokens) {
      if (t.kind === 'pct') {
        if (pending !== null) flush(pending);
        pending = t.value as number;
      } else if (pending !== null) {
        run.push(t.value as string);
      }
    }
    if (pending !== null) flush(pending);
  }
}

export function parseFibers(text: string): Fiber[] {
  const out: Fiber[] = [];
  let part: FiberPart = 'shell';
  for (const line of text.split('\n')) {
    for (const seg of line.split(PART_SPLIT)) {
      const marker = PART_MARKERS.find(([re]) => re.test(seg.slice(0, 6)));
      if (marker) part = marker[1];
      pairSegment(seg, part, out);
    }
  }
  // 同一部位同一纤维只保留一次（中英文双语吊牌会重复）
  const seen = new Map<string, Fiber>();
  for (const f of out) {
    const key = `${f.part}|${f.name}`;
    const prev = seen.get(key);
    if (!prev || f.pct > prev.pct) seen.set(key, f);
  }
  const PART_ORDER: FiberPart[] = ['shell', 'lining', 'filling', 'trim'];
  return [...seen.values()].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part) || b.pct - a.pct);
}

const PART_LABELS: Record<FiberPart, string> = { shell: '面料', lining: '里料', filling: '填充', trim: '罗纹' };

export function formatFibers(fibers: Fiber[]): string | undefined {
  if (fibers.length === 0) return undefined;
  const parts = (['shell', 'lining', 'filling', 'trim'] as FiberPart[])
    .map((p) => {
      const fs = fibers.filter((f) => f.part === p);
      if (fs.length === 0) return '';
      const body = fs.map((f) => `${f.name} ${f.pct}%`).join('，');
      return p === 'shell' ? body : `${PART_LABELS[p]} ${body}`;
    })
    .filter(Boolean);
  return parts.join('；');
}

/** 主要面料：吊牌成分里占比最高的面料纤维；手填的材质文字则取第一个认出的纤维名 */
export function mainFiber(material: string | undefined): string | undefined {
  if (!material) return undefined;
  const text = normalizeTagText(material);
  const fibers = parseFibers(text).filter((f) => f.part === 'shell');
  if (fibers.length) return fibers.sort((a, b) => b.pct - a.pct)[0].name;
  const m = text.match(FIBER_RE);
  return m ? fiberName(m[0]) : undefined;
}

// ---------- 品牌 ----------

/** 常见品牌：规范名 + 吊牌上可能出现的写法 */
const BRANDS: Array<[string, string[]]> = [
  ['优衣库', ['优衣库', 'UNIQLO']],
  ['GU', ['GU']],
  ['无印良品', ['无印良品', 'MUJI']],
  ['ZARA', ['ZARA']],
  ['H&M', ['H&M', 'H & M']],
  ['COS', ['COS']],
  ['Massimo Dutti', ['MASSIMO DUTTI']],
  ['Uniqlo U', ['UNIQLO U']],
  ['耐克', ['耐克', 'NIKE']],
  ['阿迪达斯', ['阿迪达斯', 'ADIDAS']],
  ['李宁', ['李宁', 'LI-NING']],
  ['安踏', ['安踏', 'ANTA']],
  ['特步', ['特步', 'XTEP']],
  ['斐乐', ['斐乐', 'FILA']],
  ['彪马', ['彪马', 'PUMA']],
  ['新百伦', ['新百伦', 'NEW BALANCE']],
  ['匡威', ['匡威', 'CONVERSE']],
  ['万斯', ['万斯', 'VANS']],
  ['斯凯奇', ['斯凯奇', 'SKECHERS']],
  ['安德玛', ['安德玛', 'UNDER ARMOUR']],
  ['迪桑特', ['迪桑特', 'DESCENTE']],
  ['露露乐蒙', ['露露乐蒙', 'LULULEMON']],
  ['北面', ['THE NORTH FACE', '北面']],
  ['哥伦比亚', ['哥伦比亚', 'COLUMBIA']],
  ['始祖鸟', ['始祖鸟', "ARC'TERYX", 'ARCTERYX']],
  ['波司登', ['波司登', 'BOSIDENG']],
  ['雪中飞', ['雪中飞']],
  ['鸭鸭', ['鸭鸭']],
  ['加拿大鹅', ['加拿大鹅', 'CANADA GOOSE']],
  ['太平鸟', ['太平鸟', 'PEACEBIRD']],
  ['海澜之家', ['海澜之家', 'HLA']],
  ['森马', ['森马', 'SEMIR']],
  ['以纯', ['以纯', 'YISHION']],
  ['美特斯邦威', ['美特斯邦威', 'METERSBONWE']],
  ['江南布衣', ['江南布衣', 'JNBY']],
  ['雅戈尔', ['雅戈尔', 'YOUNGOR']],
  ['利郎', ['利郎', 'LILANZ']],
  ['七匹狼', ['七匹狼', 'SEPTWOLVES']],
  ['九牧王', ['九牧王', 'JOEONE']],
  ['报喜鸟', ['报喜鸟', 'SAINT ANGELO']],
  ['杰克琼斯', ['杰克琼斯', 'JACK & JONES', 'JACK&JONES']],
  ['思莱德', ['思莱德', 'SELECTED']],
  ['ONLY', ['ONLY']],
  ['VERO MODA', ['VERO MODA']],
  ['UR', ['URBAN REVIVO']],
  ['MO&Co.', ['MO&CO']],
  ['欧时力', ['欧时力', 'OCHIRLY']],
  ['歌莉娅', ['歌莉娅', 'GOELIA']],
  ['之禾', ['之禾', 'ICICLE']],
  ['李维斯', ['李维斯', "LEVI'S", 'LEVIS']],
  ['Lee', ['LEE']],
  ['GAP', ['GAP']],
  ['拉夫劳伦', ['拉夫劳伦', 'RALPH LAUREN', 'POLO RALPH LAUREN']],
  ['汤米希尔费格', ['TOMMY HILFIGER']],
  ['Calvin Klein', ['CALVIN KLEIN']],
  ['法国鳄鱼', ['LACOSTE']],
  ['冠军', ['CHAMPION']],
  ['蕉内', ['蕉内', 'BANANAIN']],
  ['白小T', ['白小T']],
];

const BRAND_ALIASES: Array<[string, string]> = BRANDS.flatMap(([name, aliases]) => aliases.map((a) => [a, name] as [string, string])).sort(
  (a, b) => b[0].length - a[0].length,
);

/** 把品牌写法统一，例如 UNIQLO → 优衣库；不认识的品牌原样保留 */
export function canonicalBrand(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const up = v.toUpperCase();
  const hit = BRAND_ALIASES.find(([a]) => a === up || a === v);
  return hit ? hit[1] : v;
}

/** 这些写法太常见（例如洗标上的 DRY CLEAN ONLY），只在"品牌："这一行里才认 */
const EXPLICIT_ONLY = new Set(['ONLY', 'GU', 'COS', 'LEE', 'GAP', 'HLA', 'SELECTED', 'CHAMPION', 'COLUMBIA', 'VANS']);

function findBrand(text: string): string | undefined {
  const up = text.toUpperCase();
  for (const [alias, name] of BRAND_ALIASES) {
    if (EXPLICIT_ONLY.has(alias)) continue;
    if (/^[A-Z0-9&' .-]+$/.test(alias)) {
      // 拉丁字母品牌要求独立成词，避免在别的单词里误命中
      const re = new RegExp(`(^|[^A-Z])${escapeRe(alias).replace(/ /g, '\\s*')}($|[^A-Z])`);
      if (alias.length >= 3 && re.test(up)) return name;
    } else if (text.includes(alias)) {
      return name;
    }
  }
  return undefined;
}

// ---------- 执行标准 ----------

const STANDARD_TABLE: Array<[string, Omit<StandardInfo, 'code'>]> = [
  ['GB/T 2660', { label: '衬衫', category: 'top', subtype: '衬衫' }],
  ['GB/T 2662', { label: '棉服装', category: 'outer' }],
  ['GB/T 2664', { label: '男西服、大衣', category: 'outer' }],
  ['GB/T 2665', { label: '女西服、大衣', category: 'outer' }],
  ['GB/T 2666', { label: '西裤', category: 'bottom', subtype: '西裤' }],
  ['GB/T 14272', { label: '羽绒服装', category: 'outer', subtype: '羽绒服' }],
  ['GB/T 22849', { label: '针织T恤衫', category: 'top', subtype: 'T恤' }],
  ['GB/T 22853', { label: '针织运动服' }],
  ['GB/T 32614', { label: '户外运动服装 冲锋衣', category: 'outer', subtype: '冲锋衣' }],
  ['GB/T 8878', { label: '棉针织内衣', category: 'top' }],
  ['GB/T 15107', { label: '旅游鞋', category: 'shoes', subtype: '运动鞋' }],
  ['FZ/T 81004', { label: '连衣裙、裙套', category: 'dress', subtype: '连衣裙' }],
  ['FZ/T 81006', { label: '牛仔服装' }],
  ['FZ/T 81007', { label: '单、夹服装' }],
  ['FZ/T 81010', { label: '风衣', category: 'outer', subtype: '风衣' }],
  ['FZ/T 73018', { label: '毛针织品' }],
  ['FZ/T 73020', { label: '针织休闲服装' }],
  ['QB/T 1002', { label: '皮鞋', category: 'shoes', subtype: '皮鞋' }],
  ['QB/T 2955', { label: '休闲鞋', category: 'shoes' }],
  ['QB/T 1333', { label: '背提包', category: 'bag' }],
];
/** 这些是安全规范或检测方法，不说明产品类型 */
const GENERIC_STANDARDS = ['GB 18401', 'GB 31701', 'GB/T 2912', 'GB/T 29862'];

function parseStandards(text: string): StandardInfo[] {
  const out: StandardInfo[] = [];
  const re = /\b(GB|FZ|QB)\s*\/?\s*(T)?\s*(\d{3,5}(?:\.\d+)?)(?:\s*[-—–]\s*(\d{4}))?/gi;
  for (const m of text.matchAll(re)) {
    const head = `${m[1].toUpperCase()}${m[2] ? '/T' : ''} ${m[3]}`;
    const code = m[4] ? `${head}-${m[4]}` : head;
    if (out.some((s) => s.code === code)) continue;
    if (GENERIC_STANDARDS.some((g) => head.startsWith(g))) {
      out.push({ code, label: head.startsWith('GB 18401') ? '纺织品基本安全技术规范' : undefined });
      continue;
    }
    const hit = STANDARD_TABLE.find(([k]) => head === k || head.startsWith(`${k}.`));
    out.push({ code, ...(hit ? hit[1] : {}) });
  }
  return out;
}

// ---------- 品名 → 类别和子类 ----------

const SUBTYPE_KEYWORDS: Array<[RegExp, Category, string]> = [
  [/羽绒服|羽绒外套|羽绒马甲|DOWN JACKET/i, 'outer', '羽绒服'],
  [/棉服|棉衣|棉袄|棉外套/, 'outer', '棉服'],
  [/冲锋衣|硬壳|软壳/, 'outer', '冲锋衣'],
  [/风衣|TRENCH/i, 'outer', '风衣'],
  [/大衣|毛呢外套|COAT/i, 'outer', '大衣'],
  [/西装外套|西服外套|西服上衣|西装上衣|BLAZER/i, 'outer', '西装外套'],
  [/皮衣|皮夹克|皮外套/, 'outer', '皮衣'],
  [/开衫|CARDIGAN/i, 'outer', '开衫'],
  [/马甲|背心外套|GILET/i, 'outer', '马甲'],
  [/夹克|外套|JACKET/i, 'outer', '夹克'],
  [/衬衫裙|衬衣裙/, 'dress', '衬衫裙'],
  [/针织连衣裙|毛衣裙|针织裙/, 'dress', '针织裙'],
  [/吊带裙/, 'dress', '吊带裙'],
  [/连衣裙|DRESS/i, 'dress', '连衣裙'],
  [/牛仔裤|JEANS/i, 'bottom', '牛仔裤'],
  [/西裤/, 'bottom', '西裤'],
  [/阔腿裤|WIDE[- ]LEG/i, 'bottom', '阔腿裤'],
  [/工装裤|CARGO/i, 'bottom', '工装裤'],
  [/运动裤|卫裤|束脚裤|JOGGER/i, 'bottom', '运动裤'],
  [/短裤|SHORTS/i, 'bottom', '短裤'],
  [/百褶裙|PLEATED SKIRT/i, 'bottom', '百褶裙'],
  [/半身裙|短裙|长裙|半裙|SKIRT/i, 'bottom', '半身裙'],
  [/休闲裤|长裤|九分裤|直筒裤|锥形裤|针织裤|裤子|PANTS|TROUSERS/i, 'bottom', '休闲裤'],
  [/POLO/i, 'top', 'Polo衫'],
  [/卫衣|连帽衫|SWEATSHIRT|HOODIE/i, 'top', '卫衣'],
  [/毛衣|羊毛衫|羊绒衫|毛针织衫|SWEATER/i, 'top', '毛衣'],
  [/针织衫|针织上衣|KNIT/i, 'top', '针织衫'],
  [/衬衫|衬衣|SHIRT(?!S)/i, 'top', '衬衫'],
  [/T恤|T-SHIRT|TEE|短袖|圆领衫/i, 'top', 'T恤'],
  [/吊带/, 'top', '吊带'],
  [/背心|TANK/i, 'top', '背心'],
  [/打底衫|保暖内衣/, 'top', '打底衫'],
  [/运动鞋|跑鞋|跑步鞋|篮球鞋|SNEAKER/i, 'shoes', '运动鞋'],
  [/帆布鞋/, 'shoes', '帆布鞋'],
  [/乐福鞋|LOAFER/i, 'shoes', '乐福鞋'],
  [/高跟鞋/, 'shoes', '高跟鞋'],
  [/凉鞋|拖鞋/, 'shoes', '凉鞋'],
  [/靴|BOOTS?\b/i, 'shoes', '靴子'],
  [/皮鞋/, 'shoes', '皮鞋'],
  [/双肩包|背包|BACKPACK/i, 'bag', '双肩包'],
  [/托特包|TOTE/i, 'bag', '托特包'],
  [/斜挎包/, 'bag', '斜挎包'],
  [/腰包|胸包/, 'bag', '腰包'],
  [/手提包/, 'bag', '手提包'],
  [/丝巾/, 'scarf', '丝巾'],
  [/围巾|SCARF/i, 'scarf', '围巾'],
  [/棒球帽|鸭舌帽/, 'hat', '棒球帽'],
  [/渔夫帽/, 'hat', '渔夫帽'],
  [/针织帽|毛线帽|BEANIE/i, 'hat', '针织帽'],
  [/腰带|皮带|BELT/i, 'belt', '皮带'],
];

export function subtypeFromName(name: string): { category: Category; subtype: string } | undefined {
  for (const [re, category, subtype] of SUBTYPE_KEYWORDS) if (re.test(name)) return { category, subtype };
  return undefined;
}

// ---------- 版型、长度、腰线字样 ----------

const FIT_WORDS: Array<[RegExp, Fit]> = [
  [/修身|紧身|贴身|窄版|\bSLIM\b|\bSKINNY\b|\bFITTED\b/i, 'slim'],
  [/宽松|廓形|落肩|\bOVERSIZED?\b|\bRELAXED\b|\bLOOSE\b|\bBAGGY\b|阔腿|\bWIDE\b/i, 'loose'],
  [/合体|标准版|标准型|常规版|常规款|直筒|锥形|\bREGULAR\b|\bCLASSIC\b|\bSTRAIGHT\b|\bTAPERED\b/i, 'regular'],
];
// 不收 LONG：英文吊牌上的 LONG SLEEVE 指长袖，不是衣长
const LENGTH_WORDS: Array<[RegExp, Length]> = [
  [/短款|短装|\bCROPPED\b|短裤|短裙/i, 'short'],
  [/中长款|长款|长裙/, 'long'],
  [/七分|九分|及膝|中裙/, 'regular'],
];
const RISE_WORDS: Array<[RegExp, Rise]> = [
  [/高腰|HIGH[- ]?(RISE|WAIST)/i, 'high'],
  [/中腰|MID[- ]?(RISE|WAIST)/i, 'mid'],
  [/低腰|LOW[- ]?(RISE|WAIST)/i, 'low'],
];

function firstWord<T>(text: string, table: Array<[RegExp, T]>): { value: T; word: string } | undefined {
  let best: { value: T; word: string; index: number } | undefined;
  for (const [re, value] of table) {
    const m = text.match(re);
    if (m && m.index !== undefined && (!best || m.index < best.index)) best = { value, word: m[0], index: m.index };
  }
  return best && { value: best.value, word: best.word };
}

// ---------- 主函数 ----------

function lineValue(text: string, keys: RegExp): string | undefined {
  // 双语吊牌常写成"尺码 SIZE M""商品编号 / ITEM NO."，把紧跟着的同义标签也跳过
  const repeat = new RegExp(`^\\s*[:.\\-/]?\\s*(?:${keys.source})\\.?`, 'i');
  for (const line of text.split('\n')) {
    const m = line.match(keys);
    if (!m || m.index === undefined) continue;
    let rest = line.slice(m.index + m[0].length);
    while (repeat.test(rest)) rest = rest.replace(repeat, '');
    rest = rest.replace(/^\s*[:.\-/]?\s*/, '');
    const v = rest.split(/\s{2,}|[,;]/)[0].trim();
    if (v) return v;
  }
  return undefined;
}

/** 洗涤、熨烫等护理说明行，不用来判断款式 */
const CARE_LINE = /洗|熨|漂白|晾|烘干|干洗|拧干|水温|浸泡/;

export function parseTagText(raw: string): TagParse {
  const text = normalizeTagText(raw);
  const upper = text.toUpperCase();
  const result: TagParse = { standards: [], fibers: [], stretch: false };

  // 品牌
  const brandLine = lineValue(text, /(品牌|商标|BRAND)/i);
  result.brand = canonicalBrand(brandLine?.split(/\s/)[0]) ?? findBrand(text);

  // 货号 / 款号
  const styleM = text.match(
    /(货号|款号|款式号|款式编号|商品编号|产品编号|型号|编号|ART\.?\s*NO\.?|STYLE\s*NO\.?|ITEM\s*NO\.?|MODEL)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_./]{3,24})/i,
  );
  if (styleM) result.styleNo = styleM[2].replace(/[./-]+$/, '').toUpperCase();

  // 品名
  const nameLine = lineValue(text, /(品名|产品名称|商品名称|品类)/);
  if (nameLine) result.productName = nameLine.slice(0, 20);

  // 号型（GB/T 1335：身高/胸围或腰围 + 体型）
  const codeM = upper.match(/(?:号型\s*[:]?\s*)?\b(1[4-9]\d)\s*\/\s*(\d{2,3})\s*([YABC])?(?![\d/])/);
  if (codeM) {
    const girth = Number(codeM[2]);
    if (girth >= 50 && girth <= 140) result.sizeCode = `${codeM[1]}/${codeM[2]}${codeM[3] ?? ''}`;
  }
  // 尺码
  const sizeVal = lineValue(text, /(尺码|规格|码数|SIZE)/i);
  const sizeM = sizeVal
    ?.toUpperCase()
    .match(/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|F|FREE|均码|\d{2,3}(?:\/\d{2,3}[YABC]?)?|W\d{2}(?:L\d{2})?)(?![A-Z0-9])/);
  if (sizeM) result.size = sizeM[1] === 'FREE' ? '均码' : sizeM[1];
  if (!result.size) {
    const pair = upper.match(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)\s*\(\s*1\d\d\s*\/\s*\d{2,3}/) ?? upper.match(/1\d\d\s*\/\s*\d{2,3}[YABC]?\s*\(\s*(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)\s*\)/);
    if (pair) result.size = pair[1];
  }
  if (!result.size && result.sizeCode) result.size = result.sizeCode;

  // 执行标准
  result.standards = parseStandards(text);

  // 成分
  result.fibers = parseFibers(text);
  result.materialText = formatFibers(result.fibers);
  const elastane = result.fibers.find((f) => f.part === 'shell' && f.name === '氨纶');
  result.stretch = !!elastane && elastane.pct >= 2;
  const downM = text.match(/含绒量\s*:?\s*(\d{2})(?:\.\d)?\s*%/);
  if (downM) result.downContent = Number(downM[1]);

  // 版型、长度、腰线：优先"版型："这一行，其次全文
  const styleText = text
    .split('\n')
    .filter((l) => !CARE_LINE.test(l))
    .join('\n');
  const fitLine = lineValue(text, /(版型|廓形|FIT)/i);
  const fit = firstWord(fitLine ?? '', FIT_WORDS) ?? firstWord(styleText, FIT_WORDS);
  if (fit) {
    result.fit = fit.value;
    result.fitWord = fit.word;
  }
  const len = firstWord(styleText, LENGTH_WORDS);
  if (len) {
    result.length = len.value;
    result.lengthWord = len.word;
  }
  const rise = firstWord(styleText, RISE_WORDS);
  if (rise) {
    result.rise = rise.value;
    result.riseWord = rise.word;
  }

  // 类别与子类：品名 > 执行标准 > 全文关键词
  const fromName = result.productName ? subtypeFromName(result.productName) : undefined;
  const fromStandard = result.standards.find((s) => s.category);
  const fromKeyword = subtypeFromName(styleText.replace(/(品牌|商标|BRAND)[^\n]*/gi, ''));
  if (fromName) {
    result.category = fromName.category;
    result.subtype = fromName.subtype;
    result.subtypeSource = 'name';
  } else if (fromStandard?.category) {
    result.category = fromStandard.category;
    result.subtype = fromStandard.subtype ?? (fromKeyword?.category === fromStandard.category ? fromKeyword.subtype : undefined);
    result.subtypeSource = 'standard';
  } else if (fromKeyword) {
    result.category = fromKeyword.category;
    result.subtype = fromKeyword.subtype;
    result.subtypeSource = 'keyword';
  }

  // 保暖度提示
  const filling = result.fibers.filter((f) => f.part === 'filling');
  if (filling.some((f) => ['鸭绒', '鹅绒', '羽绒'].includes(f.name)) || result.downContent) {
    result.warmthHint = 3;
    result.warmthReason = '填充物是羽绒';
  } else if (/加绒|加厚|摇粒绒|抓绒/.test(styleText)) {
    result.warmthHint = 3;
    result.warmthReason = '吊牌写着加绒或加厚';
  } else {
    const shell = result.fibers.filter((f) => f.part === 'shell');
    const top = shell[0];
    if (top && ['麻', '真丝'].includes(top.name) && top.pct >= 50) {
      result.warmthHint = 1;
      result.warmthReason = `主要面料是${top.name}，透气轻薄`;
    } else if (/薄款|轻薄/.test(styleText)) {
      result.warmthHint = 1;
      result.warmthReason = '吊牌写着薄款';
    }
  }
  return result;
}

/** 识别出的内容是否足以展示（至少有一项有用信息） */
export function hasUsefulInfo(p: TagParse): boolean {
  return !!(p.brand || p.styleNo || p.size || p.sizeCode || p.fibers.length || p.fit || p.subtype || p.standards.some((s) => s.label));
}
