// 试搭：手动挑单品放上人台，拖动和缩放微调，引擎即时给出评分和理由。

import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, OCCASIONS, OCCASION_LABELS } from '../../core/catalog';
import { matchesFacets, selectionSize, type FacetSelection } from '../../core/facets';
import type { ViewSide } from '../../core/body';
import { evaluateOutfit, summarizeNotes, type RecommendContext } from '../../core/recommend';
import type { Category, Item, Occasion, Outfit, Placement } from '../../core/types';
import { ItemThumb, NoteList, PaletteBar, PartBars, ScoreTape } from '../components/Bits';
import { ChipMulti, Sheet } from '../components/Controls';
import { ActiveFacets, FacetSheet } from '../components/Facets';
import { Icon } from '../components/Icon';
import { Mannequin } from '../components/Mannequin';
import { newId, useStore } from '../store';
import { useUI } from '../ui';
import { snapshotRecord } from './Today';

interface BuilderState {
  selected: Partial<Record<Category, string>>;
  layout: Record<string, Placement>;
  outfitId?: string;
  tab: Category;
}

// 切换标签页后保留试搭进度
let memory: BuilderState = { selected: {}, layout: {}, tab: 'top' };

export function BuilderPage() {
  const store = useStore();
  const ui = useUI();
  const [state, setStateRaw] = useState<BuilderState>(memory);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showParts, setShowParts] = useState(false);
  const [saving, setSaving] = useState<null | { name: string; occasions: Occasion[] }>(null);
  const [facets, setFacets] = useState<FacetSelection>({});
  const [showFacets, setShowFacets] = useState(false);
  const [side, setSide] = useState<ViewSide>('front');

  const setState = (fn: (s: BuilderState) => BuilderState) =>
    setStateRaw((s) => {
      const next = fn(s);
      memory = next;
      return next;
    });

  useEffect(() => {
    const seed = ui.takeBuilderSeed();
    if (!seed) return;
    const selected: Partial<Record<Category, string>> = {};
    for (const id of seed.itemIds) {
      const it = store.items.find((i) => i.id === id);
      if (it) selected[it.category] = it.id;
    }
    setState(() => ({ selected, layout: seed.layout ?? {}, outfitId: seed.outfitId, tab: 'top' }));
    setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.builderSeed]);

  const active = store.items.filter((i) => i.status === 'active');
  const chosen = Object.values(state.selected)
    .map((id) => store.items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  const tabs = CATEGORIES.filter((c) => active.some((i) => i.category === c));
  const tab = tabs.includes(state.tab) ? state.tab : tabs[0];

  const ctx: RecommendContext = {
    items: store.items,
    weather: store.today.weather,
    occasion: store.today.occasion,
    goals: store.goals,
    records: store.records,
    feedback: store.feedback,
    today: store.today.date,
    rotation: store.settings.rotation,
  };
  const evaluation = useMemo(
    () => (chosen.length ? evaluateOutfit(chosen, ctx) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen.map((i) => i.id).join(','), store.items, store.today, store.goals, store.records, store.feedback, store.settings.rotation],
  );

  function toggle(item: Item) {
    setState((s) => {
      const sel = { ...s.selected };
      if (sel[item.category] === item.id) {
        delete sel[item.category];
      } else {
        sel[item.category] = item.id;
        if (item.category === 'dress') {
          delete sel.top;
          delete sel.bottom;
        }
        if (item.category === 'top' || item.category === 'bottom') delete sel.dress;
      }
      return { ...s, selected: sel };
    });
    setSelectedId(null);
  }

  function move(id: string, p: Placement) {
    setState((s) => ({ ...s, layout: { ...s.layout, [id]: p } }));
  }

  const selItem = chosen.find((i) => i.id === selectedId);
  const selPlacement = selItem ? state.layout[selItem.id] ?? { dx: 0, dy: 0, scale: 1 } : null;
  const loadedOutfit = state.outfitId ? store.outfits.find((o) => o.id === state.outfitId) : undefined;

  function layoutForChosen(): Record<string, Placement> {
    const out: Record<string, Placement> = {};
    for (const i of chosen) if (state.layout[i.id]) out[i.id] = state.layout[i.id];
    return out;
  }

  async function saveOutfit(asNew: boolean) {
    if (!saving) return;
    const now = Date.now();
    const o: Outfit = {
      id: !asNew && loadedOutfit ? loadedOutfit.id : newId('outfit-'),
      name: saving.name.trim() || chosen.map((i) => i.name).join(' + '),
      itemIds: chosen.map((i) => i.id),
      layout: layoutForChosen(),
      occasions: saving.occasions,
      tags: [],
      createdAt: !asNew && loadedOutfit ? loadedOutfit.createdAt : now,
      updatedAt: now,
    };
    await store.saveOutfit(o);
    setState((s) => ({ ...s, outfitId: o.id }));
    setSaving(null);
    ui.toast(asNew || !loadedOutfit ? '已保存为套装' : '套装已更新');
  }

  async function wearToday() {
    const now = Date.now();
    const rec = snapshotRecord(chosen, {
      id: newId('rec-'),
      date: store.today.date,
      outfitId: state.outfitId,
      layout: layoutForChosen(),
      occasion: store.today.occasion ?? undefined,
      tempC: store.today.weather.tempC,
      source: 'builder',
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRecord(rec);
    ui.toast('已记为今天的穿搭', { label: '加上身照', run: () => ui.open({ kind: 'record', draft: { record: rec, source: 'builder' } }) });
  }

  async function deleteOutfit() {
    if (!loadedOutfit) return;
    const ok = await ui.confirm({ title: `删除套装"${loadedOutfit.name}"？`, body: '单品本身不会被删除。', confirmText: '删除', danger: true });
    if (!ok) return;
    await store.deleteOutfit(loadedOutfit.id);
    setState((s) => ({ ...s, outfitId: undefined }));
    ui.toast('套装已删除');
  }

  function loadOutfit(o: Outfit) {
    const selected: Partial<Record<Category, string>> = {};
    for (const id of o.itemIds) {
      const it = store.items.find((i) => i.id === id);
      if (it) selected[it.category] = it.id;
    }
    setState((s) => ({ ...s, selected, layout: { ...o.layout }, outfitId: o.id }));
    setSelectedId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <header className="topbar">
        <h1>
          试搭
          {loadedOutfit && <span className="sub">{loadedOutfit.name}</span>}
        </h1>
        {chosen.length > 0 && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setState((s) => ({ ...s, selected: {}, layout: {}, outfitId: undefined }));
              setSelectedId(null);
            }}
          >
            清空
          </button>
        )}
      </header>
      <div className="page">
        <div className="stage builder-stage" style={{ borderRadius: evaluation ? 'var(--r-l) var(--r-l) 0 0' : undefined }}>
          <Mannequin
            body={store.settings.body}
            items={chosen}
            layout={state.layout}
            editable
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={move}
            side={side}
            label={side === 'front' ? '试搭人台，可拖动衣物调整位置' : undefined}
          />
          {chosen.length > 0 && (
            <>
              <div className="stage-tools left" role="group" aria-label="看正面还是背面">
                <button type="button" className="stage-btn" aria-pressed={side === 'front'} onClick={() => setSide('front')}>
                  正面
                </button>
                <button
                  type="button"
                  className="stage-btn"
                  aria-pressed={side === 'back'}
                  onClick={() => {
                    setSide('back');
                    setSelectedId(null);
                  }}
                >
                  背面
                </button>
              </div>
              <div className="stage-tools">
                <button
                  type="button"
                  className="stage-btn"
                  aria-label="3D 查看这套"
                  onClick={() => ui.open({ kind: 'view3d', itemIds: chosen.map((i) => i.id), layout: state.layout, title: '试搭' })}
                >
                  3D
                </button>
              </div>
            </>
          )}
        </div>
        {evaluation && <ScoreTape score={evaluation.score} />}
        {evaluation && <PaletteBar items={chosen} />}

        {selItem && selPlacement ? (
          <div className="adjust">
            <span>{selItem.name}</span>
            <input
              type="range"
              min={50}
              max={180}
              value={Math.round(selPlacement.scale * 100)}
              aria-label="大小"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => move(selItem.id, { ...selPlacement, scale: Number(e.target.value) / 100 })}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                setState((s) => {
                  const layout = { ...s.layout };
                  delete layout[selItem.id];
                  return { ...s, layout };
                })
              }
            >
              复位
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => toggle(selItem)}>
              移除
            </button>
          </div>
        ) : (
          chosen.length > 0 && (
            <p className="small muted" style={{ marginTop: 10 }}>
              {side === 'front' ? '点人台上的衣物可以拖动位置、调整大小。' : '这是从身后看的样子，没有背面照片的单品用正面照片代替。切回正面可以拖动调整。'}
            </p>
          )
        )}

        {active.length === 0 ? (
          <div className="empty">
            <h2>衣橱里还没有单品</h2>
            <p>录入几件衣服后，就可以在这里自由组合。</p>
            <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'item', id: null })}>
              <Icon name="camera" />
              录入单品
            </button>
          </div>
        ) : (
          <section className="section" style={{ marginTop: 14 }}>
            <div className="cat-tabs" role="tablist">
              {tabs.map((c) => (
                <button key={c} type="button" role="tab" aria-selected={c === tab} onClick={() => setState((s) => ({ ...s, tab: c }))}>
                  {CATEGORY_LABELS[c]}
                  {state.selected[c] && <i className="tab-dot" aria-label="已选" />}
                </button>
              ))}
            </div>
            <div className="wardrobe-tools">
              <button type="button" className="chip chip-tool" aria-pressed={selectionSize(facets) > 0} onClick={() => setShowFacets(true)}>
                <Icon name="filter" />
                {selectionSize(facets) ? `筛选 ${selectionSize(facets)}` : '按品牌、面料、颜色筛选'}
              </button>
            </div>
            <ActiveFacets items={active} value={facets} onChange={setFacets} />
            {active.filter((i) => i.category === tab && matchesFacets(i, facets)).length === 0 && (
              <p className="muted small">这一类里没有符合条件的单品。</p>
            )}
            <div className="picker">
              {active
                .filter((i) => i.category === tab && matchesFacets(i, facets))
                .map((i) => (
                  <button key={i.id} type="button" className="pick" aria-pressed={state.selected[i.category] === i.id} onClick={() => toggle(i)}>
                    <ItemThumb item={i} />
                    <span>{i.name}</span>
                  </button>
                ))}
            </div>
          </section>
        )}

        {showFacets && <FacetSheet items={active} value={facets} onChange={setFacets} onClose={() => setShowFacets(false)} />}

        {evaluation && (
          <section className="section">
            <NoteList notes={summarizeNotes(evaluation)} />
            <button type="button" className="btn btn-ghost btn-small" style={{ paddingLeft: 0, marginTop: 6 }} onClick={() => setShowParts((v) => !v)} aria-expanded={showParts}>
              {showParts ? '收起评分明细' : '查看评分明细'}
            </button>
            {showParts && <PartBars evaluation={evaluation} />}
            <div className="row" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-primary grow" onClick={wearToday}>
                记为今天
              </button>
              <button
                type="button"
                className="btn grow"
                onClick={() =>
                  setSaving({
                    name: loadedOutfit?.name ?? chosen.filter((i) => ['top', 'bottom', 'dress', 'outer'].includes(i.category)).map((i) => i.name).join(' + '),
                    occasions: loadedOutfit?.occasions ?? (store.today.occasion ? [store.today.occasion] : []),
                  })
                }
              >
                {loadedOutfit ? '保存套装' : '存为套装'}
              </button>
            </div>
            {loadedOutfit && (
              <button type="button" className="btn btn-ghost btn-danger btn-small" style={{ marginTop: 8 }} onClick={deleteOutfit}>
                删除这个套装
              </button>
            )}
          </section>
        )}

        {store.outfits.length > 0 && (
          <section className="section">
            <h2 className="section-title">
              我的套装 <small>{store.outfits.length} 套</small>
            </h2>
            <div className="outfit-cards">
              {store.outfits.map((o) => {
                const its = o.itemIds.map((id) => store.items.find((i) => i.id === id)).filter((i): i is Item => !!i);
                return (
                  <button key={o.id} type="button" className="outfit-card" onClick={() => loadOutfit(o)}>
                    <div className="stage">
                      <Mannequin body={store.settings.body} items={its} layout={o.layout} label={o.name} />
                    </div>
                    <span>{o.name}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {saving && (
        <Sheet onClose={() => setSaving(null)} label="保存套装">
          <h2>{loadedOutfit ? '保存套装' : '存为套装'}</h2>
          <p>套装会保存单品组合和人台上的位置，之后可以直接复用。</p>
          <input
            className="input"
            value={saving.name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSaving({ ...saving, name: e.target.value })}
            aria-label="套装名称"
            placeholder="套装名称"
          />
          <div style={{ marginTop: 12 }}>
            <ChipMulti<Occasion> options={OCCASIONS} value={saving.occasions} labels={OCCASION_LABELS} onChange={(v) => setSaving({ ...saving, occasions: v })} />
          </div>
          <div className="sheet-actions">
            {loadedOutfit ? (
              <>
                <button type="button" className="btn" onClick={() => saveOutfit(true)}>
                  另存为新套装
                </button>
                <button type="button" className="btn btn-primary" onClick={() => saveOutfit(false)}>
                  更新
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => setSaving(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" onClick={() => saveOutfit(true)}>
                  保存
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
