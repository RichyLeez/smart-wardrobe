// 分类筛选：底部弹层里按品牌、长短、面料、颜色等维度多选，页面上显示已选条件。

import { useMemo } from 'react';
import {
  FACET_LABELS,
  FILTER_FACETS,
  GROUP_FACETS,
  facetOptions,
  matchesFacets,
  selectionSize,
  toggleFacet,
  type FacetKey,
  type FacetSelection,
} from '../../core/facets';
import { paletteByName } from '../../core/color';
import type { Item } from '../../core/types';
import { Sheet } from './Controls';

export function FacetSheet({
  items,
  value,
  onChange,
  onClose,
}: {
  items: Item[];
  value: FacetSelection;
  onChange: (v: FacetSelection) => void;
  onClose: () => void;
}) {
  const groups = useMemo(
    () => FILTER_FACETS.map((key) => ({ key, options: facetOptions(items, key) })).filter((g) => g.options.length > 0),
    [items],
  );
  const count = items.filter((i) => matchesFacets(i, value)).length;
  return (
    <Sheet onClose={onClose} label="筛选单品">
      <h2>筛选</h2>
      <p>同一项里可以多选。品牌和面料来自录入时填写或吊牌识别的信息。</p>
      <div className="facet-groups">
        {groups.map(({ key, options }) => (
          <section key={key} className="facet-group" aria-label={FACET_LABELS[key]}>
            <h3>{FACET_LABELS[key]}</h3>
            <div className="chips" role="group">
              {options.map((o) => {
                const on = value[key]?.includes(o.value) ?? false;
                const swatch = key === 'color' ? paletteByName(o.value)?.hex : undefined;
                return (
                  <button
                    key={o.value}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    onClick={() => onChange(toggleFacet(value, key, o.value))}
                  >
                    {swatch && <span className="swatch" style={{ background: swatch }} />}
                    {o.label}
                    <span className="chip-count">{o.count}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="muted small">衣橱里还没有可以分类的信息。</p>}
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" disabled={selectionSize(value) === 0} onClick={() => onChange({})}>
          清除条件
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          看 {count} 件
        </button>
      </div>
    </Sheet>
  );
}

/** 已选条件，点一下去掉 */
export function ActiveFacets({ items, value, onChange }: { items: Item[]; value: FacetSelection; onChange: (v: FacetSelection) => void }) {
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const key of FILTER_FACETS) for (const o of facetOptions(items, key)) m.set(`${key}|${o.value}`, o.label);
    return m;
  }, [items]);
  const entries = (Object.entries(value) as Array<[FacetKey, string[] | undefined]>).flatMap(([key, vs]) =>
    (vs ?? []).map((v) => ({ key, v, label: labels.get(`${key}|${v}`) ?? v })),
  );
  if (entries.length === 0) return null;
  return (
    <div className="chips chips-scroll active-facets" role="group" aria-label="已选条件">
      {entries.map((e) => (
        <button
          key={`${e.key}|${e.v}`}
          type="button"
          className="chip chip-removable"
          aria-label={`去掉条件：${FACET_LABELS[e.key]} ${e.label}`}
          onClick={() => onChange(toggleFacet(value, e.key, e.v))}
        >
          {FACET_LABELS[e.key]} {e.label}
          <span aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="chip chip-plain" onClick={() => onChange({})}>
        清除
      </button>
    </div>
  );
}

export const GROUP_LABELS: Record<string, string> = Object.fromEntries([
  ['', '不分组'],
  ...GROUP_FACETS.map((k) => [k, `按${FACET_LABELS[k]}`]),
]);

export function GroupSelect({ value, onChange }: { value: FacetKey | ''; onChange: (v: FacetKey | '') => void }) {
  return (
    <label className="group-select">
      <span className="sr-only">分组方式</span>
      <select id="wardrobe-group" value={value} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as FacetKey | '')}>
        {['', ...GROUP_FACETS].map((k) => (
          <option key={k} value={k}>
            {GROUP_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  );
}
