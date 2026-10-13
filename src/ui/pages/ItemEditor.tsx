// 录入与编辑单品：拍照 → 本地去背（可手动擦除/恢复）→ 自动取色 → 点选字段。
// 正面必拍，背面可选：背面照片走同样的去背流程，用于人台背面和 3D 展示。

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { detectHanger, removeMasked } from '../../core/hanger';
import { smartCut } from '../../core/smartcut';
import { defaultOpenable } from '../../core/styling';
import { analyzeSizeFit } from '../../core/sizefit';
import { wearStats } from '../../core/stats';
import { hasUsefulInfo, parseTagText, type TagParse } from '../../core/tag';
import { isHosted } from '../../storage/hosted';
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
import { OCR_STAGE_TEXT, recognizeTagImage } from '../ocr';
import { newId, useImageUrl, useStore, type NewImage } from '../store';
import { useUI } from '../ui';

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
}

function hasStrokes(o: Uint8Array): boolean {
  for (let i = 0; i < o.length; i++) if (o[i]) return true;
  return false;
}

interface Prepared {
  cutout: HTMLCanvasElement;
  archive: HTMLCanvasElement;
  aspect: number;
  colors: ColorSuggestion | null;
}

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
}

interface TagState {
  parse: TagParse;
  source: 'ocr' | 'paste';
  text: string;
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

const TAG_SOURCE_TEXT: Record<NonNullable<TagParse['subtypeSource']>, string> = {
  name: '来自品名',
  standard: '来自执行标准',
  keyword: '来自吊牌文字',
};

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
  const [tagState, setTagState] = useState<TagState | null>(null);
  const [tagApplied, setTagApplied] = useState<string[] | null>(null);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState(existing?.tagInfo?.raw ?? '');
  const tagCameraRef = useRef<HTMLInputElement>(null);
  const tagAlbumRef = useRef<HTMLInputElement>(null);
  // claude.ai 发布页面里不能联网下载识别组件，只提供粘贴文字
  const canOcr = !isHosted();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const painting = useRef(false);
  const frame = useRef(0);
  const preview = useMemo(() => (prepared ? prepared.cutout.toDataURL() : null), [prepared]);
  const backPreview = useMemo(() => (preparedBack ? preparedBack.cutout.toDataURL() : null), [preparedBack]);
  const hasExistingBack = !!existing?.images.backCutout && !removeBack;
  const stats = existing ? wearStats(store.records).get(existing.id) : undefined;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // ---------- 照片与去背 ----------

