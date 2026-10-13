// 录入与编辑单品：拍照 → 本地去背（可手动擦除/恢复）→ 自动取色 → 点选字段。

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
import { wearStats } from '../../core/stats';
import type { Category, ColorInfo, Fit, Item, Length, Occasion, Pattern, Rise, Season, Style, Warmth } from '../../core/types';
import { ChipMulti, ChipSelect, Field, Segmented, Switch } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ItemThumb } from '../components/Bits';
import {
  canvasToBlob,
  loadPhoto,
  renderMaskPreview,
  rgbaToCanvas,
  scaleCanvas,
  transparentBlob,
} from '../imageTools';
import { newId, useStore, type NewImage } from '../store';
import { useUI } from '../ui';

type Step = 'photo' | 'cutout' | 'info';
type Tool = 'none' | 'erase' | 'restore';

interface Work {
  rgba: RGBAImage;
  archive: HTMLCanvasElement;
  lab: Float32Array;
  bg: BackgroundEstimate;
  auto: Uint8Array;
  override: Uint8Array;
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
  tags: string;
  favorite: boolean;
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
    tags: i.tags.join('，'),
    favorite: i.favorite,
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
  tags: '',
  favorite: false,
};

export function ItemEditor({ id }: { id: string | null }) {
  const store = useStore();
  const ui = useUI();
  const existing = id ? store.items.find((i) => i.id === id) ?? null : null;
  const [step, setStep] = useState<Step>(existing ? 'info' : 'photo');
  const [work, setWork] = useState<Work | null>(null);
  const [threshold, setThreshold] = useState(20);
  const [tool, setTool] = useState<Tool>('none');
  const [brush, setBrush] = useState(18);
  const [noRemoval, setNoRemoval] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [draft, setDraft] = useState<Draft>(existing ? draftFromItem(existing) : EMPTY_DRAFT);
  const [showPalette, setShowPalette] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const painting = useRef(false);
  const frame = useRef(0);
  const preview = useMemo(() => (prepared ? prepared.cutout.toDataURL() : null), [prepared]);
  const stats = existing ? wearStats(store.records).get(existing.id) : undefined;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // ---------- 照片与去背 ----------

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy('正在读取照片…');
    try {
      const photo = await loadPhoto(file);
      await new Promise((r) => setTimeout(r, 20));
      setBusy('正在去除背景…');
      await new Promise((r) => setTimeout(r, 20));
      const lab = toLabBuffer(photo.rgba);
      const bg = estimateBackground(photo.rgba, lab);
      const t = suggestThreshold(bg);
      const res = removeBackground(photo.rgba, { threshold: t }, lab);
      setThreshold(t);
      setWork({
        rgba: photo.rgba,
        archive: photo.archive,
        lab,
        bg,
        auto: res.alpha,
        override: new Uint8Array(photo.rgba.width * photo.rgba.height),
      });
      setNoRemoval(res.coverage > 0.97);
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

  // 调整阈值后重新计算自动蒙版（稍作延迟，避免拖动滑块时卡顿）
  useEffect(() => {
    if (!work) return;
    const timer = window.setTimeout(() => {
      const res = removeBackground(work.rgba, { threshold }, work.lab);
      setWork((w) => (w ? { ...w, auto: res.alpha } : w));
    }, 140);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold]);

  const currentAlpha = (w: Work) => {
    if (noRemoval) return new Uint8Array(w.auto.length).fill(255);
    return combineMask(w.auto, w.override);
  };

  useEffect(() => {
    if (step !== 'cutout' || !work || !canvasRef.current) return;
    renderMaskPreview(canvasRef.current, work.rgba, currentAlpha(work));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, work, noRemoval]);

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
    setWork({ ...work });
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
      const colors = suggestColors(extractColors(cropped.data, 4));
      const cutout = scaleCanvas(rgbaToCanvas(cropped), 640);
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
    const def = defaultsFor(draft.category, s);
    const app = FIELD_APPLICABILITY[draft.category];
    setDraft((d) => ({
      ...d,
      subtype: s,
      ...(def
        ? {
            warmth: def.warmth,
            seasons: def.seasons,
            occasions: def.occasions,
            styles: def.styles,
            fit: app.fit ? def.fit ?? d.fit ?? 'regular' : undefined,
            length: app.length ? def.length ?? d.length ?? 'regular' : undefined,
            rise: app.rise ? def.rise ?? d.rise ?? 'mid' : undefined,
          }
        : {}),
      name: d.nameTouched ? d.name : autoName(d.color?.name, s),
    }));
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
        imageRefs = { cutout: cutoutId, thumb: thumbId, original: originalId };
        aspect = prepared.aspect;
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
        tags: draft.tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        favorite: draft.favorite,
        status: existing?.status ?? 'active',
        images: imageRefs!,
        imageAspect: aspect,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        demo: existing?.demo && !prepared ? existing.demo : undefined,
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
  const isNew = !existing;
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'photo', label: '1 照片' },
    { key: 'cutout', label: '2 去背' },
    { key: 'info', label: '3 信息' },
  ];
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
                  <p style={{ margin: '8px 0 16px' }}>{busy ?? '拍一张平铺的衣物照片'}</p>
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
              <ul className="tips">
                <li>衣物平铺，完整入镜，四周留一点空白。</li>
                <li>深色衣物配浅色背景，浅色衣物配深色背景，背景越纯越好（床单、地板、纸板都可以）。</li>
                <li>光线均匀，避免强烈阴影和反光。</li>
                <li>上衣和外套尽量把袖子摆开，换装时更像穿在身上。</li>
              </ul>
              {existing && (
                <button type="button" className="btn btn-ghost" onClick={() => setStep('info')}>
                  不换照片，返回
                </button>
              )}
            </div>
          )}

          {step === 'cutout' && work && (
            <div style={{ display: 'grid', gap: 12 }}>
              {work.bg.spread > 9 && !noRemoval && (
                <div className="warnbox">背景颜色不太均匀，自动去背可能不完整。可以用下方的擦除和恢复笔刷修一修，或换一块纯色背景重拍。</div>
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
                  onPointerUp={() => (painting.current = false)}
                  onPointerCancel={() => (painting.current = false)}
                />
                {busy && <div className="busy">{busy}</div>}
              </div>
              <Switch label="不去背，保留原图" checked={noRemoval} onChange={setNoRemoval} hint="背景太杂时可以先保留原图，换装时会显示为矩形照片" />
              {!noRemoval && (
                <>
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
                    <button type="button" className="btn btn-small" style={{ justifySelf: 'start' }} onClick={() => setStep('photo')}>
                      <Icon name="camera" />
                      重新拍照
                    </button>
                  )}
                </div>
              </div>

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

              {app?.fit && (
                <Field label="版型">
                  <Segmented<Fit> options={['slim', 'regular', 'loose']} value={draft.fit} labels={FIT_LABELS} onChange={(v) => set({ fit: v })} />
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
                  {showMore ? '收起更多信息' : '材质、品牌、标签'}
                </button>
                {showMore && (
                  <div style={{ display: 'grid', gap: 10 }}>
                    <input className="input" placeholder="材质，例如：棉、羊毛、麂皮" value={draft.material} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ material: e.target.value })} aria-label="材质" />
                    <input className="input" placeholder="品牌" value={draft.brand} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ brand: e.target.value })} aria-label="品牌" />
                    <input className="input" placeholder="标签，用逗号分隔" value={draft.tags} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ tags: e.target.value })} aria-label="标签" />
                  </div>
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
