// 今日：天气与场合 → 3 套推荐（人台展示 + 卷尺评分 + 理由）→ 穿这套 / 换一件 / 不喜欢。

import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, OCCASIONS, OCCASION_LABELS } from '../../core/catalog';
import {
  applyFeedback,
  evaluateOutfit,
  recommend,
  summarizeNotes,
  swapAlternatives,
  type OutfitEvaluation,
  type RecommendContext,
} from '../../core/recommend';
import { idleItems, wearStats } from '../../core/stats';
import type { Category, Item, Occasion, WearRecord } from '../../core/types';
import { representativeTemp, warmthTarget, weatherCodeLabel } from '../../core/weather';
import { isHosted } from '../../storage/hosted';
import { ItemThumb, NoteList, PartBars, ScoreTape } from '../components/Bits';
import { ChipSelect, Sheet } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Mannequin } from '../components/Mannequin';
import { createDemoWardrobe } from '../demo';
import { newId, useStore, type TodayWeather } from '../store';
import { useUI } from '../ui';
import { fetchWeather, getPosition } from '../weatherFetch';

const STRIP_ORDER: Category[] = ['outer', 'top', 'dress', 'bottom', 'shoes', 'bag', 'belt', 'scarf', 'hat', 'jewelry'];
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function dateTitle(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${m}月${d}日 ${WEEKDAYS[wd]}`;
}

export function snapshotRecord(items: Item[], base: Omit<WearRecord, 'itemIds' | 'itemSnapshots'>): WearRecord {
  return {
    ...base,
    itemIds: items.map((i) => i.id),
    itemSnapshots: items.map((i) => ({ id: i.id, name: i.name, category: i.category, colorHex: i.color.hex })),
  };
}

export function TodayPage() {
  const store = useStore();
  const ui = useUI();
  const { items, records, feedback, settings, today, goals } = store;
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [exclude, setExclude] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<number, Item[]>>({});
  const [active, setActive] = useState(0);
  const [showParts, setShowParts] = useState(false);
  const [swapFor, setSwapFor] = useState<{ slide: number; category: Category } | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [showRecs, setShowRecs] = useState(false);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [rangeDraft, setRangeDraft] = useState<{ min: string; max: string } | null>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const autoFetched = useRef(false);
  // 发布页面里不能联网查天气，也不能定位，只提供手动输入
  const canFetchWeather = !isHosted();

  const ctx: RecommendContext = useMemo(
    () => ({
      items,
      weather: today.weather,
      occasion: today.occasion,
      goals,
      records,
      feedback,
      today: today.date,
      rotation: settings.rotation,
    }),
    [items, today.weather, today.occasion, today.date, goals, records, feedback, settings.rotation],
  );
  const result = useMemo(() => recommend(ctx, { exclude, seed }), [ctx, exclude, seed]);

  useEffect(() => {
    setOverrides({});
  }, [result]);

  const outfits: OutfitEvaluation[] = result.outfits.map((o, i) => (overrides[i] ? evaluateOutfit(overrides[i], ctx) : o));
  const current = outfits[Math.min(active, outfits.length - 1)];
  const todayRecords = records.filter((r) => r.date === today.date);
  const worn = todayRecords[0];
  const wornItems = worn ? worn.itemIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i) : [];
  const idle = useMemo(() => idleItems(items, wearStats(records), today.date, 30), [items, records, today.date]);
  const recsVisible = !worn || showRecs;

  // 有保存的位置且天气过期时，自动联网更新一次
  useEffect(() => {
    if (!store.ready || autoFetched.current) return;
    autoFetched.current = true;
    if (canFetchWeather && settings.location && today.weather.source !== 'auto' && navigator.onLine) void updateWeather(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.ready]);

  async function updateWeather(relocate: boolean) {
    setWeatherBusy(true);
    try {
      let loc = settings.location;
      if (!loc || relocate) {
        loc = await getPosition();
        await store.updateSettings({ location: loc });
      }
      const w = await fetchWeather(loc);
      await store.setToday({ weather: { ...w, source: 'auto', fetchedAt: Date.now() } });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '获取天气失败，请手动输入气温');
    } finally {
      setWeatherBusy(false);
    }
  }

  function setWeather(patch: Partial<TodayWeather>) {
    void store.setToday({ weather: { ...today.weather, ...patch, source: 'manual' } });
  }

  function openRange() {
    const w0 = today.weather;
    setRangeDraft({
      min: String(w0.tempMin ?? w0.tempC - 4),
      max: String(w0.tempMax ?? w0.tempC + 3),
    });
  }

  function applyRange() {
    if (!rangeDraft) return;
    const min = Math.round(Number(rangeDraft.min));
    const max = Math.round(Number(rangeDraft.max));
    if (!Number.isFinite(min) || !Number.isFinite(max) || rangeDraft.min.trim() === '' || rangeDraft.max.trim() === '') {
      ui.toast('请填写最高和最低气温');
      return;
    }
    if (min > max) {
      ui.toast('最低气温不能高于最高气温');
      return;
    }
    if (min < -40 || max > 50) {
      ui.toast('气温超出了 -40 到 50°C 的范围');
      return;
    }
    setWeather({ tempMin: min, tempMax: max, tempC: representativeTemp(min, max), code: undefined });
    setRangeDraft(null);
  }

  function scrollTo(i: number) {
    const el = carouselRef.current;
    if (!el) return;
    el.scrollTo({ left: i * (el.clientWidth + 12), behavior: 'smooth' });
    setActive(i);
  }

  function onCarouselScroll() {
    const el = carouselRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / (el.clientWidth + 12));
    if (i !== active) setActive(i);
  }

  function refresh() {
    setExclude((prev) => [...prev, ...result.outfits.map((o) => o.signature)]);
    setSeed(Math.floor(Math.random() * 1e6));
    setActive(0);
    carouselRef.current?.scrollTo({ left: 0 });
  }

  async function wearThis(o: OutfitEvaluation) {
    const now = Date.now();
    const rec = snapshotRecord(o.items, {
      id: newId('rec-'),
      date: today.date,
      occasion: today.occasion ?? undefined,
      tempC: today.weather.tempC,
      source: 'recommend',
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRecord(rec);
    await store.setFeedback(applyFeedback(feedback, o.items, 'worn'));
    setShowRecs(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    ui.toast('已记为今天的穿搭', { label: '加上身照', run: () => ui.open({ kind: 'record', draft: { record: rec, source: 'recommend' } }) });
  }

  async function dislike(o: OutfitEvaluation) {
    const before = feedback;
    await store.setFeedback(applyFeedback(feedback, o.items, 'dislike'));
    ui.toast('不再推荐这一套', { label: '撤销', run: () => void store.setFeedback(before) });
  }

  async function loadDemo() {
    setDemoBusy('正在生成示例衣橱…');
    try {
      await createDemoWardrobe((d, t) => setDemoBusy(`正在生成示例衣橱 ${d}/${t}`));
      await store.reload();
      ui.toast('已载入 20 件示例单品，可在设置里一键清除');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '示例衣橱生成失败');
    } finally {
      setDemoBusy(null);
    }
  }

  const w = today.weather;
  const target = warmthTarget(w.tempC);
  const weatherMeta =
    w.source === 'auto'
      ? `${w.code !== undefined ? weatherCodeLabel(w.code) : ''} ${w.tempMin ?? ''}–${w.tempMax ?? ''}°`
      : w.source === 'stale'
        ? '沿用上次的气温，记得按今天的预报调整'
        : w.tempMin !== undefined && w.tempMax !== undefined
          ? `${w.tempMin}–${w.tempMax}°，手动输入`
          : '手动输入';

  const header = (
    <header className="topbar">
      <h1>{dateTitle(today.date)}</h1>
      <div className="topbar-actions">
        <button type="button" className="icon-btn" aria-label="设置" onClick={() => ui.open({ kind: 'settings' })}>
          <Icon name="gear" />
        </button>
      </div>
    </header>
  );

  if (items.length === 0) {
    return (
      <>
        {header}
        <div className="page">
          <div className="empty">
            <div className="stage">
              <Mannequin body={settings.body} items={[]} />
            </div>
            <h2>先把衣橱搬进来</h2>
            <p>把衣服平铺在纯色背景上拍一张，应用会自动去掉背景、识别颜色。录入几件上衣和下装后，这里每天会给出搭配建议。</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'item', id: null })}>
                <Icon name="camera" />
                录入第一件
              </button>
              <button type="button" className="btn" disabled={!!demoBusy} onClick={loadDemo}>
                {demoBusy ?? '用示例衣橱试试'}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const stripItems = current ? STRIP_ORDER.flatMap((c) => current.items.filter((i) => i.category === c)) : [];
  const alternatives =
    swapFor && outfits[swapFor.slide]
      ? swapAlternatives(outfits[swapFor.slide].items, swapFor.category, ctx).slice(0, 8)
      : [];
  const swapBase = swapFor ? outfits[swapFor.slide] : null;

  return (
    <>
      {header}
      <div className="page">
        <section className="weather" aria-label="今日天气">
          <div className="temp" aria-live="polite">
            {w.tempC}
            <sup>°C</sup>
          </div>
          <div className="temp-meta">
            <strong>{target.label}</strong>
            <span>{weatherMeta}</span>
          </div>
          <div className="stepper">
            <button type="button" aria-label="气温降低 1 度" onClick={() => setWeather({ tempC: w.tempC - 1, tempMin: undefined, tempMax: undefined, code: undefined })}>
              −
            </button>
            <button type="button" aria-label="气温升高 1 度" onClick={() => setWeather({ tempC: w.tempC + 1, tempMin: undefined, tempMax: undefined, code: undefined })}>
              +
            </button>
          </div>
        </section>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="chip" aria-pressed={w.rain} onClick={() => setWeather({ rain: !w.rain })}>
            有雨
          </button>
          <button type="button" className="chip" onClick={openRange}>
            填最高/最低气温
          </button>
          {canFetchWeather && (
            <button type="button" className="chip" disabled={weatherBusy} onClick={() => updateWeather(false)}>
              {weatherBusy ? '正在获取…' : settings.location ? '更新天气' : '定位获取天气'}
            </button>
          )}
        </div>

        <div className="section" style={{ marginTop: 18 }}>
          <ChipSelect<Occasion>
            options={OCCASIONS}
            value={today.occasion}
            labels={OCCASION_LABELS}
            onChange={(v) => void store.setToday({ occasion: v })}
            scroll
          />
        </div>

        {worn && (
          <section className="section" aria-label="今天的穿搭">
            <h2 className="section-title">
              今天穿了这套 <small>{todayRecords.length > 1 ? `共 ${todayRecords.length} 条记录` : ''}</small>
            </h2>
            <div className="record" style={{ marginTop: 0 }}>
              <div className="stage">
                <Mannequin body={settings.body} items={wornItems} layout={worn.layout} />
                {wornItems.length > 0 && (
                  <div className="stage-tools">
                    <button
                      type="button"
                      className="stage-btn"
                      aria-label="3D 查看今天的穿搭"
                      onClick={() => ui.open({ kind: 'view3d', itemIds: wornItems.map((i) => i.id), layout: worn.layout, title: '今天的穿搭' })}
                    >
                      3D
                    </button>
                  </div>
                )}
              </div>
              <div>
                <div className="items">{worn.itemSnapshots.map((s) => s.name).join('、')}</div>
                <div className="row row-wrap" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-small" onClick={() => ui.open({ kind: 'record', draft: { record: worn, source: worn.source } })}>
                    {worn.photo ? '编辑记录' : '加上身照'}
                  </button>
                  {!showRecs && (
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => setShowRecs(true)}>
                      看看其他搭配
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {recsVisible && (
          <>
            {outfits.length > 0 && current ? (
              <>
                <div className="carousel" ref={carouselRef} onScroll={onCarouselScroll} aria-label="推荐搭配">
                  {outfits.map((o, i) => (
                    <div className="slide" key={`${o.signature}-${i}`} aria-label={`方案 ${i + 1}，${o.score} 分`}>
                      <div className="stage">
                        <Mannequin body={settings.body} items={o.items} animate />
                        <div className="stage-tools">
                          <button
                            type="button"
                            className="stage-btn"
                            aria-label={`3D 查看方案 ${i + 1}`}
                            onClick={() => ui.open({ kind: 'view3d', itemIds: o.items.map((x) => x.id), title: `方案 ${i + 1}` })}
                          >
                            3D
                          </button>
                        </div>
                      </div>
                      <ScoreTape score={o.score} />
                    </div>
                  ))}
                </div>
                <div className="dots" role="tablist">
                  {outfits.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      role="tab"
                      aria-label={`方案 ${i + 1}`}
                      aria-current={i === active}
                      onClick={() => scrollTo(i)}
                    />
                  ))}
                </div>

                <div className="strip" aria-label="这套的单品，点一下可以换">
                  {stripItems.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      className="strip-item"
                      onClick={() => setSwapFor({ slide: active, category: it.category })}
                      aria-label={`换掉${it.name}`}
                    >
                      <ItemThumb item={it} swap />
                      <span>{it.name}</span>
                    </button>
                  ))}
                </div>

                <section className="section" style={{ marginTop: 14 }}>
                  <NoteList notes={summarizeNotes(current)} />
                  <button type="button" className="btn btn-ghost btn-small" style={{ paddingLeft: 0, marginTop: 6 }} onClick={() => setShowParts((v) => !v)} aria-expanded={showParts}>
                    {showParts ? '收起评分明细' : '查看评分明细'}
                  </button>
                  {showParts && <PartBars evaluation={current} />}
                </section>

                <div className="row" style={{ marginTop: 16 }}>
                  <button type="button" className="btn btn-primary grow" onClick={() => wearThis(current)}>
                    <Icon name="check" />
                    就穿这套
                  </button>
                  <button type="button" className="btn" onClick={() => dislike(current)}>
                    不喜欢
                  </button>
                  <button
                    type="button"
                    className="btn"
                    aria-label="去试搭里调整"
                    onClick={() => ui.sendToBuilder({ itemIds: current.items.map((i) => i.id) })}
                  >
                    调整
                  </button>
                </div>
                <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={refresh}>
                  <Icon name="refresh" />
                  换一批
                </button>
                {result.notes.length > 0 && (
                  <div className="section">
                    <NoteList notes={result.notes} />
                  </div>
                )}
              </>
            ) : (
              <div className="section">
                <NoteList
                  notes={
                    result.notes.length
                      ? result.notes
                      : [{ kind: 'info', text: '这一批已经看完了，可以重新开始或换个场合。' }]
                  }
                />
                <div className="row" style={{ marginTop: 14 }}>
                  {exclude.length > 0 ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setExclude([]);
                        setSeed(undefined);
                      }}
                    >
                      重新开始
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'item', id: null })}>
                      <Icon name="camera" />
                      继续录入
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        <div className="section" style={{ display: 'grid', gap: 8 }}>
          {!settings.body && (
            <button type="button" className="callout" onClick={() => ui.open({ kind: 'settings' })}>
              <Icon name="ruler" />
              <span>
                <strong>填写身材数据</strong>
                <br />
                人台会按你的比例显示，推荐也会参考腿长、肩臀和腰臀比例。
              </span>
            </button>
          )}
          {idle.length > 0 && (
            <button type="button" className="callout" onClick={() => ui.go('records')}>
              <Icon name="archive" />
              <span>
                <strong>{idle.length} 件单品超过 30 天没穿</strong>
                <br />
                推荐会优先把它们排进搭配，也可以在记录页查看。
              </span>
            </button>
          )}
        </div>
      </div>

      {rangeDraft && (
        <Sheet onClose={() => setRangeDraft(null)} label="填写今天的气温">
          <h2>今天的气温</h2>
          <p>
            照着天气预报填最高和最低气温，推荐会按白天偏暖的时段来算厚薄{canFetchWeather ? '' : '（这个页面不能联网查天气）'}。温差大时会提醒带外套。
          </p>
          <div className="range-grid">
            <label>
              最低
              <span className="input-unit">
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  id="temp-min"
                  value={rangeDraft.min}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRangeDraft({ ...rangeDraft, min: e.target.value })}
                />
                <span>°C</span>
              </span>
            </label>
            <label>
              最高
              <span className="input-unit">
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  id="temp-max"
                  value={rangeDraft.max}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRangeDraft({ ...rangeDraft, max: e.target.value })}
                />
                <span>°C</span>
              </span>
            </label>
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => setRangeDraft(null)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={applyRange}>
              用这个气温
            </button>
          </div>
        </Sheet>
      )}

      {swapFor && swapBase && (
        <Sheet onClose={() => setSwapFor(null)} label={`换${CATEGORY_LABELS[swapFor.category]}`}>
          <h2>换{CATEGORY_LABELS[swapFor.category]}</h2>
          <p>按换上后的整套得分排序，当前 {swapBase.score} 分。</p>
          {alternatives.length === 0 ? (
            <p>衣橱里没有其他适合当前天气的{CATEGORY_LABELS[swapFor.category]}。</p>
          ) : (
            <div className="alt-list">
              {alternatives.map((alt) => {
                const changed = alt.items.find((i) => i.category === swapFor.category);
                const delta = alt.score - swapBase.score;
                return (
                  <button
                    key={alt.signature + (changed?.id ?? 'none')}
                    type="button"
                    className="alt"
                    onClick={() => {
                      setOverrides((o) => ({ ...o, [swapFor.slide]: alt.items }));
                      setSwapFor(null);
                    }}
                  >
                    {changed ? <ItemThumb item={changed} /> : <div className="thumb" />}
                    <span>
                      {changed ? changed.name : `不穿${CATEGORY_LABELS[swapFor.category]}`}
                      <br />
                      <span className="muted small">{summarizeNotes(alt, 1, 1)[0]?.text ?? ''}</span>
                    </span>
                    <span>
                      <span className="score">{alt.score}</span>
                      <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
                        {delta >= 0 ? '+' : ''}
                        {delta}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}
