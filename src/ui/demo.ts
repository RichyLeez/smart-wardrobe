// 示例衣橱：用矢量图形画出平铺的衣物，方便在没有录入时先体验推荐流程。
// 示例单品的图片 id 形如 demo:形状:颜色:尺寸，显示时现场绘制，不占用任何存储空间。

import { itemImageIds } from '../core/backup';
import { defaultsFor } from '../core/catalog';
import { hexToLab, hexToRgb, nearestColorName, rgbToHex } from '../core/color';
import { addDays, todayStr } from '../core/stats';
import type { Category, Fit, Item, Length, Outfit, Rise, WearRecord } from '../core/types';
import * as db from '../storage/db';
import { newId } from './ids';
import { scaleCanvas, svgToCanvas, transparentBlob } from './imageTools';

type Shape =
  | 'tee'
  | 'shirt'
  | 'knit'
  | 'hoodie'
  | 'pants'
  | 'wide'
  | 'shorts'
  | 'skirt'
  | 'dress'
  | 'trench'
  | 'blazer'
  | 'down'
  | 'sneakers'
  | 'oxfords'
  | 'boots'
  | 'tote'
  | 'belt'
  | 'scarf';

function mix(hex: string, target: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

function palette(fill: string) {
  const light = hexToLab(fill)[0] > 80;
  return {
    fill,
    line: light ? mix(fill, '#6e6e6a', 0.45) : mix(fill, '#000000', 0.35),
    detail: light ? mix(fill, '#8a8a84', 0.3) : mix(fill, '#ffffff', 0.18),
    shade: mix(fill, '#000000', light ? 0.06 : 0.14),
  };
}

function svgFor(shape: Shape, hex: string, back = false): { svg: string; w: number; h: number } {
  if (back && BACK_SHAPES.has(shape)) return backSvgFor(shape, hex);
  const c = palette(hex);
  const st = `stroke="${c.line}" stroke-width="2.4" stroke-linejoin="round"`;
  const dt = `fill="none" stroke="${c.detail}" stroke-width="2" stroke-linecap="round"`;
  const wrap = (w: number, h: number, body: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}">${body}</svg>`,
    w,
    h,
  });
  switch (shape) {
    case 'tee':
      return wrap(
        200,
        196,
        `<path d="M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z" fill="${c.fill}" ${st}/>
         <path d="M72,10 Q100,36 128,10" ${dt}/><path d="M46,180 L154,180" ${dt}/>`,
      );
    case 'shirt':
      return wrap(
        240,
        236,
        `<path d="M84,10 L120,30 L156,10 L192,24 L236,184 L210,194 L172,86 L172,230 L68,230 L68,86 L30,194 L4,184 L48,24 Z" fill="${c.fill}" ${st}/>
         <path d="M84,10 L104,44 L120,30 L136,44 L156,10" fill="${c.shade}" ${st}/>
         <path d="M120,32 L120,228" ${dt}/>
         ${[60, 100, 140, 180, 214].map((y) => `<circle cx="126" cy="${y}" r="2.8" fill="${c.line}"/>`).join('')}
         <path d="M14,176 L34,184 M226,176 L206,184" ${dt}/>`,
      );
    case 'knit':
      return wrap(
        240,
        234,
        `<path d="M82,12 Q120,34 158,12 L194,26 L236,180 L210,192 L172,88 L172,228 L68,228 L68,88 L30,192 L4,180 L46,26 Z" fill="${c.fill}" ${st}/>
         <path d="M84,14 Q120,42 156,14" ${dt}/>
         <path d="M70,214 L170,214 M12,170 L36,180 M228,170 L204,180" ${dt}/>
         ${[86, 104, 122, 140, 158].map((x) => `<path d="M${x},214 L${x},228" ${dt}/>`).join('')}`,
      );
    case 'hoodie':
      return wrap(
        250,
        246,
        `<path d="M86,30 Q90,2 125,2 Q160,2 164,30 L200,38 L246,192 L218,204 L178,98 L178,240 L72,240 L72,98 L32,204 L4,192 L50,38 Z" fill="${c.fill}" ${st}/>
         <path d="M96,32 Q125,62 154,32" ${dt}/><path d="M112,48 L110,80 M138,48 L140,80" ${dt}/>
         <path d="M90,170 L160,170 L168,210 L82,210 Z" fill="none" stroke="${c.detail}" stroke-width="2"/>`,
      );
    case 'pants':
      return wrap(
        160,
        310,
        `<path d="M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z" fill="${c.fill}" ${st}/>
         <path d="M18,22 L142,22 M80,22 L80,90 M46,30 L52,300 M114,30 L108,300" ${dt}/>`,
      );
    case 'wide':
      return wrap(
        190,
        310,
        `<path d="M40,4 L150,4 L150,22 L186,304 L104,304 L95,110 L86,304 L4,304 L40,22 Z" fill="${c.fill}" ${st}/>
         <path d="M40,22 L150,22 M95,22 L95,100" ${dt}/>`,
      );
    case 'shorts':
      return wrap(
        170,
        140,
        `<path d="M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z" fill="${c.fill}" ${st}/>
         <path d="M22,22 L148,22 M85,22 L85,68" ${dt}/>`,
      );
    case 'skirt':
      return wrap(
        190,
        214,
        `<path d="M50,4 L140,4 L140,22 L186,208 L4,208 L50,22 Z" fill="${c.fill}" ${st}/>
         <path d="M50,22 L140,22 M78,26 L58,204 M112,26 L132,204" ${dt}/>`,
      );
    case 'dress':
      return wrap(
        210,
        340,
        `<path d="M72,6 L90,6 Q105,34 120,6 L138,6 L150,62 L134,124 L206,334 L4,334 L76,124 L60,62 Z" fill="${c.fill}" ${st}/>
         <path d="M76,124 L134,124" ${dt}/><path d="M92,128 L64,330 M118,128 L146,330" ${dt}/>`,
      );
    case 'trench':
      return wrap(
        260,
        340,
        `<path d="M92,8 L130,28 L168,8 L206,22 L256,220 L228,230 L186,96 L194,334 L66,334 L74,96 L32,230 L4,220 L54,22 Z" fill="${c.fill}" ${st}/>
         <path d="M92,8 L112,70 L130,40 L148,70 L168,8" fill="${c.shade}" ${st}/>
         <path d="M130,40 L130,332" ${dt}/><path d="M74,176 L186,176 L186,190 L74,190 Z" fill="${c.shade}" ${st}/>
         ${[100, 140, 220, 260].map((y) => `<circle cx="116" cy="${y}" r="3" fill="${c.line}"/><circle cx="144" cy="${y}" r="3" fill="${c.line}"/>`).join('')}`,
      );
    case 'blazer':
      return wrap(
        250,
        262,
        `<path d="M88,8 L125,26 L162,8 L198,22 L246,196 L220,206 L180,90 L182,256 L68,256 L70,90 L30,206 L4,196 L52,22 Z" fill="${c.fill}" ${st}/>
         <path d="M88,8 L106,96 L125,140 L144,96 L162,8" fill="${c.shade}" ${st}/>
         <circle cx="125" cy="170" r="3.2" fill="${c.line}"/><circle cx="125" cy="200" r="3.2" fill="${c.line}"/>
         <path d="M80,190 L104,190 M146,190 L170,190" ${dt}/>`,
      );
    case 'down':
      return wrap(
        262,
        272,
        `<path d="M90,14 Q131,-2 172,14 L210,28 L258,206 L226,220 L190,104 L194,266 L68,266 L72,104 L36,220 L4,206 L52,28 Z" fill="${c.fill}" ${st}/>
         ${[60, 102, 144, 186, 228].map((y) => `<path d="M72,${y} Q131,${y + 10} 190,${y}" ${dt}/>`).join('')}
         <path d="M131,18 L131,264" ${dt}/>`,
      );
    case 'sneakers':
      return wrap(
        280,
        116,
        `<g transform="translate(120,6)"><path d="M6,70 Q8,30 40,26 L70,30 Q96,46 140,54 Q156,60 154,82 L6,82 Z" fill="${c.shade}" ${st}/>
         <path d="M6,82 L154,82 L154,94 L6,94 Z" fill="#f2f2ee" ${st}/></g>
         <path d="M6,82 Q8,40 42,36 L74,40 Q100,56 146,64 Q162,70 160,94 L6,94 Z" fill="${c.fill}" ${st}/>
         <path d="M6,94 L160,94 L160,108 L6,108 Z" fill="#f2f2ee" ${st}/>
         <path d="M58,46 L74,60 M66,42 L82,56 M48,52 L62,66" ${dt}/>`,
      );
    case 'oxfords':
      return wrap(
        280,
        96,
        `<g transform="translate(116,4)"><path d="M6,62 Q10,34 46,32 Q90,40 136,48 Q156,54 154,74 L6,74 Z" fill="${c.shade}" ${st}/>
         <path d="M6,74 L154,74 L154,82 L6,82 Z" fill="${mix(c.fill, '#000000', 0.4)}" ${st}/></g>
         <path d="M6,74 Q10,44 48,40 Q94,48 142,58 Q162,64 160,84 L6,84 Z" fill="${c.fill}" ${st}/>
         <path d="M6,84 L160,84 L160,92 L6,92 Z" fill="${mix(c.fill, '#000000', 0.4)}" ${st}/>
         <path d="M64,48 Q84,54 100,52" ${dt}/>`,
      );
    case 'boots':
      return wrap(
        250,
        190,
        `<g transform="translate(104,4)"><path d="M14,8 L70,8 L72,110 Q110,118 136,130 Q146,138 144,160 L8,160 Z" fill="${c.shade}" ${st}/></g>
         <path d="M14,14 L72,14 L74,120 Q114,128 140,140 Q152,148 150,172 L8,172 Z" fill="${c.fill}" ${st}/>
         <path d="M8,172 L150,172 L150,184 L8,184 Z" fill="${mix(c.fill, '#000000', 0.45)}" ${st}/>
         <path d="M20,30 L66,30" ${dt}/>`,
      );
    case 'tote':
      return wrap(
        190,
        220,
        `<path d="M58,70 Q58,8 95,8 Q132,8 132,70" fill="none" stroke="${c.line}" stroke-width="9"/>
         <path d="M58,70 Q58,8 95,8 Q132,8 132,70" fill="none" stroke="${c.fill}" stroke-width="5"/>
         <path d="M18,66 L172,66 L186,214 L4,214 Z" fill="${c.fill}" ${st}/>
         <path d="M18,80 L172,80" ${dt}/>`,
      );
    case 'belt':
      return wrap(
        320,
        44,
        `<rect x="40" y="10" width="276" height="24" rx="4" fill="${c.fill}" ${st}/>
         <rect x="6" y="4" width="42" height="36" rx="6" fill="none" stroke="#b8b2a4" stroke-width="5"/>
         <path d="M27,10 L27,34" stroke="#b8b2a4" stroke-width="4"/>
         ${[90, 110, 130].map((x) => `<circle cx="${x}" cy="22" r="2.6" fill="${c.line}"/>`).join('')}`,
      );
    case 'scarf':
      return wrap(
        150,
        250,
        `<path d="M20,6 L130,6 L118,70 L100,240 L64,240 L80,70 L40,70 Z" fill="${c.fill}" ${st}/>
         <path d="M40,70 L118,70" ${dt}/>
         ${[68, 76, 84, 92].map((x) => `<path d="M${x},240 L${x - 2},248" stroke="${c.line}" stroke-width="2"/>`).join('')}`,
      );
  }
}