  async function onFile(file: File | undefined) {
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
      const smart = mode === 'smart' ? smartCut(photo.rgba, { init: res.alpha }) : null;
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
      });
      setNoRemoval((smart ?? res).coverage > 0.97);
      setKeepHanger(false);
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
      const r = smartCut(w.rgba, { init: w.colorAuto, strokes: hasStrokes(w.override) ? w.override : undefined });
      setWork({ ...w, auto: r.alpha });
    } finally {
      setBusy(null);
    }
  }

  function chooseMode(m: CutMode) {
    setMode(m);
    if (work) void recompute(work, m);
  }

  // 挂着拍的衣服：自动去背后衣架常和衣服连在一起，找出挂钩和伸出肩外的横杆
  const workAuto = work?.auto;
  const hanger = useMemo(() => (work && workAuto ? detectHanger(workAuto, work.rgba) : null), [workAuto]);

  const currentAlpha = (w: Work) => {
    if (noRemoval) return new Uint8Array(w.auto.length).fill(255);
    // 先去掉衣架，再叠加手动笔刷（"恢复"笔刷涂到的地方以笔刷为准）
    const auto = hanger?.found && !keepHanger ? removeMasked(w.auto, hanger.mask) : w.auto;
    return combineMask(auto, w.override);
  };

  useEffect(() => {
    if (step !== 'cutout' || !work || !canvasRef.current) return;
    renderMaskPreview(canvasRef.current, work.rgba, currentAlpha(work));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, work, noRemoval, hanger, keepHanger]);

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
      const cutoutCanvas = scaleCanvas(rgbaToCanvas(cropped), 640);
      if (side === 'back') {
        setPreparedBack({ cutout: cutoutCanvas, archive: work.archive, aspect: cropped.width / cropped.height, colors: null });
        setRemoveBack(false);
        setSide('front');
        setStep('info');
        ui.toast('背面已加上，保存后生效');
        return;
      }
      const colors = suggestColors(extractColors(cropped.data, 4));
      const cutout = cutoutCanvas;
      setPrepared({ cutout, archive: work.archive, aspect: cropped.width / cropped.height, colors });
      if (colors) {
        setDraft((d) => {
          const color = { hex: colors.primary.hex, name: colors.primary.name };
          const color2 = colors.multiColor && colors.secondary ? { ...colors.secondary } : undefined;
          return {
            ...d,
            color,
            color2,
            name: d.nameTouched ? d.name : autoName(color.name, d.subtype),
          };
        });
      }
      setStep('info');
    } finally {
      setBusy(null);
    }
  }

  // ---------- 字段 ----------

  function autoName(colorName: string | undefined, subtype: string | null): string {
    if (!subtype) return colorName ?? '';
    return `${colorName ?? ''}${subtype}`;
  }

  function chooseCategory(c: Category | null) {
    if (!c) return;
    setDraft((d) => ({
      ...d,
      category: c,
      subtype: null,
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
      return { ...next, name: d.nameTouched ? d.name : autoName(d.color?.name, s) };
    });
  }

  // ---------- 吊牌识别 ----------

  function baseFitOf(d: Draft): Fit | undefined {
    if (d.tagFit) return d.tagFit;
    return d.category && d.subtype ? defaultsFor(d.category, d.subtype)?.fit : undefined;
  }

  function handleTagText(text: string, source: 'ocr' | 'paste') {
    setPasteText(text);
    const parse = parseTagText(text);
    setTagApplied(null);
    if (!hasUsefulInfo(parse)) {
      setTagState(null);
      setShowPaste(true);
      ui.toast(source === 'ocr' ? '没有从照片里认出吊牌信息，可以拍近一点、拍正一点再试，或者粘贴文字' : '没有认出品牌、号型、成分这类信息');
      return;
    }
    setTagState({ parse, source, text });
  }

  async function onTagFile(file: File | undefined) {
    if (!file) return;
    setOcrStatus(OCR_STAGE_TEXT.download);
    try {
      const text = await recognizeTagImage(file, (stage, pct) =>
        setOcrStatus(stage === 'recognize' ? `${OCR_STAGE_TEXT.recognize} ${pct}%` : OCR_STAGE_TEXT[stage]),
      );
      handleTagText(text, 'ocr');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '识别失败，可以改用粘贴文字');
      setShowPaste(true);
    } finally {
      setOcrStatus(null);
      if (tagCameraRef.current) tagCameraRef.current.value = '';
      if (tagAlbumRef.current) tagAlbumRef.current.value = '';
    }
  }

  function applyTag() {
    if (!tagState) return;
    const { parse: p, source, text } = tagState;
    let next: Draft = { ...draft };
    const applied: string[] = [];
    if (p.brand) {
      next.brand = p.brand;
      applied.push('品牌');
    }
    if (p.styleNo) {
      next.styleNo = p.styleNo;
      applied.push('货号');
    }
    const sizeText = [p.size && p.size !== p.sizeCode ? p.size : '', p.sizeCode ?? ''].filter(Boolean).join(' ');
    if (sizeText) {
      next.size = sizeText;
      applied.push(p.sizeCode ? '号型' : '尺码');
    }
    if (p.materialText) {
      next.material = p.materialText;
      applied.push('成分');
    }
    if (p.category && (!next.category || (next.category === p.category && !next.subtype))) {
      next = withSubtype(next, p.category, p.subtype);
      applied.push('类别');
    }
    next.tagRaw = text;
    next.tagSource = source;
    next.tagStandard = p.standards.find((s) => s.category || s.label)?.code ?? p.standards[0]?.code;
    next.tagFit = p.fit;
    const cat = next.category;
    if (cat) {
      const app = FIELD_APPLICABILITY[cat];
      if (app.length && p.length) {
        next.length = p.length;
        applied.push('长度');
      }
      if (app.rise && p.rise) {
        next.rise = p.rise;
        applied.push('腰线');
      }
      if (app.fit) {
        const r = analyzeSizeFit({ category: cat, subtype: next.subtype ?? undefined, fit: baseFitOf(next), size: next.size }, store.settings.body);
        const fit = r?.effectiveFit ?? p.fit;
        if (fit) {
          next.fit = fit;
          applied.push(r?.effectiveFit && r.effectiveFit !== p.fit ? '版型（按你的身材换算）' : '版型');
        }
      }
    }
    if (p.warmthHint) {
      next.warmth = p.warmthHint;
      applied.push('保暖度');
    }
    next.name = draft.nameTouched ? draft.name : autoName(next.color?.name, next.subtype);
    setDraft(next);
    setTagApplied(applied);
    setTagState(null);
    setShowPaste(false);
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
      if (prepared) {
        const cutoutId = newId('img-');
        const thumbId = newId('img-');
        const originalId = newId('img-');
        const thumb = scaleCanvas(prepared.cutout, 280);
        images.push({ id: cutoutId, blob: await transparentBlob(prepared.cutout), width: prepared.cutout.width, height: prepared.cutout.height });
        images.push({ id: thumbId, blob: await transparentBlob(thumb), width: thumb.width, height: thumb.height });
        images.push({ id: originalId, blob: await canvasToBlob(prepared.archive, 'image/jpeg', 0.85), width: prepared.archive.width, height: prepared.archive.height });
        if (existing) replaced.push(existing.images.cutout, existing.images.thumb, ...(existing.images.original ? [existing.images.original] : []));
        // 只换正面时保留原来的背面
        imageRefs = { ...imageRefs, cutout: cutoutId, thumb: thumbId, original: originalId };
        aspect = prepared.aspect;
      }
      let backAspect = existing?.backAspect;
      if (preparedBack) {
        const cutoutId = newId('img-');
        const thumbId = newId('img-');
        const originalId = newId('img-');
        const thumb = scaleCanvas(preparedBack.cutout, 280);
        images.push({ id: cutoutId, blob: await transparentBlob(preparedBack.cutout), width: preparedBack.cutout.width, height: preparedBack.cutout.height });
        images.push({ id: thumbId, blob: await transparentBlob(thumb), width: thumb.width, height: thumb.height });
        images.push({ id: originalId, blob: await canvasToBlob(preparedBack.archive, 'image/jpeg', 0.85), width: preparedBack.archive.width, height: preparedBack.archive.height });
        if (existing) replaced.push(...backImageIds(existing));
        imageRefs = { ...imageRefs!, backCutout: cutoutId, backThumb: thumbId, backOriginal: originalId };
        backAspect = preparedBack.aspect;
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
        status: existing?.status ?? 'active',
        images: imageRefs!,
        imageAspect: aspect,
        backAspect: imageRefs!.backCutout ? backAspect : undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        demo: existing?.demo && !prepared && !preparedBack && !removeBack ? existing.demo : undefined,
      };
      await store.saveItem(item, images, replaced);
      if (existing) {
        ui.toast('已保存');
        ui.close();
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
    ui.close();
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
    ui.close();
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
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>{isNew ? '录入单品' : existing.name}</h1>
          {step === 'info' ? (
            <button type="button" className="btn btn-primary btn-small" disabled={!!busy} onClick={save}>
              保存
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
                <li>衣物平铺，完整入镜，四周留一点空白。</li>
                <li>深色衣物配浅色背景，浅色衣物配深色背景，背景越纯越好（床单、地板、纸板都可以）。</li>
                <li>光线均匀，避免强烈阴影和反光。</li>
                <li>上衣和外套尽量把袖子摆开，换装时更像穿在身上。</li>
                <li>挂在衣架上拍也可以，挂钩和横杆会自动去掉。</li>
                <li>外套拉好拉链拍，搭配时可以选择敞开或合上；没拉拉链拍的，录入时打开「照片里是敞开的」。</li>
              </ul>
              )}
              {side === 'back' ? (
                <button type="button" className="btn btn-ghost" onClick={cancelBack}>
                  先不拍背面
                </button>
              ) : existing && (
                <button type="button" className="btn btn-ghost" onClick={() => setStep('info')}>
                  不换照片，返回
                </button>
              )}
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
              <Switch label="不去背，保留原图" checked={noRemoval} onChange={setNoRemoval} hint="背景太杂时可以先保留原图，换装时会显示为矩形照片" />
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
              <div className="row" style={{ alignItems: 'flex-start', gap: 14, marginBottom: 6 }}>
                <div style={{ width: 104, height: 128, flex: 'none' }}>
                  {preview ? (
                    <div className="thumb fill">
                      <img src={preview} alt="" />
                    </div>
                  ) : existing ? (
                    <ItemThumb item={existing} className="fill" />
                  ) : null}
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

              <section className="tag-card" aria-label="吊牌信息">
                <div className="tag-card-head">
                  <Icon name="tag" />
                  <strong>吊牌信息</strong>
                  <span className="field-hint">可选，比照片估计更准</span>
                </div>
                <p className="small muted">
                  拍吊牌或洗标，自动读出品牌、货号、号型、成分和版型字样{store.settings.body ? '，并和你的身材对比' : ''}。
                </p>
                <div className="row row-wrap">
                  {canOcr && (
                    <>
                      <button type="button" className="btn btn-small" disabled={!!ocrStatus} onClick={() => tagCameraRef.current?.click()}>
                        <Icon name="camera" />
                        拍吊牌
                      </button>
                      <button type="button" className="btn btn-small" disabled={!!ocrStatus} onClick={() => tagAlbumRef.current?.click()}>
                        <Icon name="image" />
                        相册里的吊牌
                      </button>
                    </>
                  )}
                  <button type="button" className="btn btn-small" aria-expanded={showPaste} onClick={() => setShowPaste((v) => !v)}>
                    {showPaste ? '收起文字' : pasteText ? '查看识别的文字' : '粘贴文字'}
                  </button>
                </div>
                <input ref={tagCameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e: React.ChangeEvent<HTMLInputElement>) => onTagFile(e.target.files?.[0])} />
                <input ref={tagAlbumRef} type="file" accept="image/*" hidden data-testid="tag-input" onChange={(e: React.ChangeEvent<HTMLInputElement>) => onTagFile(e.target.files?.[0])} />
                {ocrStatus && (
                  <p className="small tag-progress" role="status">
                    {ocrStatus}
                  </p>
                )}
                {showPaste && (
                  <div className="tag-paste">
                    <textarea
                      id="tag-text"
                      className="input"
                      rows={5}
                      value={pasteText}
                      placeholder={'例如：\n品牌：优衣库\n号型：170/92A\n面料：棉 100%'}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasteText(e.target.value)}
                      aria-label="吊牌文字"
                    />
                    <span className="field-hint">
                      iPhone：用相机对准吊牌，点右下角的文字图标，选「拷贝全部」，再粘贴到这里。识别有错字可以直接改。
                    </span>
                    <button type="button" className="btn btn-small" disabled={!pasteText.trim()} onClick={() => handleTagText(pasteText, tagState?.source === 'ocr' ? 'ocr' : 'paste')}>
                      读取这段文字
                    </button>
                  </div>
                )}
                {tagState && (
                  <div className="tag-result" aria-label="识别结果">
                    <dl>
                      {tagState.parse.brand && (
                        <>
                          <dt>品牌</dt>
                          <dd>{tagState.parse.brand}</dd>
                        </>
                      )}
                      {tagState.parse.styleNo && (
                        <>
                          <dt>货号</dt>
                          <dd>{tagState.parse.styleNo}</dd>
                        </>
                      )}
                      {(tagState.parse.size || tagState.parse.sizeCode) && (
                        <>
                          <dt>{tagState.parse.sizeCode ? '号型' : '尺码'}</dt>
                          <dd>
                            {[tagState.parse.size !== tagState.parse.sizeCode ? tagState.parse.size : '', tagState.parse.sizeCode].filter(Boolean).join(' ')}
                          </dd>
                        </>
                      )}
                      {tagState.parse.materialText && (
                        <>
                          <dt>成分</dt>
                          <dd>
                            {tagState.parse.materialText}
                            {tagState.parse.stretch ? '（有弹性）' : ''}
                          </dd>
                        </>
                      )}
                      {tagState.parse.subtype && tagState.parse.category && (
                        <>
                          <dt>款式</dt>
                          <dd>
                            {tagState.parse.subtype}（{CATEGORY_LABELS[tagState.parse.category]}，{TAG_SOURCE_TEXT[tagState.parse.subtypeSource ?? 'keyword']}）
                            {cat && cat !== tagState.parse.category && (
                              <span className="tag-conflict">和你选的「{CATEGORY_LABELS[cat]}」不一样，填入时不会改动类别</span>
                            )}
                          </dd>
                        </>
                      )}
                      {tagState.parse.fit && (
                        <>
                          <dt>版型</dt>
                          <dd>
                            {FIT_LABELS[tagState.parse.fit]}（吊牌写着「{tagState.parse.fitWord}」）
                          </dd>
                        </>
                      )}
                      {tagState.parse.length && (
                        <>
                          <dt>长度</dt>
                          <dd>吊牌写着「{tagState.parse.lengthWord}」</dd>
                        </>
                      )}
                      {tagState.parse.rise && (
                        <>
                          <dt>腰线</dt>
                          <dd>{RISE_LABELS[tagState.parse.rise]}</dd>
                        </>
                      )}
                      {tagState.parse.warmthHint && (
                        <>
                          <dt>保暖度</dt>
                          <dd>
                            {WARMTH_LABELS[tagState.parse.warmthHint]}（{tagState.parse.warmthReason}）
                          </dd>
                        </>
                      )}
                      {tagState.parse.standards.filter((x) => x.label).map((x) => (
                        <Fragment key={x.code}>
                          <dt>执行标准</dt>
                          <dd>
                            {x.code}（{x.label}）
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                    <div className="row">
                      <button type="button" className="btn btn-primary btn-small grow" onClick={applyTag}>
                        填入这些信息
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setTagState(null)}>
                        不用了
                      </button>
                    </div>
                  </div>
                )}
                {tagApplied && tagApplied.length > 0 && (
                  <p className="small tag-applied" role="status">
                    已从吊牌填入：{tagApplied.join('、')}。可以在下面继续修改。
                  </p>
                )}
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

              <Field label="类别">
                <ChipSelect<Category> options={CATEGORIES} value={cat} labels={CATEGORY_LABELS} onChange={chooseCategory} allowEmpty={false} />
              </Field>
              {cat && (
                <Field label="子类" hint={draft.subtype ? '已按子类填好常用选项，可以修改' : undefined}>
                  <ChipSelect<string>
                    options={subtypesOf(cat)}
                    value={draft.subtype}
                    labels={{}}
                    onChange={chooseSubtype}
                    allowEmpty={false}
                  />
                </Field>
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
                  <button type="button" className="btn grow" onClick={toggleArchive}>
                    {existing.status === 'active' ? '归档' : '恢复到衣橱'}
                  </button>
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
