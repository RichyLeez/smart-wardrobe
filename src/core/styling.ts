// 穿法：上衣塞进下装、外套敞开穿。
// 包含能否这样穿的判断，以及把"合上拍的外套正面照片"拉开的图像变形。

import type { RGBAImage } from './background';
import type { Category, Item, Styling } from './types';

/** 能敞开穿的外套（拉链、纽扣）；马甲、羽绒服这类也常敞开 */
const OPENABLE_SUBTYPES = new Set(['西装外套', '夹克', '风衣', '大衣', '羽绒服', '棉服', '开衫', '冲锋衣', '皮衣', '马甲']);

export function defaultOpenable(category: Category, subtype: string): boolean {
  return category === 'outer' && OPENABLE_SUBTYPES.has(subtype);
}

type StyleItem = Pick<Item, 'id' | 'category' | 'subtype' | 'length' | 'openable' | 'photoOpen'>;

/** 外套能不能敞开 / 合上切换（照片本身是敞开的就只能敞开） */
export function canToggleOpen(item: StyleItem): boolean {
  if (item.category !== 'outer' || item.photoOpen) return false;
  return item.openable ?? defaultOpenable(item.category, item.subtype);
}

/** 上衣能不能塞进下装：要有下装，短款上衣本来就在腰线以上 */
export function canTuck(top: StyleItem | undefined, bottom: StyleItem | undefined): boolean {
  return !!top && !!bottom && top.category === 'top' && bottom.category === 'bottom' && top.length !== 'short';
}

export function isOpen(item: StyleItem, styling: Styling | undefined): boolean {
  if (item.category !== 'outer') return false;
  if (item.photoOpen) return true;
  return canToggleOpen(item) && !!styling?.open?.includes(item.id);
}

export function isTucked(item: StyleItem, items: StyleItem[], styling: Styling | undefined): boolean {
  if (item.category !== 'top' || !styling?.tucked?.includes(item.id)) return false;
  return canTuck(item, items.find((i) => i.category === 'bottom'));
}

/** 去掉已经不适用的穿法（例如换掉了下装），返回规范化的结果 */
export function normalizeStyling(items: StyleItem[], styling: Styling | undefined): Styling {
  const tucked = items.filter((i) => isTucked(i, items, styling)).map((i) => i.id);
  const open = items.filter((i) => canToggleOpen(i) && styling?.open?.includes(i.id)).map((i) => i.id);
  const out: Styling = {};
  if (tucked.length) out.tucked = tucked;
  if (open.length) out.open = open;
  return out;
}

export function toggleStyling(styling: Styling | undefined, key: keyof Styling, id: string): Styling {
  const cur = styling?.[key] ?? [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  const out: Styling = { ...styling, [key]: next };
  if (next.length === 0) delete out[key];
  return out;
}

export function sameStyling(a: Styling | undefined, b: Styling | undefined): boolean {
  const k = (s: Styling | undefined) => `${(s?.tucked ?? []).slice().sort().join()}|${(s?.open ?? []).slice().sort().join()}`;
  return k(a) === k(b);
}

/**
 * 人台上的叠放顺序：一般按类别从里到外；上衣塞进下装时，上衣画在下装下面。
 * items 应已按类别排好序。
 */
export function drawOrder<T extends StyleItem>(items: T[], styling: Styling | undefined): T[] {
  const top = items.find((i) => i.category === 'top');
  if (!top || !isTucked(top, items, styling)) return items;
  const rest = items.filter((i) => i !== top);
  const bi = rest.findIndex((i) => i.category === 'bottom');
  return [...rest.slice(0, bi), top, ...rest.slice(bi)];
}

/** 塞进去的上衣在下装腰头以下被遮住：截断位置在下装上沿往下一点 */
export function tuckLine(bottomRect: { y: number; height: number }): number {
  return bottomRect.y + bottomRect.height * 0.035;
}

// ---------- 把外套正面拉开 ----------

/**
 * 把合上拍的外套正面照片"拉开"：以图片中线为门襟，左右前片各自向外侧收拢，
 * 侧缝不动、门襟处移得最多；领口处几乎不动，越往下摆开得越大，中间露出空隙（透明）。
 * 门襟新边缘画一道细阴影，像前片翻开时的厚度。袖子和衣身以外的部分不受影响。
 */
export function openFront(img: RGBAImage, amount = 1): RGBAImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const cx = (w - 1) / 2;
  const opaque = (x: number, y: number) => data[(y * w + x) * 4 + 3] > 127;
  // 衣身上下范围：中线上不透明的行
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (opaque(x, y)) any = true;
    if (any) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return { width: w, height: h, data: new Uint8ClampedArray(data) };
  const span = Math.max(1, bottom - top);
  const mid = Math.round(cx);
  const sample = (x: number, y: number, o: number) => {
    // 双线性取样（只在水平方向）
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const x1 = Math.min(w - 1, x0 + 1);
    const t = Math.max(0, Math.min(1, x - x0));
    for (let c = 0; c < 4; c++) out[o + c] = data[(y * w + x0) * 4 + c] * (1 - t) + data[(y * w + x1) * 4 + c] * t;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      out[i] = data[i];
      out[i + 1] = data[i + 1];
      out[i + 2] = data[i + 2];
      out[i + 3] = data[i + 3];
    }
    // 中线不透明的行才拉开（领口的 V 字、开口处保持原样）
    if (!opaque(mid, y)) continue;
    let L = mid;
    while (L > 0 && opaque(L - 1, y)) L--;
    let R = mid;
    while (R < w - 1 && opaque(R + 1, y)) R++;
    // 衣身半宽：限制在图片宽度的 32% 以内，避免把连在一起的袖子也算进去
    const P = Math.min(mid - L, R - mid, w * 0.32);
    if (P < 4) continue;
    const t = (y - top) / span;
    const D = amount * P * (0.08 + 0.3 * Math.pow(t, 0.9));
    // 前片：源坐标 s ∈ [边, 中线] 映射到 f(s) = s ∓ D·u^1.5（u 为离侧缝的比例），单调，可逐点二分求逆
    for (const side of [-1, 1] as const) {
      const edge = cx + side * P;
      const forward = (s: number) => {
        const u = Math.abs(s - edge) / P;
        return s + side * D * Math.pow(u, 1.5);
      };
      for (let k = 0; k <= Math.ceil(P); k++) {
        const x = Math.round(edge - side * k);
        if (x < 0 || x >= w) continue;
        const o = (row + x) * 4;
        // 中线一侧的空隙
        if (side < 0 ? x > cx - D : x < cx + D) {
          out[o + 3] = 0;
          continue;
        }
        // 二分找源坐标
        let a = edge;
        let b = cx;
        for (let it = 0; it < 18; it++) {
          const m = (a + b) / 2;
          if ((forward(m) - x) * side > 0) a = m;
          else b = m;
        }
        sample((a + b) / 2, y, o);
        // 门襟新边缘：靠近空隙的几个像素加一道阴影
        const dEdge = Math.abs(x - (cx + side * D));
        if (dEdge < 3) {
          const f = 0.72 + 0.09 * dEdge;
          out[o] *= f;
          out[o + 1] *= f;
          out[o + 2] *= f;
        }
      }
    }
  }
  return { width: w, height: h, data: out };
}