/** 有背面图的示例衣物 */
const BACK_SHAPES = new Set<Shape>(['tee', 'shirt', 'knit', 'hoodie', 'pants', 'wide', 'shorts', 'skirt', 'dress', 'trench', 'blazer', 'down']);

/** 背面：外轮廓和正面一致（衣服左右翻过来平铺），细节换成背面的样子 */
function backSvgFor(shape: Shape, hex: string): { svg: string; w: number; h: number } {
  const c = palette(hex);
  const st = `stroke="${c.line}" stroke-width="2.4" stroke-linejoin="round"`;
  const dt = `fill="none" stroke="${c.detail}" stroke-width="2" stroke-linecap="round"`;
  const wrap = (w: number, h: number, body: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}">${body}</svg>`,
    w,
    h,
  });
  const pocket = (x: number, y: number, w: number, h: number) =>
    `<path d="M${x},${y} L${x + w},${y} L${x + w - 2},${y + h} L${x + w / 2},${y + h + 6} L${x + 2},${y + h} Z" fill="none" stroke="${c.detail}" stroke-width="2"/>`;
  switch (shape) {
    case 'tee':
      return wrap(
        200,
        196,
        `<path d="M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z" fill="${c.fill}" ${st}/>
         <path d="M70,8 Q100,16 130,8" ${dt}/><path d="M46,180 L154,180" ${dt}/>`,
      );
    case 'shirt':
      return wrap(
        240,
        236,
        `<path d="M84,10 L120,30 L156,10 L192,24 L236,184 L210,194 L172,86 L172,230 L68,230 L68,86 L30,194 L4,184 L48,24 Z" fill="${c.fill}" ${st}/>
         <path d="M84,10 Q120,24 156,10 L156,18 Q120,32 84,18 Z" fill="${c.shade}" ${st}/>
         <path d="M50,46 Q120,54 190,46" ${dt}/><path d="M112,50 L112,64 M128,50 L128,64" ${dt}/>
         <path d="M14,176 L34,184 M226,176 L206,184" ${dt}/>`,
      );
    case 'knit':
      return wrap(
        240,
        234,
        `<path d="M82,12 Q120,34 158,12 L194,26 L236,180 L210,192 L172,88 L172,228 L68,228 L68,88 L30,192 L4,180 L46,26 Z" fill="${c.fill}" ${st}/>
         <path d="M84,14 Q120,24 156,14" ${dt}/>
         <path d="M70,214 L170,214 M12,170 L36,180 M228,170 L204,180" ${dt}/>
         ${[86, 104, 122, 140, 158].map((x) => `<path d="M${x},214 L${x},228" ${dt}/>`).join('')}`,
      );
    case 'hoodie':
      return wrap(
        250,
        246,
        `<path d="M86,30 Q90,2 125,2 Q160,2 164,30 L200,38 L246,192 L218,204 L178,98 L178,240 L72,240 L72,98 L32,204 L4,192 L50,38 Z" fill="${c.fill}" ${st}/>
         <path d="M86,30 Q90,2 125,2 Q160,2 164,30 Q156,86 125,92 Q94,86 86,30 Z" fill="${c.shade}" ${st}/>
         <path d="M125,6 L125,90" ${dt}/><path d="M74,226 L176,226" ${dt}/>`,
      );
    case 'pants':
      return wrap(
        160,
        310,
        `<path d="M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z" fill="${c.fill}" ${st}/>
         <path d="M18,22 L142,22 M80,22 L80,96 M20,36 Q80,48 140,36" ${dt}/>
         ${pocket(30, 44, 36, 34)}${pocket(94, 44, 36, 34)}`,
      );
    case 'wide':
      return wrap(
        190,
        310,
        `<path d="M40,4 L150,4 L150,22 L186,304 L104,304 L95,110 L86,304 L4,304 L40,22 Z" fill="${c.fill}" ${st}/>
         <path d="M40,22 L150,22 M95,22 L95,108 M56,48 L84,48 M106,48 L134,48" ${dt}/>`,
      );
    case 'shorts':
      return wrap(
        170,
        140,
        `<path d="M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z" fill="${c.fill}" ${st}/>
         <path d="M22,22 L148,22 M85,22 L85,72" ${dt}/>${pocket(34, 34, 34, 28)}${pocket(102, 34, 34, 28)}`,
      );
    case 'skirt':
      return wrap(
        190,
        214,
        `<path d="M50,4 L140,4 L140,22 L186,208 L4,208 L50,22 Z" fill="${c.fill}" ${st}/>
         <path d="M50,22 L140,22 M95,6 L95,92" ${dt}/><circle cx="95" cy="12" r="2.4" fill="${c.line}"/>`,
      );
    case 'dress':
      return wrap(
        210,
        340,
        `<path d="M72,6 L90,6 Q105,34 120,6 L138,6 L150,62 L134,124 L206,334 L4,334 L76,124 L60,62 Z" fill="${c.fill}" ${st}/>
         <path d="M90,6 Q105,16 120,6" ${dt}/><path d="M76,124 L134,124 M105,14 L105,150" ${dt}/>`,
      );
    case 'trench':
      return wrap(
        260,
        340,
        `<path d="M92,8 L130,28 L168,8 L206,22 L256,220 L228,230 L186,96 L194,334 L66,334 L74,96 L32,230 L4,220 L54,22 Z" fill="${c.fill}" ${st}/>
         <path d="M92,8 Q130,22 168,8 L170,18 Q130,34 90,18 Z" fill="${c.shade}" ${st}/>
         <path d="M58,26 L202,26 L190,94 Q130,104 70,94 Z" fill="${c.shade}" ${st}/>
         <path d="M74,176 L186,176 L186,190 L74,190 Z" fill="${c.shade}" ${st}/>
         <path d="M130,196 L130,334" ${dt}/><path d="M130,262 L142,334" ${dt}/>`,
      );
    case 'blazer':
      return wrap(
        250,
        262,
        `<path d="M88,8 L125,26 L162,8 L198,22 L246,196 L220,206 L180,90 L182,256 L68,256 L70,90 L30,206 L4,196 L52,22 Z" fill="${c.fill}" ${st}/>
         <path d="M88,8 Q125,22 162,8 L163,16 Q125,32 87,16 Z" fill="${c.shade}" ${st}/>
         <path d="M125,24 L125,256 M125,212 L134,256" ${dt}/>`,
      );
    case 'down':
      return wrap(
        262,
        272,
        `<path d="M90,14 Q131,-2 172,14 L210,28 L258,206 L226,220 L190,104 L194,266 L68,266 L72,104 L36,220 L4,206 L52,28 Z" fill="${c.fill}" ${st}/>
         ${[60, 102, 144, 186, 228].map((y) => `<path d="M72,${y} Q131,${y + 10} 190,${y}" ${dt}/>`).join('')}
         <path d="M92,14 Q131,6 170,14" ${dt}/>`,
      );
    default:
      return svgFor(shape, hex);
  }
}

