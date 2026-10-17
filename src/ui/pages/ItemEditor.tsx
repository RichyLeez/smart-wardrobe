// 录入与编辑单品：拍照 → 本地去背（可手动擦除/恢复）→ 自动取色 → 点选字段。
// 正面必拍，背面可选：背面照片走同样的去背流程，用于人台背面和 3D 展示。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  alphaBBox,
  applyMaskAndCrop,
  combineMask,
  estimateBackground,
  paintOverride,
  removeBackground,
  suggestThreshold,
  toLabBuffer,
  type BackgroundEstimate,
  type RGBAImage,
} from '../../core/background';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  FIELD_APPLICABILITY,
  FIT_LABELS,
  OCCASIONS,
  OCCASION_LABELS,
  PATTERN_LABELS,
  RISE_LABELS,
  SEASONS,
  SEASON_LABELS,
  STYLES,
  STYLE_LABELS,
  WARMTH_LABELS,
  defaultsFor,
  lengthLabels,
  subtypesOf,
} from '../../core/catalog';
import { PALETTE, extractColors, suggestColors, type ColorSuggestion } from '../../core/color';
import { backImageIds } from '../../core/backup';
import { cleanupCut, isLowContrast } from '../../core/autocut';
import { frameContact, frameContactText } from '../../core/frame';
import { removeMasked } from '../../core/hanger';
import { alphaOf, rotateImage, uprightPiece } from '../../core/orient';
import { hoodTop } from '../../core/hood';
import { guessCategory } from '../../core/guess';
import { measureShape } from '../../core/measure';
import { PRIOR_WEIGHT } from '../../core/smartcut';
import { smartCut } from '../../core/smartcut';
import { colorPlus } from '../../core/pending';
import { defaultOpenable } from '../../core/styling';
import { analyzeSizeFit } from '../../core/sizefit';
import { wearStats } from '../../core/stats';
import type { Category, ColorInfo, Fit, Item, Length, Occasion, Pattern, Rise, Season, Style, Warmth } from '../../core/types';
import { ChipMulti, ChipSelect, Field, Segmented, Switch } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ItemThumb, NoteList } from '../components/Bits';
import {
  canvasToBlob,
  loadPhoto,
  renderMaskPreview,
  rgbaToCanvas,
  scaleCanvas,
  transparentBlob,
} from '../imageTools';
import { MODEL_SIZE_MB, mattingAvailable, mattingEnabled, prepareMatting, runMatting, useMatting } from '../matting';
import { newId, setPreviewImage, useImageUrl, useStore, type NewImage } from '../store';
import { Mannequin } from '../components/Mannequin';
import { useUI } from '../ui';
import * as db from '../../storage/db';

type Step = 'photo' | 'cutout' | 'info';
type Tool = 'none' | 'erase' | 'restore';
type Side = 'front' | 'back';
/** 去背方式：智能（颜色模型 + 图割，适合背景不纯）/ 按颜色（从边缘按背景色扩展，适合纯色背景） */
type CutMode = 'smart' | 'color';

interface Work {
  rgba: RGBAImage;
  archive: HTMLCanvasElement;
  lab: Float32Array;
  bg: BackgroundEstimate;
  /** 按颜色去背的结果（也是智能去背的起点） */
  colorAuto: Uint8Array;
  /** 计算 colorAuto 时用的灵敏度 */
  colorThreshold: number;
  /** 当前方式下的自动结果 */
  auto: Uint8Array;
  /** 手动笔刷：1 擦除，2 恢复 */
  override: Uint8Array;
  /** 抠图模型的结果（每个像素是衣服的概率）和它在去背里的权重；没用模型时为空 */
  prior?: Uint8Array;
  priorWeight?: number;
  /** 模型这次的情况：用上了 / 照片太杂没把握 */
  model?: 'used' | 'unsure';
}

function hasStrokes(o: Uint8Array): boolean {
  for (let i = 0; i < o.length; i++) if (o[i]) return true;
  return false;
}

interface Prepared {
  /** 去背、转正、裁好的图 */
  base: RGBAImage;
  /** 用户手动再顺时针转了几个 90° */
  turns: number;
  archive: HTMLCanvasElement;
  colors: ColorSuggestion | null;
}

/** 最终的换装贴图：按手动转的角度转好 */
interface Composed {
  cutout: HTMLCanvasElement;
  aspect: number;
  /** 连帽上衣：帽子占贴图高度的比例 */
  hood: number;
  /** 不透明度（量衣身宽度用） */
  alpha: Uint8Array;
  w: number;
  h: number;
}

function compose(p: Prepared): Composed {
  const img = p.turns ? rotateImage(p.base, p.turns * 90) : p.base;
  const alpha = alphaOf(img);
  return {
    cutout: scaleCanvas(rgbaToCanvas(img), 640),
    aspect: img.width / img.height,
    hood: hoodTop(alpha, img.width, img.height),
    alpha,
    w: img.width,
    h: img.height,
  };
}

let previewSeq = 0;

interface Draft {
  name: string;
  nameTouched: boolean;
  category: Category | null;
  subtype: string | null;
  color: ColorInfo | null;
  color2?: ColorInfo;
  pattern: Pattern;
  seasons: Season[];
  warmth: Warmth;
  occasions: Occasion[];
  styles: Style[];
  fit?: Fit;
  length?: Length;
  rise?: Rise;
  material: string;
  brand: string;
  styleNo: string;
  size: string;
  /** 吊牌识别：原文、来源、执行标准、吊牌标注的版型 */
  tagRaw?: string;
  tagSource?: 'ocr' | 'paste';
  tagStandard?: string;
  tagFit?: Fit;
  tags: string;
  favorite: boolean;
  /** 外套能否敞开穿；undefined 表示按子类判断 */
  openable?: boolean;
  /** 外套照片拍的时候就是敞开的 */
  photoOpen: boolean;
  /** 试穿时不放下帽子 */
  hoodUp: boolean;
  /** 人台上的大小（1 为默认） */
  sizeAdjust: number;
  /** 类别是按轮廓猜的（用户还没改过） */
  categoryGuessed: boolean;
}

function draftFromItem(i: Item): Draft {
  return {
    name: i.name,
    nameTouched: true,
    category: i.category,
    subtype: i.subtype,
    color: i.color,
    color2: i.color2,
    pattern: i.pattern,
    seasons: i.seasons,
    warmth: i.warmth,
    occasions: i.occasions,
    styles: i.styles,
    fit: i.fit,
    length: i.length,
    rise: i.rise,
    material: i.material ?? '',
    brand: i.brand ?? '',
    styleNo: i.styleNo ?? '',
    size: i.size ?? '',
    tagRaw: i.tagInfo?.raw,
    tagSource: i.tagInfo?.source,
    tagStandard: i.tagInfo?.standard,
    tagFit: i.tagInfo?.fit,
    tags: i.tags.join('，'),
    favorite: i.favorite,
    openable: i.openable,
    photoOpen: !!i.photoOpen,
    hoodUp: !!i.hoodUp,
    sizeAdjust: i.sizeAdjust ?? 1,
    categoryGuessed: false,
  };
}

