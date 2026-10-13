// 测试用的衣服轮廓（与示例衣橱相同的主体路径），以及袖子折起来拍的上衣、背心。
import type { RGBAImage } from '../src/core/background';
import { raster, type Shape } from './raster';

export const OUTLINES: Record<string, { view: [number, number]; shapes: Shape[] }> = {
  tee: { view: [200, 196], shapes: [{ d: 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z' }] },
  shirt: { view: [240, 236], shapes: [{ d: 'M84,10 L120,30 L156,10 L192,24 L236,184 L210,194 L172,86 L172,230 L68,230 L68,86 L30,194 L4,184 L48,24 Z' }] },
  hoodie: { view: [250, 246], shapes: [{ d: 'M86,30 Q90,2 125,2 Q160,2 164,30 L200,38 L246,192 L218,204 L178,98 L178,240 L72,240 L72,98 L32,204 L4,192 L50,38 Z' }] },
  pants: { view: [160, 310], shapes: [{ d: 'M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z' }] },
  wide: { view: [190, 310], shapes: [{ d: 'M40,4 L150,4 L150,22 L186,304 L104,304 L95,110 L86,304 L4,304 L40,22 Z' }] },
  shorts: { view: [170, 140], shapes: [{ d: 'M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z' }] },
  skirt: { view: [190, 214], shapes: [{ d: 'M50,4 L140,4 L140,22 L186,208 L4,208 L50,22 Z' }] },
  dress: { view: [210, 340], shapes: [{ d: 'M72,6 L90,6 Q105,34 120,6 L138,6 L150,62 L134,124 L206,334 L4,334 L76,124 L60,62 Z' }] },
  trench: { view: [260, 340], shapes: [{ d: 'M92,8 L130,28 L168,8 L206,22 L256,220 L228,230 L186,96 L194,334 L66,334 L74,96 L32,230 L4,220 L54,22 Z' }] },
  tote: { view: [190, 220], shapes: [{ d: 'M58,70 Q58,8 95,8 Q132,8 132,70', stroke: 9 }, { d: 'M18,66 L172,66 L186,214 L4,214 Z' }] },
  belt: { view: [320, 44], shapes: [{ rect: [40, 10, 276, 24] }, { d: 'M6,4 L48,4 L48,40 L6,40 Z', stroke: 5 }] },
  /** 连帽外套：帽子摊在领口上方，袖子斜着摊开 */
  parka: { view: [210, 300], shapes: [{ d: 'M70,80 Q70,4 105,4 Q140,4 140,80 L180,92 L206,200 L182,208 L166,130 L166,296 L44,296 L44,130 L28,208 L4,200 L30,92 Z' }] },
  /** 袖子折到背后的圆领卫衣：只有衣身，方肩 */
  folded: { view: [200, 230], shapes: [{ d: 'M70,8 Q100,30 130,8 L180,22 L184,40 L184,226 L16,226 L16,40 L20,22 Z' }] },
  /** 袖子折起来的连帽卫衣：帽子摊在领口上方 */
  foldedHood: { view: [200, 300], shapes: [{ d: 'M66,80 Q66,4 100,4 Q134,4 134,80 L184,96 L186,112 L186,296 L14,296 L14,112 L16,96 Z' }] },
  /** 背心：袖窿往里凹 */
  tank: { view: [180, 230], shapes: [{ d: 'M40,6 L62,6 Q90,40 118,6 L140,6 L142,40 Q150,70 174,84 L174,226 L6,226 L6,84 Q30,70 38,40 Z' }] },
};

/** 把轮廓画成指定颜色的去背图 */
export function outlineImage(name: keyof typeof OUTLINES, rgb: [number, number, number] = [60, 110, 72]): RGBAImage {
  const d = OUTLINES[name];
  const r = raster(d.shapes, d.view[0], d.view[1]);
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  for (let i = 0; i < r.w * r.h; i++) data.set([rgb[0], rgb[1], rgb[2], r.alpha[i]], i * 4);
  return { width: r.w, height: r.h, data };
}