interface DemoSpec {
  name: string;
  category: Category;
  subtype: string;
  shape: Shape;
  hex: string;
  fit?: Fit;
  length?: Length;
  rise?: Rise;
  favorite?: boolean;
  material?: string;
}

const SPECS: DemoSpec[] = [
  { name: '白衬衫', category: 'top', subtype: '衬衫', shape: 'shirt', hex: '#f3f3f0', favorite: true, material: '棉 100%' },
  { name: '黑色T恤', category: 'top', subtype: 'T恤', shape: 'tee', hex: '#232326', material: '棉 100%' },
  { name: '雾蓝针织衫', category: 'top', subtype: '针织衫', shape: 'knit', hex: '#a7c3df', material: '粘纤 60%，锦纶 40%' },
  { name: '酒红毛衣', category: 'top', subtype: '毛衣', shape: 'knit', hex: '#7a2433', material: '羊毛 70%，锦纶 30%' },
  { name: '灰色卫衣', category: 'top', subtype: '卫衣', shape: 'hoodie', hex: '#8d8d92', material: '棉 80%，聚酯纤维 20%' },
  { name: '藏青西裤', category: 'bottom', subtype: '西裤', shape: 'pants', hex: '#20294a', rise: 'high', material: '聚酯纤维 68%，粘纤 30%，氨纶 2%' },
  { name: '水洗牛仔裤', category: 'bottom', subtype: '牛仔裤', shape: 'pants', hex: '#506f94', material: '棉 98%，氨纶 2%' },
  { name: '卡其阔腿裤', category: 'bottom', subtype: '阔腿裤', shape: 'wide', hex: '#c1a67a', material: '棉 100%' },
  { name: '黑色半身裙', category: 'bottom', subtype: '半身裙', shape: 'skirt', hex: '#252527', material: '聚酯纤维 100%' },
  { name: '米色短裤', category: 'bottom', subtype: '短裤', shape: 'shorts', hex: '#d6c6a6', material: '棉 55%，麻 45%' },
  { name: '樱粉连衣裙', category: 'dress', subtype: '连衣裙', shape: 'dress', hex: '#eeb4c3', material: '粘纤 100%' },
  { name: '卡其风衣', category: 'outer', subtype: '风衣', shape: 'trench', hex: '#bb9f72', favorite: true, material: '棉 100%；里料 聚酯纤维 100%' },
  { name: '炭灰西装', category: 'outer', subtype: '西装外套', shape: 'blazer', hex: '#4a4a4f', material: '羊毛 50%，聚酯纤维 50%' },
  { name: '黑色羽绒服', category: 'outer', subtype: '羽绒服', shape: 'down', hex: '#212124', material: '锦纶 100%；填充 鸭绒 90%' },
  { name: '白色球鞋', category: 'shoes', subtype: '运动鞋', shape: 'sneakers', hex: '#efefec', material: '皮革' },
  { name: '黑色皮鞋', category: 'shoes', subtype: '皮鞋', shape: 'oxfords', hex: '#1d1d20', material: '皮革' },
  { name: '棕色短靴', category: 'shoes', subtype: '靴子', shape: 'boots', hex: '#6b4a30', material: '麂皮' },
  { name: '驼色托特包', category: 'bag', subtype: '托特包', shape: 'tote', hex: '#a9794b', material: '皮革' },
  { name: '黑色皮带', category: 'belt', subtype: '皮带', shape: 'belt', hex: '#1f1f22', material: '皮革' },
  { name: '灰色围巾', category: 'scarf', subtype: '围巾', shape: 'scarf', hex: '#9b9ba0', material: '羊毛 100%' },
];

