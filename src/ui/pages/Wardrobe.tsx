// 衣橱：搜索、按类别筛选、网格浏览。

import { useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, OCCASION_LABELS, SEASON_LABELS, STYLE_LABELS } from '../../core/catalog';
import { wearStats } from '../../core/stats';
import type { Category } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { Icon } from '../components/Icon';
import { useStore } from '../store';
import { useUI } from '../ui';

type Filter = Category | 'all' | 'archived' | 'favorite';

export function WardrobePage() {
  const { items, records, ready } = useStore();
  const ui = useUI();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const stats = useMemo(() => wearStats(records), [records]);

  const active = items.filter((i) => i.status === 'active');
  const counts = useMemo(() => {
    const c = new Map<Filter, number>();
    for (const i of items) {
      if (i.status === 'archived') c.set('archived', (c.get('archived') ?? 0) + 1);
      else {
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
    if (!query) return true;
    const hay = [
      i.name,
      i.subtype,
      i.color.name,
      i.color2?.name,
      i.brand,
      i.material,
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
  const filterLabel = (f: Filter) =>
    f === 'all' ? `全部 ${active.length}` : f === 'archived' ? '已归档' : f === 'favorite' ? '收藏' : `${CATEGORY_LABELS[f]} ${counts.get(f) ?? 0}`;

  return (
    <>
      <header className="topbar">
        <h1>衣橱</h1>
        <button type="button" className="btn btn-primary btn-small" onClick={() => ui.open({ kind: 'item', id: null })}>
          <Icon name="plus" />
          录入单品
        </button>
      </header>
      <div className="page">
        {ready && items.length > 0 && (
          <>
            <div className="search">
              <Icon name="search" />
              <input
                className="input"
                type="search"
                placeholder="搜索名称、颜色、品牌、标签"
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
          </>
        )}
        {ready && items.length === 0 && (
          <div className="empty">
            <h2>衣橱还是空的</h2>
            <p>拍一张平铺的衣服照片开始录入。深色衣物用浅色背景拍，浅色衣物用深色背景拍，去背效果最好。</p>
            <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'item', id: null })}>
              <Icon name="camera" />
              录入单品
            </button>
          </div>
        )}
        {items.length > 0 && shown.length === 0 && <p className="muted small" style={{ marginTop: 24 }}>没有符合条件的单品。</p>}
        <div className="grid">
          {shown.map((i) => {
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
          })}
        </div>
      </div>
    </>
  );
}