const EMPTY_DRAFT: Draft = {
  name: '',
  nameTouched: false,
  category: null,
  subtype: null,
  color: null,
  pattern: 'solid',
  seasons: [],
  warmth: 2,
  occasions: [],
  styles: [],
  material: '',
  brand: '',
  styleNo: '',
  size: '',
  tags: '',
  favorite: false,
  photoOpen: false,
  hoodUp: false,
  sizeAdjust: 1,
  categoryGuessed: false,
};

/** 选定子类时套用常用默认值（保暖度、季节、场合、风格、版型、长度、腰线） */
function withSubtype(d: Draft, category: Category, subtype: string | undefined): Draft {
  const app = FIELD_APPLICABILITY[category];
  const base: Draft = {
    ...d,
    category,
    fit: app.fit ? d.fit : undefined,
    length: app.length ? d.length : undefined,
    rise: app.rise ? d.rise : undefined,
  };
  if (!subtype) return { ...base, subtype: d.category === category ? d.subtype : null };
  const def = defaultsFor(category, subtype);
  return {
    ...base,
    subtype,
    ...(def
      ? {
          warmth: def.warmth,
          seasons: def.seasons,
          occasions: def.occasions,
          styles: def.styles,
          fit: app.fit ? def.fit ?? base.fit ?? 'regular' : undefined,
          length: app.length ? def.length ?? base.length ?? 'regular' : undefined,
          rise: app.rise ? def.rise ?? base.rise ?? 'mid' : undefined,
        }
      : {}),
  };
}

