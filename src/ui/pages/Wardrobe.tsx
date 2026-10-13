// 衣橱：搜索、按类别筛选、按品牌/长短/面料/颜色等分类筛选与分组、网格浏览。

import { useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, OCCASION_LABELS, SEASON_LABELS, STYLE_LABELS } from '../../core/catalog';
import { groupItems, matchesFacets, selectionSize, type FacetKey, type FacetSelection } from '../../core/facets';
import { wearStats } from '../../core/stats';
import type { Category, Item } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { ActiveFacets, FacetSheet, GroupSelect } from '../components/Facets';
import { Icon } from '../components/Icon';
import { useStore } from '../store';
import { useUI } from '../ui';

type Filter = Category | 'all' | 'archived' | 'favorite';

export function WardrobePage() {
  const { items, records, ready } = useStore();
  const ui = useUI();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [facets, setFacets] = useState<FacetSelection>({});
  const [groupBy, setGroupBy] = useState<FacetKey | ''>('');
  const [showFacets, setShowFacets] = useState(false);
  const stats = useMemo(() => wearStats(records), [records]);

  const active = items.filter((i) => i.status === 'active');
  const pending = items.filter((i) => i.status === 'pending').length;
  const counts = useMemo(() => {
    const c = new Map<Filter, number>();
    for (const i of items) {
      if (i.status === 'archived') c.set('archived', (c.get('archived') ?? 0) + 1);
      else if (i.status === 'active') {
        c.set(i.category, (c.get(i.category) ?? 0) + 1);
        if (i.favorite) c.set('favorite', (c.get('favorite') ?? 0) + 1);
      }
    }
    return c;
  }, [items]);

  const query = q.trim().toLowerCase();
  const shown = items.filter((i) => {
    if (filter === 'archived') {
      if (i.status !== 'archived') return false;
    } else {
      if (i.status !== 'active') return false;
      if (filter === 'favorite' && !i.favorite) return false;
      if (filter !== 'all' && filter !== 'favorite' && i.category !== filter) return false;
    }
    if (!matchesFacets(i, facets)) return false;
    if (!query) return true;
    const hay = [
      i.name,
      i.subtype,
      i.color.name,
      i.color2?.name,
      i.brand,
      i.material,
      i.styleNo,
      i.size,
      CATEGORY_LABELS[i.category],
      ...i.tags,
      ...i.seasons.map((s) => SEASON_LABELS[s]),
      ...i.occasions.map((o) => OCCASION_LABELS[o]),
      ...i.styles.map((s) => STYLE_LABELS[s]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  });

  const filters: Filter[] = ['all', ...CATEGORIES.filter((c) => counts.get(c)), ...(counts.get('favorite') ? (['favorite'] as Filter[]) : []), ...(counts.get('archived') ? (['archived'] as Filter[]) : [])];
  // 筛选面板里的选项按当前类别范围统计
  const scope = items.filter((i) =>
    filter === 'archived' ? i.status === 'archived' : i.status === 'active' && (filter === 'all' || (filter === 'favorite' ? i.favorite : i.category === filter)),
  );
  const nFacets = selectionSize(facets);
  const groups = groupBy ? groupItems(shown, groupBy) : null;

  const tile = (i: Item) => {
    const s = stats.get(i.id);
    return (
      <button key={i.id} type="button" className="tile" onClick={() => ui.open({ kind: 'item', id: i.id })}>
        <ItemThumb item={i} />
        <div className="tile-name">{i.name}</div>
        <div className="tile-meta">
          <span className="swatch" style={{ background: i.color.hex }} />
          <span>{s ? `穿过 ${s.count} 次` : '还没穿过'}</span>
        </div>
      </button>
    );
  };

  const filterLabel = (f: Filter) =>
    f === 'all' ? `全部 ${active.length}` : f === 'archived' ? '已归档' : f === 'favorite' ? '收藏' : `${CATEGORY_LABELS[f]} ${counts.get(f) ?? 0}`;

  return (
    <>
      <header className="topbar">
        <h1>衣橱</h1>
        <div className="topbar-actions">
          <button type="button" className="btn btn-small" onClick={() => ui.open({ kind: 'batch' })}>
            <Icon name="layers" />
            批量录入
          </button>
          <button type="button" className="btn btn-primary btn-small" onClick={() => ui.open({ kind: 'item', id: null })}>
            <Icon name="plus" />
            录入单品
          </button>
        </div>
      </header>
      <div className="page">
        {pending > 0 && (
          <button type="button" className="callout" style={{ marginBottom: 12 }} onClick={() => ui.open({ kind: 'review' })}>
            <Icon name="layers" />
            <span>
              <strong>{pending} 件待整理</strong>
              <br />
              批量录入的单品，类别是按轮廓猜的，确认一下才会参与推荐。
            </span>
          </button>
        )}
        {ready && active.length + (counts.get('archived') ?? 0) > 0 && (
          <>
            <div className="search">
              <Icon name="search" />
              <input
                className="input"
                type="search"
                placeholder="搜索名称、颜色、品牌、货号"
                value={q}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
                aria-label="搜索衣橱"
              />
            </div>
            <div className="chips chips-scroll" role="group" aria-label="按类别筛选">
              {filters.map((f) => (
                <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {filterLabel(f)}
                </button>
              ))}
            </div>
            <div className="wardrobe-tools">
              <button type="button" className="chip chip-tool" aria-pressed={nFacets > 0} onClick={() => setShowFacets(true)}>
                <Icon name="filter" />
                {nFacets ? `筛选 ${nFacets}` : '按品牌、面料、长短筛选'}
              </button>
              <GroupSelect value={groupBy} onChange={setGroupBy} />
            </div>
            <ActiveFacets items={scope} value={facets} onChange={setFacets} />
          </>
        )}
        {ready && items.length === 0 && (
          <div className="empty">
            <h2>衣橱还是空的</h2>
            <p>拍一张平铺的衣服照片开始录入。深色衣物用浅色背景拍，浅色衣物用深色背景拍，去背效果最好。衣服多的话用「批量录入」，一次选很多张照片。</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'item', id: null })}>
                <Icon name="camera" />
                录入单品
              </button>
              <button type="button" className="btn" onClick={() => ui.open({ kind: 'batch' })}>
                <Icon name="layers" />
                批量录入
              </button>
            </div>
          </div>
        )}
        {active.length + (counts.get('archived') ?? 0) > 0 && shown.length === 0 && <p className="muted small" style={{ marginTop: 24 }}>没有符合条件的单品。</p>}
        {groups ? (
          groups.map((g) => (
            <section key={g.value || 'none'} className="group-block" aria-label={g.label}>
              <h2 className="group-head">
                {g.label} <small>{g.items.length} 件</small>
              </h2>
              <div className="grid">{g.items.map(tile)}</div>
            </section>
          ))
        ) : (
          <div className="grid">{shown.map(tile)}</div>
        )}
      </div>
      {showFacets && <FacetSheet items={scope} value={facets} onChange={setFacets} onClose={() => setShowFacets(false)} />}
    </>
  );
}