const SHAPES = new Set<Shape>([
  'tee', 'shirt', 'knit', 'hoodie', 'pants', 'wide', 'shorts', 'skirt', 'dress',
  'trench', 'blazer', 'down', 'sneakers', 'oxfords', 'boots', 'tote', 'belt', 'scarf',
]);

function demoImageId(shape: Shape, hex: string, size: number, back = false): string {
  return `${db.VIRTUAL_IMAGE_PREFIX}${shape}:${hex.replace('#', '')}:${size}${back ? ':back' : ''}`;
}

/** 按图片 id 现场绘制示例衣物，返回透明背景图片 */
export async function renderDemoImage(id: string): Promise<Blob | undefined> {
  const [prefix, shape, hex, size, side] = id.split(':');
  if (`${prefix}:` !== db.VIRTUAL_IMAGE_PREFIX || !SHAPES.has(shape as Shape) || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  const { svg, w, h } = svgFor(shape as Shape, `#${hex}`, side === 'back');
  const canvas = await svgToCanvas(svg, w * 2, h * 2);
  return transparentBlob(scaleCanvas(canvas, Number(size) || 640));
}

export async function createDemoWardrobe(onProgress?: (done: number, total: number) => void): Promise<void> {
  const now = Date.now();
  const items: Item[] = [];
  let n = 0;
  for (const spec of SPECS) {
    const d = defaultsFor(spec.category, spec.subtype)!;
    const { w, h } = svgFor(spec.shape, spec.hex);
    const id = newId('demo-');
    items.push({
      id,
      name: spec.name,
      category: spec.category,
      subtype: spec.subtype,
      color: { hex: spec.hex, name: nearestColorName(hexToLab(spec.hex)).name },
      pattern: 'solid',
      seasons: d.seasons,
      warmth: d.warmth,
      occasions: d.occasions,
      styles: d.styles,
      fit: spec.fit ?? d.fit,
      length: spec.length ?? d.length,
      rise: spec.rise ?? d.rise,
      material: spec.material,
      tags: ['示例'],
      favorite: !!spec.favorite,
      status: 'active',
      images: {
        cutout: demoImageId(spec.shape, spec.hex, 640),
        thumb: demoImageId(spec.shape, spec.hex, 280),
        ...(BACK_SHAPES.has(spec.shape)
          ? { backCutout: demoImageId(spec.shape, spec.hex, 640, true), backThumb: demoImageId(spec.shape, spec.hex, 280, true) }
          : {}),
      },
      imageAspect: w / h,
      backAspect: BACK_SHAPES.has(spec.shape) ? w / h : undefined,
      createdAt: now - (SPECS.length - n) * 60_000 - 40 * 86_400_000,
      updatedAt: now,
      demo: true,
    });
    n++;
  }
  const byName = (name: string) => items.find((i) => i.name === name)!;
  const today = todayStr();
  const mk = (daysAgo: number, names: string[], occasion: WearRecord['occasion'], tempC: number): WearRecord => {
    const its = names.map(byName);
    return {
      id: newId('rec-'),
      date: addDays(today, -daysAgo),
      itemIds: its.map((i) => i.id),
      itemSnapshots: its.map((i) => ({ id: i.id, name: i.name, category: i.category, colorHex: i.color.hex })),
      occasion,
      tempC,
      source: 'manual',
      createdAt: now - daysAgo * 86_400_000,
      updatedAt: now - daysAgo * 86_400_000,
      demo: true,
    };
  };
  const records = [
    mk(1, ['白衬衫', '藏青西裤', '黑色皮鞋', '黑色皮带'], 'commute', 19),
    mk(4, ['灰色卫衣', '水洗牛仔裤', '白色球鞋'], 'casual', 17),
    mk(8, ['雾蓝针织衫', '卡其阔腿裤', '卡其风衣', '白色球鞋'], 'date', 15),
    mk(12, ['白衬衫', '黑色半身裙', '黑色皮鞋'], 'commute', 21),
  ];
  onProgress?.(0, 2);
  await db.putMany('items', items);
  onProgress?.(1, 2);
  await db.putMany('records', records);
  onProgress?.(2, 2);
}

/** 删除全部示例单品，以及示例记录和只由示例单品组成的记录；套装里去掉示例单品 */
export async function removeDemoData(): Promise<number> {
  const [items, records, outfits] = await Promise.all([
    db.getAll<Item>('items'),
    db.getAll<WearRecord>('records'),
    db.getAll<Outfit>('outfits'),
  ]);
  const demoIds = new Set(items.filter((i) => i.demo).map((i) => i.id));
  const imageIds = items
    .filter((i) => i.demo)
    .flatMap(itemImageIds);
  const demoRecords = records.filter((r) => r.demo || (r.itemIds.length > 0 && r.itemIds.every((id) => demoIds.has(id))));
  const touched = outfits.filter((o) => o.itemIds.some((id) => demoIds.has(id)));
  const emptied = touched.filter((o) => o.itemIds.every((id) => demoIds.has(id)));
  const kept = touched
    .filter((o) => !emptied.includes(o))
    .map((o) => ({ ...o, itemIds: o.itemIds.filter((id) => !demoIds.has(id)), updatedAt: Date.now() }));
  await db.deleteMany('images', imageIds);
  await db.deleteMany('items', [...demoIds]);
  await db.deleteMany('records', demoRecords.map((r) => r.id));
  await db.deleteMany('outfits', emptied.map((o) => o.id));
  await db.putMany('outfits', kept);
  return demoIds.size;
}