export function ItemEditor({ id }: { id: string | null }) {
  const store = useStore();
  const ui = useUI();
  const existing = id ? store.items.find((i) => i.id === id) ?? null : null;
  const [step, setStep] = useState<Step>(existing ? 'info' : 'photo');
  const [work, setWork] = useState<Work | null>(null);
  const [threshold, setThreshold] = useState(20);
  const [mode, setMode] = useState<CutMode>('smart');
  const [tool, setTool] = useState<Tool>('none');
  const [brush, setBrush] = useState(18);
  const [noRemoval, setNoRemoval] = useState(false);
  /** 认出的"衣架"其实是衣服的一部分时，用户可以保留 */
  const [keepHanger, setKeepHanger] = useState(false);
  /** 自动补回衣服上和背景同色的部分（白底上的白色印花、白条纹） */
  const [fillGaps, setFillGaps] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  /** 正在拍的是正面还是背面 */
  const [side, setSide] = useState<Side>('front');
  const [preparedBack, setPreparedBack] = useState<Prepared | null>(null);
  /** 编辑已有单品时去掉原来的背面照片 */
  const [removeBack, setRemoveBack] = useState(false);
  const [draft, setDraft] = useState<Draft>(existing ? draftFromItem(existing) : EMPTY_DRAFT);
  const [showPalette, setShowPalette] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const matting = useMatting();
  const canMatting = useMemo(() => mattingAvailable(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const painting = useRef(false);
  const frame = useRef(0);
  const composed = useMemo(() => (prepared ? compose(prepared) : null), [prepared]);
  /** 帽子占贴图高度的比例：换了照片按新贴图量，否则用存着的 */
  const hoodMeasured = composed ? composed.hood : existing?.hoodTop;
  const hoodFrac = hoodMeasured ?? 0;
  /** 基准宽度（衣身 / 腰头）：换了照片或改了类别时重新量 */
  const shape = useMemo(() => {
    const c = draft.category;
    if (!c) return undefined;
    if (composed) return measureShape(composed.alpha, composed.w, composed.h, c, composed.hood) ?? undefined;
    return existing && existing.category === c ? existing.shape : undefined;
  }, [composed, draft.category, existing]);
  const composedBack = useMemo(() => (preparedBack ? compose(preparedBack) : null), [preparedBack]);
  const preview = useMemo(() => (composed ? composed.cutout.toDataURL() : null), [composed]);
  // 人台预览用的临时图片 id（每换一次图换一个，人台会重新读取）
  const previewId = useMemo(() => {
    if (!preview) return null;
    const pid = `preview:${++previewSeq}`;
    setPreviewImage(pid, preview);
    return pid;
  }, [preview]);
  const backPreview = useMemo(() => (composedBack ? composedBack.cutout.toDataURL() : null), [composedBack]);
  const hasExistingBack = !!existing?.images.backCutout && !removeBack;
  const stats = existing ? wearStats(store.records).get(existing.id) : undefined;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const closeEditor = () => ui.close();
  /** 以前批量录入、还没确认的单品 */
  const isPending = existing?.status === 'pending';

  // 用过一次识别模型后，打开录入页就在后台准备好（从本机缓存读取）
  useEffect(() => {
    if (canMatting && mattingEnabled()) void prepareMatting();
  }, [canMatting]);

  // ---------- 照片与去背 ----------

  async function onFile(file: Blob | undefined) {
    if (!file) return;
    setBusy('正在读取照片…');
    try {
      const photo = await loadPhoto(file);
      await new Promise((r) => setTimeout(r, 20));
      setBusy(mode === 'smart' ? '正在智能去背…' : '正在去除背景…');
      await new Promise((r) => setTimeout(r, 30));
      const lab = toLabBuffer(photo.rgba);
      const bg = estimateBackground(photo.rgba, lab);
      const t = suggestThreshold(bg);
      const res = removeBackground(photo.rgba, { threshold: t }, lab);
      // 识别模型：只在智能方式下用；没准备好时照常按颜色和图割去背
      let prior: Uint8Array | undefined;
      let priorWeight: number | undefined;
      let modelUse: Work['model'];
      if (mode === 'smart') {
        if (matting.status === 'downloading' || matting.status === 'preparing') {
          setBusy('正在准备识别模型…');
          await prepareMatting();
        }
        setBusy('正在识别衣服…');
        await new Promise((r) => setTimeout(r, 30));
        const m = await runMatting(photo.rgba);
        if (m) {
          // 模型对这张照片没把握（杂物多）时权重降到 0，只按颜色去背
          priorWeight = PRIOR_WEIGHT * m.confidence;
          prior = m.prior;
          modelUse = m.confidence >= 0.3 ? 'used' : 'unsure';
        }
        setBusy('正在智能去背…');
        await new Promise((r) => setTimeout(r, 20));
      }
      const smart = mode === 'smart' ? smartCut(photo.rgba, { init: res.alpha, prior, priorWeight }) : null;
      setThreshold(t);
      setWork({
        rgba: photo.rgba,
        archive: photo.archive,
        lab,
        bg,
        colorAuto: res.alpha,
        colorThreshold: t,
        auto: smart ? smart.alpha : res.alpha,
        override: new Uint8Array(photo.rgba.width * photo.rgba.height),
        prior,
        priorWeight,
        model: modelUse,
      });
      setNoRemoval((smart ?? res).coverage > 0.97);
      setKeepHanger(false);
      setFillGaps(true);
      setTool('none');
      setStep('cutout');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '照片处理失败');
    } finally {
      setBusy(null);
      if (cameraRef.current) cameraRef.current.value = '';
      if (albumRef.current) albumRef.current.value = '';
    }
  }

  /** 用存档的原图重新去背（去背不准、或者想用识别模型再去一次时，不用重拍） */
  async function recutFromOriginal() {
    const id = existing?.images.original;
    if (!id) return;
    setBusy('正在读取原图…');
    try {
      const src = await db.imageSrc(id);
      if (!src) throw new Error('原图找不到了，请重新拍照');
      const blob = await (await fetch(src.url)).blob();
      if (src.revoke) URL.revokeObjectURL(src.url);
      setBusy(null);
      await onFile(blob);
    } catch (e) {
      setBusy(null);
      ui.toast(e instanceof Error ? e.message : '原图读取失败');
    }
  }

  // 按颜色去背：调整灵敏度后重新计算（稍作延迟，避免拖动滑块时卡顿）
  useEffect(() => {
    if (!work || work.colorThreshold === threshold) return;
    const timer = window.setTimeout(() => {
      const res = removeBackground(work.rgba, { threshold }, work.lab);
      setWork((w) => (w ? { ...w, colorAuto: res.alpha, colorThreshold: threshold, auto: mode === 'color' ? res.alpha : w.auto } : w));
    }, 140);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold]);

  /** 智能去背：按当前笔刷重新分割；按颜色：直接用颜色结果 */
  async function recompute(w: Work, m: CutMode) {
    if (m === 'color') {
      setWork({ ...w, auto: w.colorAuto });
      return;
    }
    setBusy('正在智能去背…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const r = smartCut(w.rgba, {
        init: w.colorAuto,
        strokes: hasStrokes(w.override) ? w.override : undefined,
        prior: w.prior,
        priorWeight: w.priorWeight,
      });
      setWork({ ...w, auto: r.alpha });
    } finally {
      setBusy(null);
    }
  }

  function chooseMode(m: CutMode) {
    setMode(m);
    if (work) void recompute(work, m);
  }

  // 自动去背后的整理：补回和背景同色的衣服部分（白底上的白色印花、白条纹），
  // 再找衣架（挂着拍时挂钩和伸出肩外的横杆常和衣服连在一起）
  const workAuto = work?.auto;
  const cleaned = useMemo(() => (work && workAuto ? cleanupCut(workAuto, work.rgba) : null), [workAuto]);
  const hanger = cleaned?.hanger;
  const gapsFound = !!cleaned && cleaned.gaps.addedCount > 0;

  const currentAlpha = (w: Work) => {
    if (noRemoval) return new Uint8Array(w.auto.length).fill(255);
    // 先补回、去掉衣架，再叠加手动笔刷（笔刷涂到的地方以笔刷为准）
    let auto = cleaned && fillGaps ? cleaned.filled : w.auto;
    if (hanger?.found && !keepHanger) auto = removeMasked(auto, hanger.mask);
    return combineMask(auto, w.override);
  };
  // 衣服有没有碰到照片边缘（碰到的部分会被当成背景去掉）
  const edgeContact = useMemo(
    () => (work && cleaned && !noRemoval ? frameContact(work.rgba, cleaned.filled) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleaned, noRemoval],
  );
  // 按补回后的结果判断（关掉补回开关时提示也不消失）
  const lowContrast = useMemo(
    () => (work && cleaned && !noRemoval ? isLowContrast(work.rgba, cleaned.filled, work.bg, cleaned.gaps) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleaned, noRemoval],
  );

  useEffect(() => {
    if (step !== 'cutout' || !work || !canvasRef.current) return;
    renderMaskPreview(canvasRef.current, work.rgba, currentAlpha(work));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, work, noRemoval, cleaned, keepHanger, fillGaps]);

  function paintAt(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current;
    if (!c || !work || tool === 'none') return;
    const rect = c.getBoundingClientRect();
    const k = c.width / rect.width;
    const x = (e.clientX - rect.left) * k;
    const y = (e.clientY - rect.top) * k;
    paintOverride(work.override, c.width, c.height, x, y, brush * k, tool === 'erase' ? 1 : 2);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (canvasRef.current) renderMaskPreview(canvasRef.current, work.rgba, currentAlpha(work));
    });
  }

  function resetManual() {
    if (!work) return;
    work.override.fill(0);
    if (mode === 'smart') void recompute(work, mode);
    else setWork({ ...work });
  }

  /** 一笔画完：智能方式下按笔刷重新贴合边缘 */
  function endStroke() {
    if (!painting.current) return;
    painting.current = false;
    if (work && mode === 'smart') void recompute(work, 'smart');
  }

  async function finishCutout() {
    if (!work) return;
    setBusy('正在生成贴图…');
    await new Promise((r) => setTimeout(r, 20));
    try {
      const alpha = currentAlpha(work);
      const box = alphaBBox(alpha, work.rgba.width, work.rgba.height);
      if (!box || box.width < 8 || box.height < 8) {
        ui.toast('没有识别到衣物，请调低灵敏度或用"恢复"笔刷涂出衣物');
        return;
      }
      const cropped = applyMaskAndCrop(work.rgba, alpha, box);
      // 横着、倒着拍的转成领口朝上
      const up = noRemoval ? { image: cropped, angle: 0 } : uprightPiece(cropped);
      if (side === 'back') {
        setPreparedBack({ base: up.image, turns: 0, archive: work.archive, colors: null });
        setRemoveBack(false);
        setSide('front');
        setStep('info');
        ui.toast('背面已加上，保存后生效');
        return;
      }
      const colors = suggestColors(extractColors(cropped.data, 4));
      setPrepared({ base: up.image, turns: 0, archive: work.archive, colors });
      // 按轮廓猜类别（不看摊开的帽子）：只在还没选类别时填上，用户可以改
      let guess = null;
      if (!noRemoval) {
        const a = alphaOf(up.image);
        const hood = hoodTop(a, up.image.width, up.image.height);
        if (hood > 0) a.fill(0, 0, Math.round(up.image.height * hood) * up.image.width);
        guess = guessCategory(a, up.image.width, up.image.height, colors?.primary.hex);
      }
      setDraft((d) => {
        let next = d;
        if (guess && !d.category) {
          next = { ...withSubtype(d, guess.category, guess.subtype || undefined), categoryGuessed: true };
        }
        if (!colors) return next;
        const color = { hex: colors.primary.hex, name: colors.primary.name };
        const color2 = colors.multiColor && colors.secondary ? { ...colors.secondary } : undefined;
        return { ...next, color, color2, name: d.nameTouched ? d.name : autoName(color.name, next.subtype) };
      });
      if (up.angle && Math.abs(up.angle) >= 45) ui.toast('已经把照片转正了，方向不对可以点「转 90°」');
      setStep('info');
    } finally {
      setBusy(null);
    }
  }

  // ---------- 字段 ----------

  function autoName(colorName: string | undefined, subtype: string | null): string {
    if (!subtype) return colorName ?? '';
    return colorPlus(colorName ?? '', subtype);
  }

  function chooseCategory(c: Category | null) {
    if (!c) return;
    setDraft((d) => ({
      ...d,
      category: c,
      subtype: null,
      categoryGuessed: false,
      fit: FIELD_APPLICABILITY[c].fit ? d.fit : undefined,
      length: FIELD_APPLICABILITY[c].length ? d.length : undefined,
      rise: FIELD_APPLICABILITY[c].rise ? d.rise : undefined,
    }));
  }

  function chooseSubtype(s: string | null) {
    if (!s || !draft.category) return;
    const cat = draft.category;
    setDraft((d) => {
      const next = withSubtype(d, cat, s);
      return { ...next, categoryGuessed: false, name: d.nameTouched ? d.name : autoName(d.color?.name, s) };
    });
  }

  // ---------- 版型 ----------

  function baseFitOf(d: Draft): Fit | undefined {
    if (d.tagFit) return d.tagFit;
    return d.category && d.subtype ? defaultsFor(d.category, d.subtype)?.fit : undefined;
  }

  async function save() {
    if (!draft.category) return ui.toast('请选择类别');
    if (!draft.subtype) return ui.toast('请选择子类');
    if (!draft.color) return ui.toast('请选择颜色');
    const name = draft.name.trim() || autoName(draft.color.name, draft.subtype);
    if (!existing && !prepared) return ui.toast('请先拍照或选择照片');
    setBusy('正在保存…');
    try {
      const now = Date.now();
      const images: NewImage[] = [];
      let imageRefs = existing?.images;
      let aspect = existing?.imageAspect ?? 1;
      const replaced: string[] = [];
      if (prepared && composed) {
        const cutoutId = newId('img-');
        const thumbId = newId('img-');
        const originalId = newId('img-');
        const thumb = scaleCanvas(composed.cutout, 280);
        images.push({ id: cutoutId, blob: await transparentBlob(composed.cutout), width: composed.cutout.width, height: composed.cutout.height });
        images.push({ id: thumbId, blob: await transparentBlob(thumb), width: thumb.width, height: thumb.height });
        images.push({ id: originalId, blob: await canvasToBlob(prepared.archive, 'image/jpeg', 0.85), width: prepared.archive.width, height: prepared.archive.height });
        if (existing) replaced.push(existing.images.cutout, existing.images.thumb, ...(existing.images.original ? [existing.images.original] : []));
        // 只换正面时保留原来的背面
        imageRefs = { ...imageRefs, cutout: cutoutId, thumb: thumbId, original: originalId };
        aspect = composed.aspect;
      }
      let backAspect = existing?.backAspect;
      if (preparedBack && composedBack) {
        const cutoutId = newId('img-');
        const thumbId = newId('img-');
        const originalId = newId('img-');
        const thumb = scaleCanvas(composedBack.cutout, 280);
        images.push({ id: cutoutId, blob: await transparentBlob(composedBack.cutout), width: composedBack.cutout.width, height: composedBack.cutout.height });
        images.push({ id: thumbId, blob: await transparentBlob(thumb), width: thumb.width, height: thumb.height });
        images.push({ id: originalId, blob: await canvasToBlob(preparedBack.archive, 'image/jpeg', 0.85), width: preparedBack.archive.width, height: preparedBack.archive.height });
        if (existing) replaced.push(...backImageIds(existing));
        imageRefs = { ...imageRefs!, backCutout: cutoutId, backThumb: thumbId, backOriginal: originalId };
        backAspect = composedBack.aspect;
      } else if (removeBack && existing) {
        replaced.push(...backImageIds(existing));
        imageRefs = { ...imageRefs!, backCutout: undefined, backThumb: undefined, backOriginal: undefined };
        backAspect = undefined;
      }
      const app = FIELD_APPLICABILITY[draft.category];
      const item: Item = {
        id: existing?.id ?? newId('item-'),
        name,
        category: draft.category,
        subtype: draft.subtype,
        color: draft.color,
        color2: draft.color2,
        pattern: draft.pattern,
        seasons: draft.seasons,
        warmth: draft.warmth,
        occasions: draft.occasions,
        styles: draft.styles,
        fit: app.fit ? draft.fit : undefined,
        length: app.length ? draft.length : undefined,
        rise: app.rise ? draft.rise : undefined,
        material: draft.material.trim() || undefined,
        brand: draft.brand.trim() || undefined,
        styleNo: draft.styleNo.trim() || undefined,
        size: draft.size.trim() || undefined,
        tagInfo: draft.tagRaw
          ? { raw: draft.tagRaw, source: draft.tagSource ?? 'paste', standard: draft.tagStandard, fit: draft.tagFit, updatedAt: now }
          : undefined,
        tags: draft.tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        favorite: draft.favorite,
        openable: draft.category === 'outer' && !draft.photoOpen ? draft.openable : undefined,
        photoOpen: draft.category === 'outer' && draft.photoOpen ? true : undefined,
        // 换了照片按这次的贴图量帽子；没换照片时沿用原来的（旧单品在打开时补量）
        hoodTop: hoodMeasured !== undefined ? Math.round(hoodMeasured * 1000) / 1000 : undefined,
        hoodUp: hoodFrac > 0 && draft.hoodUp ? true : undefined,
        shape,
        sizeAdjust: Math.abs(draft.sizeAdjust - 1) > 0.001 ? draft.sizeAdjust : undefined,
        // 待整理的单品保存即确认
        status: existing && existing.status !== 'pending' ? existing.status : 'active',
        images: imageRefs!,
        imageAspect: aspect,
        backAspect: imageRefs!.backCutout ? backAspect : undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        demo: existing?.demo && !prepared && !preparedBack && !removeBack ? existing.demo : undefined,
      };
      await store.saveItem(item, images, replaced);
      if (existing) {
        ui.toast(isPending ? '已确认，放进衣橱了' : '已保存');
        closeEditor();
      } else {
        ui.toast(`已录入 ${name}`, { label: '继续录入', run: () => ui.open({ kind: 'item', id: null }) });
        ui.close();
      }
    } catch (e) {
      ui.toast(e instanceof Error ? `保存失败：${e.message}` : '保存失败，可能是存储空间不足');
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (!existing) return;
    const status = existing.status === 'active' ? 'archived' : 'active';
    await store.saveItem({ ...existing, status, updatedAt: Date.now() });
    ui.toast(status === 'archived' ? '已归档，不再参与推荐' : '已恢复到衣橱');
    closeEditor();
  }

  async function remove() {
    if (!existing) return;
    const ok = await ui.confirm({
      title: `删除${existing.name}？`,
      body: '图片会一起删除，无法恢复。过去的穿搭记录会保留它的名称。只是暂时不穿的话，可以选择归档。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await store.deleteItem(existing.id);
    ui.toast('已删除');
    closeEditor();
  }

  // ---------- 渲染 ----------

  const cat = draft.category;
  const app = cat ? FIELD_APPLICABILITY[cat] : null;
  const sizeFit = cat && draft.size.trim()
    ? analyzeSizeFit({ category: cat, subtype: draft.subtype ?? undefined, fit: baseFitOf(draft), size: draft.size }, store.settings.body)
    : null;
  const isNew = !existing;
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'photo', label: side === 'back' ? '1 背面' : '1 照片' },
    { key: 'cutout', label: '2 去背' },
    { key: 'info', label: '3 信息' },
  ];
  const backThumbId = hasExistingBack ? existing?.images.backThumb : undefined;

  function startBack() {
    setSide('back');
    setStep('photo');
  }

  function cancelBack() {
    setSide('front');
    setStep('info');
  }
  const stepIndex = steps.findIndex((s) => s.key === step);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={isNew ? '录入单品' : '编辑单品'}>
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={closeEditor}>
            <Icon name="close" />
          </button>
          <h1>{isNew ? '录入单品' : existing.name}</h1>
          {step === 'info' ? (
            <button type="button" className="btn btn-primary btn-small" disabled={!!busy} onClick={save}>
              {isPending ? '确认' : '保存'}
            </button>
          ) : (
            <span style={{ width: 40 }} />
          )}
        </header>

        {(isNew || step !== 'info') && (
          <nav className="steps" aria-label="录入步骤">
            {steps.map((s, i) => (
              <button
                key={s.key}
                type="button"
                aria-current={step === s.key ? 'step' : undefined}
                className={i < stepIndex ? 'done' : undefined}
                disabled={i > stepIndex || busy !== null}
                onClick={() => setStep(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>
        )}

        <div className="page">
          {step === 'photo' && (
            <div className="capture">
              <div className="capture-zone">
                <div>
                  <Icon name="camera" />
                  <p style={{ margin: '8px 0 16px' }}>{busy ?? (side === 'back' ? '把衣服翻过来，拍背面' : '拍一张平铺的衣物照片')}</p>
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => cameraRef.current?.click()}>
                      <Icon name="camera" />
                      拍照
                    </button>
                    <button type="button" className="btn" disabled={!!busy} onClick={() => albumRef.current?.click()}>
                      <Icon name="image" />
                      从相册选
                    </button>
                  </div>
                </div>
              </div>
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e: React.ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
              <input ref={albumRef} type="file" accept="image/*" hidden data-testid="photo-input" onChange={(e: React.ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
              {side === 'back' ? (
                <ul className="tips">
                  <li>像翻书一样左右翻面，领口仍然朝上，摆成和正面差不多的形状。</li>
                  <li>背景和光线尽量和拍正面时一样。</li>
                  <li>背面照片用在人台背面和 3D 展示，不影响颜色识别。</li>
                </ul>
              ) : (
              <ul className="tips">
                <li>衣物平铺，完整入镜，四周都要露出一截背景。碰到照片边缘的部分会被去掉。</li>
                <li>横着拍、倒着拍都可以，会自动转成领口朝上。</li>
                <li>深色衣物配浅色背景，浅色衣物配深色背景，背景越纯越好（床单、地板、纸板都可以）。</li>
                <li>光线均匀，避免强烈阴影和反光。</li>
                <li>上衣和外套尽量把袖子摆开，换装时更像穿在身上。连帽的衣服把帽子摊在领口上方，试穿时会自动放下。</li>
                <li>挂在衣架上拍也可以，挂钩和横杆会自动去掉。</li>
                <li>白色或带白边、白字的衣服，用深色床单或地板当背景；用了识别模型后白底也能拍，但深色背景仍然更准。</li>
                <li>外套拉好拉链拍，搭配时可以选择敞开或合上；没拉拉链拍的，录入时打开「照片里是敞开的」。</li>
              </ul>
              )}
              {side === 'back' ? (
                <button type="button" className="btn btn-ghost" onClick={cancelBack}>
                  先不拍背面
                </button>
              ) : existing ? (
                <button type="button" className="btn btn-ghost" onClick={() => setStep('info')}>
                  不换照片，返回
                </button>
              ) : null}
              {side === 'front' && canMatting && <ModelCard />}
            </div>
          )}

          {step === 'cutout' && work && (
            <div style={{ display: 'grid', gap: 12 }}>
              {work.bg.spread > 9 && !noRemoval && mode === 'color' && (
                <div className="warnbox">背景颜色不太均匀，按颜色去背可能不完整，建议改用「智能」方式。</div>
              )}
              <div className="cutout-view">
                <canvas
                  ref={canvasRef}
                  aria-label="去背预览，淡色部分会被去掉"
                  style={{ touchAction: tool === 'none' ? 'pan-y' : 'none', cursor: tool === 'none' ? 'default' : 'crosshair' }}
                  onPointerDown={(e: React.PointerEvent<HTMLCanvasElement>) => {
                    if (tool === 'none') return;
                    painting.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    paintAt(e);
                  }}
                  onPointerMove={(e: React.PointerEvent<HTMLCanvasElement>) => painting.current && paintAt(e)}
                  onPointerUp={endStroke}
                  onPointerCancel={endStroke}
                />
                {busy && <div className="busy">{busy}</div>}
              </div>
              {!noRemoval && mode === 'smart' && work.model && (
                <p className="small muted" role="status" style={{ margin: 0 }}>
                  {work.model === 'used'
                    ? '已用识别模型找出衣服，和背景颜色接近的边（白领口、白下摆）也会保留。'
                    : '照片里东西比较多，识别模型没认准，这次按颜色去背。把旁边的杂物挪开再拍会更准。'}
                </p>
              )}
              <Switch label="不去背，保留原图" checked={noRemoval} onChange={setNoRemoval} hint="背景太杂时可以先保留原图，换装时会显示为矩形照片" />
              {!noRemoval && edgeContact && edgeContact.sides.length > 0 && (
                <div className="warnbox" role="status">
                  {frameContactText(edgeContact.sides)}，碰到边缘的部分会被当成背景去掉，下摆或袖口可能缺了一块。往后退一点，让衣服四周都露出背景，再点「重拍」。
                </div>
              )}
              {!noRemoval && lowContrast && (
                <div className="warnbox">
                  衣服上有和背景很接近的颜色。{gapsFound ? '中间被挖掉的已经按衣服形状补回来了；' : ''}边上的（领口、袖口、白鞋底）如果被去掉了，选「恢复」沿着它涂一笔。下次换深色背景拍会准很多。
                </div>
              )}
              {!noRemoval && gapsFound && (
                <Switch
                  label="补回和背景同色的部分"
                  checked={fillGaps}
                  onChange={setFillGaps}
                  hint="白底上的白色印花、白条纹会被当成背景挖掉，已经按衣服的形状补回来。如果补上的地方其实是镂空（比如包带中间），关掉。"
                />
              )}
              {!noRemoval && hanger?.found && (
                <Switch
                  label="去掉衣架"
                  checked={!keepHanger}
                  onChange={(v) => setKeepHanger(!v)}
                  hint="照片里有衣架，领口上方的挂钩和伸出肩膀外的横杆已经自动去掉。如果去掉的其实是衣服本身（比如挂脖带子），关掉就会保留。"
                />
              )}
              {!noRemoval && (
                <>
                  <Field label="去背方式">
                    <Segmented<CutMode> options={['smart', 'color']} value={mode} labels={{ smart: '智能', color: '按颜色' }} onChange={chooseMode} />
                    <span className="field-hint">
                      {mode === 'smart'
                        ? '自动找出衣物边缘，背景有花纹、地板缝也能处理。'
                        : '从照片四周按背景色往里去掉，适合纯色背景，速度更快。'}
                    </span>
                  </Field>
                  {mode === 'color' && (
                    <Field label="去背灵敏度" hint={`${threshold}`}>
                      <input
                        type="range"
                        min={6}
                        max={60}
                        value={threshold}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setThreshold(Number(e.target.value))}
                        aria-label="去背灵敏度，越大去掉的越多"
                      />
                      <span className="field-hint">衣物被去掉一部分时调小，背景残留时调大。</span>
                    </Field>
                  )}
                  <Field label="手动修整" hint={tool === 'none' ? '' : '在图上涂抹'}>
                    <div className="row row-wrap">
                      <div className="segmented">
                        {(['none', 'erase', 'restore'] as Tool[]).map((t) => (
                          <button key={t} type="button" aria-pressed={tool === t} onClick={() => setTool(t)}>
                            {t === 'none' ? '查看' : t === 'erase' ? '擦除' : '恢复'}
                          </button>
                        ))}
                      </div>
                      <button type="button" className="btn btn-small btn-ghost" onClick={resetManual}>
                        清除涂抹
                      </button>
                    </div>
                    {tool !== 'none' && (
                      <input
                        type="range"
                        min={6}
                        max={48}
                        value={brush}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrush(Number(e.target.value))}
                        aria-label="笔刷大小"
                      />
                    )}
                    <span className="field-hint">
                      {mode === 'smart'
                        ? '不用涂满：在残留的背景上划一笔「擦除」，或在缺掉的衣物上划一笔「恢复」，松手后会自动贴合边缘。'
                        : '擦除和恢复只改涂到的地方。'}
                    </span>
                  </Field>
                </>
              )}
              <div className="row">
                <button type="button" className="btn" onClick={() => setStep('photo')}>
                  重拍
                </button>
                <button type="button" className="btn btn-primary grow" disabled={!!busy} onClick={finishCutout}>
                  下一步
                </button>
              </div>
            </div>
          )}

          {step === 'info' && (
            <div>
              {isPending && (
                <div className="warnbox" style={{ marginBottom: 12 }}>
                  这件是批量录入的，还没确认。{existing?.reviewNote ? `${existing.reviewNote}。` : ''}改好后点「确认」，才会参与推荐。
                </div>
              )}
              <div className="row" style={{ alignItems: 'flex-start', gap: 14, marginBottom: 6 }}>
                <div style={{ width: 104, flex: 'none', display: 'grid', gap: 6 }}>
                  <div style={{ height: 128 }}>
                    {preview ? (
                      <div className="thumb fill">
                        <img src={preview} alt="换装贴图" />
                      </div>
                    ) : existing ? (
                      <ItemThumb item={existing} className="fill" />
                    ) : null}
                  </div>
                  {prepared && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setPrepared((p) => (p ? { ...p, turns: (p.turns + 1) % 4 } : p))}
                    >
                      <Icon name="refresh" />
                      转 90°
                    </button>
                  )}
                </div>
                <div className="grow" style={{ display: 'grid', gap: 8 }}>
                  <label className="small muted" htmlFor="item-name">
                    名称
                  </label>
                  <input
                    id="item-name"
                    className="input"
                    value={draft.name}
                    placeholder="例如：白色衬衫"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ name: e.target.value, nameTouched: true })}
                  />
                  {existing && (
                    <div className="small muted">
                      {stats ? `穿过 ${stats.count} 次，最近一次 ${stats.last}` : '还没有穿着记录'}
                    </div>
                  )}
                  {existing && (
                    <div className="row row-wrap">
                      <button type="button" className="btn btn-small" onClick={() => setStep('photo')}>
                        <Icon name="camera" />
                        重新拍照
                      </button>
                      {existing.images.original && !db.isVirtualImage(existing.images.original) && (
                        <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => void recutFromOriginal()}>
                          <Icon name="refresh" />
                          用原图重新去背
                        </button>
                      )}
                      {existing.status === 'active' && (
                        <button type="button" className="btn btn-small" onClick={() => ui.open({ kind: 'match', itemId: existing.id })}>
                          <Icon name="sparkle" />
                          这件怎么搭
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <section className="back-card" aria-label="背面照片">
                <div className="back-thumb">
                  {backPreview ? (
                    <div className="thumb fill">
                      <img src={backPreview} alt="背面" />
                    </div>
                  ) : backThumbId ? (
                    <BackThumb id={backThumbId} />
                  ) : (
                    <div className="thumb fill back-empty" aria-hidden="true">
                      <Icon name="camera" />
                    </div>
                  )}
                </div>
                <div className="grow">
                  <strong>背面</strong>
                  <p className="small muted">
                    {backPreview || backThumbId
                      ? backPreview
                        ? '新拍的背面，保存后生效。'
                        : '人台转到背面和 3D 展示时使用。'
                      : removeBack
                        ? '背面照片会在保存后删除。'
                        : '可选。拍了背面，人台转到身后和 3D 展示会更真实。'}
                  </p>
                  <div className="row row-wrap">
                    <button type="button" className="btn btn-small" disabled={!!busy} onClick={startBack}>
                      <Icon name="camera" />
                      {backPreview || backThumbId ? '换一张背面' : '拍背面'}
                    </button>
                    {preparedBack && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setPreparedBack((p) => (p ? { ...p, turns: (p.turns + 1) % 4 } : p))}
                      >
                        转 90°
                      </button>
                    )}
                    {(backPreview || backThumbId) && (
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() => {
                          setPreparedBack(null);
                          if (existing?.images.backCutout) setRemoveBack(true);
                        }}
                      >
                        去掉背面
                      </button>
                    )}
                    {removeBack && !backPreview && (
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setRemoveBack(false)}>
                        撤销
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <section className="tag-card" aria-label="品牌和尺码">
                <div className="tag-card-head">
                  <Icon name="tag" />
                  <strong>品牌和尺码</strong>
                  <span className="field-hint">可选，照着吊牌填</span>
                </div>
                <div className="tag-fields">
                  <label>
                    品牌
                    <input className="input" id="item-brand" value={draft.brand} placeholder="例如：优衣库" onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ brand: e.target.value })} />
                  </label>
                  <label>
                    货号
                    <input className="input" id="item-style-no" value={draft.styleNo} placeholder="吊牌上的货号" onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ styleNo: e.target.value })} />
                  </label>
                  <label>
                    尺码 / 号型
                    <input className="input" id="item-size" value={draft.size} placeholder="例如：M 170/92A" onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ size: e.target.value })} />
                  </label>
                  <label className="tag-field-wide">
                    成分 / 材质
                    <input className="input" id="item-material" value={draft.material} placeholder="例如：棉 95%，氨纶 5%" onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ material: e.target.value })} />
                  </label>
                </div>
              </section>

              <Field label="类别" hint={draft.categoryGuessed ? '按衣服轮廓猜的，不对就点一下改' : undefined}>
                <ChipSelect<Category> options={CATEGORIES} value={cat} labels={CATEGORY_LABELS} onChange={chooseCategory} allowEmpty={false} />
              </Field>
              {cat && (
                <Field
                  label="子类"
                  hint={draft.subtype ? (draft.categoryGuessed ? '按轮廓猜的，已按它填好常用选项，可以修改' : '已按子类填好常用选项，可以修改') : undefined}
                >
                  <ChipSelect<string>
                    options={subtypesOf(cat)}
                    value={draft.subtype}
                    labels={{}}
                    onChange={chooseSubtype}
                    allowEmpty={false}
                  />
                </Field>
              )}
              {hoodFrac > 0 && (cat === 'top' || cat === 'outer') && (
                <div className="field">
                  <Switch
                    label="试穿时把帽子放下"
                    checked={!draft.hoodUp}
                    onChange={(v) => set({ hoodUp: !v })}
                    hint={
                      draft.hoodUp
                        ? '人台上会显示照片里摊开的帽子。'
                        : '照片里摊开的帽子在人台上藏起来，衣服按肩线对齐。认错了（例如是高领、立领）就关掉。'
                    }
                  />
                </div>
              )}

              <Field label="颜色" hint={prepared?.colors ? '从照片自动识别' : undefined}>
                <div className="color-current">
                  {draft.color ? (
                    <>
                      <span className="swatch" style={{ background: draft.color.hex }} />
                      <span>{draft.color.name}</span>
                    </>
                  ) : (
                    <span className="muted">未选择</span>
                  )}
                  {draft.color2 && (
                    <>
                      <span className="swatch" style={{ background: draft.color2.hex, marginLeft: 10 }} />
                      <span>{draft.color2.name}</span>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => set({ color2: undefined })} aria-label="去掉第二颜色">
                        <Icon name="close" />
                      </button>
                    </>
                  )}
                  <button type="button" className="btn btn-small" style={{ marginLeft: 'auto' }} onClick={() => setShowPalette((v) => !v)}>
                    {showPalette ? '收起' : '修改'}
                  </button>
                </div>
                {showPalette && (
                  <div className="palette">
                    {PALETTE.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        aria-pressed={draft.color?.name === p.name}
                        onClick={() => {
                          setDraft((d) => ({
                            ...d,
                            color: { hex: p.hex, name: p.name },
                            name: d.nameTouched ? d.name : autoName(p.name, d.subtype),
                          }));
                          setShowPalette(false);
                        }}
                      >
                        <span className="swatch" style={{ background: p.hex }} />
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </Field>

              <Field label="花纹" hint={draft.color2 && draft.pattern === 'solid' ? '识别到两种颜色，如果是条纹或格纹请选择' : undefined}>
                <ChipSelect<Pattern>
                  options={['solid', 'stripe', 'check', 'print', 'colorblock']}
                  value={draft.pattern}
                  labels={PATTERN_LABELS}
                  onChange={(v) => v && set({ pattern: v })}
                  allowEmpty={false}
                />
              </Field>

              <Field label="保暖度">
                <Segmented<Warmth> options={[1, 2, 3]} value={draft.warmth} labels={WARMTH_LABELS} onChange={(v) => set({ warmth: v })} />
              </Field>

              {cat === 'outer' && (
                <div className="field">
                  <Switch
                    label="照片里是敞开的"
                    checked={draft.photoOpen}
                    onChange={(v) => set({ photoOpen: v })}
                    hint="拍的时候没拉拉链、没扣扣子。人台上会一直敞开显示，中间露出的里衬可以在去背时用「擦除」去掉。"
                  />
                  {!draft.photoOpen && (
                    <Switch
                      label="可以敞开穿"
                      checked={draft.openable ?? defaultOpenable('outer', draft.subtype ?? '')}
                      onChange={(v) => set({ openable: v })}
                      hint="有拉链或纽扣的外套。搭配时可以选「外套敞开」，人台上会把门襟拉开。"
                    />
                  )}
                </div>
              )}

              {app?.fit && (
                <Field label="版型" hint={draft.size.trim() ? '你穿上的效果' : undefined}>
                  <Segmented<Fit> options={['slim', 'regular', 'loose']} value={draft.fit} labels={FIT_LABELS} onChange={(v) => set({ fit: v })} />
                  {sizeFit && (
                    <div className="fit-analysis">
                      <NoteList notes={sizeFit.notes} />
                      {sizeFit.effectiveFit && sizeFit.effectiveFit !== draft.fit && (
                        <button type="button" className="btn btn-small" onClick={() => set({ fit: sizeFit.effectiveFit })}>
                          版型改为{FIT_LABELS[sizeFit.effectiveFit]}
                        </button>
                      )}
                    </div>
                  )}
                </Field>
              )}
              {app?.length && cat && (
                <Field label="长度">
                  <Segmented<Length>
                    options={['short', 'regular', 'long']}
                    value={draft.length}
                    labels={lengthLabels(cat, draft.subtype ?? undefined)}
                    onChange={(v) => set({ length: v })}
                  />
                </Field>
              )}
              {app?.rise && (
                <Field label={cat === 'dress' ? '腰线' : '裤腰/裙腰'}>
                  <Segmented<Rise> options={['high', 'mid', 'low']} value={draft.rise} labels={RISE_LABELS} onChange={(v) => set({ rise: v })} />
                </Field>
              )}
              {cat && draft.color && (previewId || existing) && (
                <SizePreview
                  item={{
                    ...(existing ?? EMPTY_ITEM),
                    category: cat,
                    subtype: draft.subtype ?? '',
                    color: draft.color,
                    fit: app?.fit ? draft.fit : undefined,
                    length: app?.length ? draft.length : undefined,
                    rise: app?.rise ? draft.rise : undefined,
                    images: previewId ? { cutout: previewId, thumb: previewId } : existing!.images,
                    imageAspect: composed ? composed.aspect : existing!.imageAspect,
                    hoodTop: hoodMeasured,
                    hoodUp: draft.hoodUp,
                    shape,
                    sizeAdjust: draft.sizeAdjust,
                    photoOpen: draft.photoOpen,
                  }}
                  value={draft.sizeAdjust}
                  onChange={(v) => set({ sizeAdjust: v })}
                />
              )}

              <Field label="季节">
                <ChipMulti<Season> options={SEASONS} value={draft.seasons} labels={SEASON_LABELS} onChange={(v) => set({ seasons: v })} />
              </Field>
              <Field label="场合">
                <ChipMulti<Occasion> options={OCCASIONS} value={draft.occasions} labels={OCCASION_LABELS} onChange={(v) => set({ occasions: v })} />
              </Field>
              <Field label="风格">
                <ChipMulti<Style> options={STYLES} value={draft.styles} labels={STYLE_LABELS} onChange={(v) => set({ styles: v })} />
              </Field>

              <div className="field">
                <button type="button" className="btn btn-ghost btn-small" style={{ justifySelf: 'start', paddingLeft: 0 }} onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
                  {showMore ? '收起标签' : '自定义标签'}
                </button>
                {showMore && (
                  <input className="input" placeholder="标签，用逗号分隔，例如：面试、旅行" value={draft.tags} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ tags: e.target.value })} aria-label="标签" />
                )}
              </div>

              <div className="field">
                <Switch label="收藏" checked={draft.favorite} onChange={(v) => set({ favorite: v })} hint="收藏的单品在推荐中略微优先" />
              </div>

              <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={!!busy} onClick={save}>
                {busy ?? '保存'}
              </button>
              {existing && (
                <div className="row" style={{ marginTop: 10 }}>
                  {!isPending && (
                    <button type="button" className="btn grow" onClick={toggleArchive}>
                      {existing.status === 'active' ? '归档' : '恢复到衣橱'}
                    </button>
                  )}
                  <button type="button" className="btn btn-danger grow" onClick={remove}>
                    删除
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BackThumb({ id }: { id: string }) {
  const url = useImageUrl(id);
  return <div className="thumb fill">{url ? <img src={url} alt="背面" /> : null}</div>;
}

const EMPTY_ITEM: Item = {
  id: 'preview',
  name: '',
  category: 'top',
  subtype: '',
  color: { hex: '#888888', name: '灰色' },
  pattern: 'solid',
  seasons: [],
  warmth: 2,
  occasions: [],
  styles: [],
  tags: [],
  favorite: false,
  status: 'active',
  images: { cutout: '', thumb: '' },
  imageAspect: 1,
  createdAt: 0,
  updatedAt: 0,
};

/** 人台上的大小：默认按身材和版型定，这里可以再调大调小，调好后试搭、推荐、3D 都按这个大小 */
function SizePreview({ item, value, onChange }: { item: Item; value: number; onChange: (v: number) => void }) {
  const store = useStore();
  const pct = Math.round(value * 100);
  const step = (d: number) => onChange(Math.max(0.7, Math.min(1.4, Math.round((value + d) * 100) / 100)));
  return (
    <section className="size-preview" aria-label="人台上的大小">
      <div className="stage size-preview-stage">
        <Mannequin body={store.settings.body} items={[item]} label="人台预览" />
      </div>
      <div className="size-preview-side">
        <strong>人台上的大小</strong>
        <p className="small muted">
          {item.shape
            ? '已按你的身材和版型自动定好，和拍照远近、袖子摊开多少无关。'
            : '按类别和长度摆放。'}
          不合适可以在这里调，试搭和推荐都会用这个大小。
        </p>
        <div className="row">
          <button type="button" className="btn btn-small" aria-label="小一点" onClick={() => step(-0.04)} disabled={value <= 0.7}>
            小一点
          </button>
          <span className="size-preview-value" aria-live="polite">
            {pct}%
          </span>
          <button type="button" className="btn btn-small" aria-label="大一点" onClick={() => step(0.04)} disabled={value >= 1.4}>
            大一点
          </button>
        </div>
        {pct !== 100 && (
          <button type="button" className="btn btn-small btn-ghost" style={{ justifySelf: 'start', paddingLeft: 0 }} onClick={() => onChange(1)}>
            恢复默认大小
          </button>
        )}
      </div>
    </section>
  );
}

/** 识别模型：第一次用时下载（约 56MB），之后自动从本机读取 */
function ModelCard() {
  const m = useMatting();
  if (m.status === 'unsupported') return null;
  if (m.status === 'ready') {
    return (
      <p className="small muted model-card-ready" role="status">
        识别模型已准备好：白色、带白边的衣服在白底上也能认出来，照片只在本机处理。
      </p>
    );
  }
  return (
    <section className="model-card" aria-label="识别模型">
      <strong>白衣服、白边认得更准</strong>
      {m.status === 'downloading' || m.status === 'preparing' ? (
        <>
          <p className="small muted">
            {m.status === 'downloading' ? `正在下载识别模型 ${Math.round(m.progress * 100)}%` : '正在准备识别模型…'}
            ，下载完成前照常按颜色去背。
          </p>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.progress * 100)}>
            <span style={{ width: `${Math.round(m.progress * 100)}%` }} />
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            下载一个开源的识别模型（约 {MODEL_SIZE_MB}MB，只需一次，建议连 Wi-Fi）。它在手机上直接识别照片里的衣服，照片不上传，不收费。
            {m.status === 'error' ? ` 上次没成功：${m.error}。` : ''}
          </p>
          <button type="button" className="btn btn-small" onClick={() => void prepareMatting(true)}>
            {m.status === 'error' ? '重新下载' : '下载识别模型'}
          </button>
        </>
      )}
    </section>
  );
}
