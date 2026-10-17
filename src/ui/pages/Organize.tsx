// 整理：录入时按轮廓自动分好的类别、款式，以及按款式填好的季节、场合、风格等，
// 在这里按大类分组浏览、多选后成批修改。从衣橱页右上角「整理」进入。

import { useState } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
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
  lengthLabels,
  subtypesOf,
} from '../../core/catalog';
import {
  applicableCount,
  applyBulk,
  commonValue,
  organizeGroups,
  tagState,
  viewCounts,
  type BulkEdit,
  type OrganizeGroup,
  type OrganizeView,
  type TagKey,
  type TriState,
} from '../../core/organize';
import type { Category, Fit, Item, Length, Pattern, Rise, Warmth } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { ChipSelect, Field, Segmented, Sheet } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useStore } from '../store';
import { useUI } from '../ui';

type SheetKind = 'kind' | TagKey | 'warmth' | 'pattern' | 'shape';

const VIEW_LABELS: Record<OrganizeView, string> = { unverified: '未核对', nosubtype: '没认出款式', all: '全部' };
const PATTERNS: Pattern[] = ['solid', 'stripe', 'check', 'print', 'colorblock'];

export function OrganizePage({ view: initialView }: { view?: OrganizeView }) {
  const store = useStore();
  const ui = useUI();
  const counts = viewCounts(store.items);
  const [view, setViewState] = useState<OrganizeView>(initialView ?? (counts.unverified ? 'unverified' : 'all'));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const groups = organizeGroups(store.items, view);
  const visible = groups.flatMap((g) => g.items);
  // 只算还看得见的（改完以后移出"未核对"的不再算选中）
  const sel = visible.filter((i) => selected.has(i.id));
  const allSelected = visible.length > 0 && sel.length === visible.length;

  function setView(v: OrganizeView) {
    setViewState(v);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(g: OrganizeGroup) {
    const all = g.items.every((i) => selected.has(i.id));
    setSelected((s) => {
      const next = new Set(s);
      for (const i of g.items) {
        if (all) next.delete(i.id);
        else next.add(i.id);
      }
      return next;
    });
  }

  async function apply(edit: BulkEdit, done: (n: number) => string) {
    const changed = applyBulk(sel, edit, Date.now());
    setSheet(null);
    if (!changed.length) {
      ui.toast('选中的几件本来就是这样，没有改动');
      return;
    }
    try {
      await store.saveItems(changed);
      setSelected(new Set());
      ui.toast(done(changed.length));
    } catch (e) {
      ui.toast(e instanceof Error ? `没改成：${e.message}` : '没改成，可能是存储空间不足');
    }
  }

  async function removeSelected() {
    const n = sel.length;
    const ok = await ui.confirm({
      title: `删除选中的 ${n} 件？`,
      body: '图片会一起删除，无法恢复。过去的穿搭记录会保留它们的名称。只是暂时不穿的话，可以打开单品选择归档。',
      confirmText: `删除 ${n} 件`,
      danger: true,
    });
    if (!ok) return;
    for (const it of sel) await store.deleteItem(it.id);
    setSelected(new Set());
    ui.toast(`已删除 ${n} 件`);
  }

  const views: OrganizeView[] = (['unverified', 'nosubtype', 'all'] as OrganizeView[]).filter((v) => v === 'all' || v === view || counts[v] > 0);
  const anyUnverified = sel.some((i) => i.unverified);
  const anyShape = applicableCount(sel, 'fit') + applicableCount(sel, 'length') + applicableCount(sel, 'rise') > 0;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="整理">
      <div className={`overlay-inner${sel.length ? ' with-bar' : ''}`}>
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>
            整理<span className="sub">{counts.all} 件</span>
          </h1>
          {visible.length > 0 ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setSelected(allSelected ? new Set() : new Set(visible.map((i) => i.id)))}
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
          ) : (
            <span style={{ width: 40 }} />
          )}
        </header>
        <div className="page">
          <p className="small muted" style={{ marginTop: 0 }}>
            类别和款式是录入时按衣服轮廓自动分的，季节、场合、风格按款式填好。点衣服选中，可以一组一组地选，再在下面一次改好。
          </p>
          <div className="chips chips-scroll" role="group" aria-label="范围">
            {views.map((v) => (
              <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}>
                {VIEW_LABELS[v]}
                <span className="chip-count">{counts[v]}</span>
              </button>
            ))}
          </div>

          {groups.length === 0 ? (
            <div className="empty">
              <h2>{view === 'unverified' ? '都核对过了' : view === 'nosubtype' ? '款式都选好了' : '衣橱还是空的'}</h2>
              <p>
                {view === 'all'
                  ? '录入单品后，可以在这里按类别成批修改。'
                  : '以后录入的衣服，系统自动分完类会先出现在这里。'}
              </p>
              {view !== 'all' && counts.all > 0 && (
                <button type="button" className="btn" onClick={() => setView('all')}>
                  看全部 {counts.all} 件
                </button>
              )}
            </div>
          ) : (
            groups.map((g) => {
              const groupAll = g.items.every((i) => selected.has(i.id));
              return (
                <section key={g.category} className="group-block" aria-label={g.label}>
                  <div className="org-group-head">
                    <h2 className="group-head">
                      {g.label} <small>{g.items.length} 件</small>
                    </h2>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => toggleGroup(g)}>
                      {groupAll ? '取消这组' : `选中这组`}
                    </button>
                  </div>
                  <div className="grid">
                    {g.items.map((it) => (
                      <OrganizeTile
                        key={it.id}
                        item={it}
                        selected={selected.has(it.id)}
                        onToggle={() => toggle(it.id)}
                        onEdit={() => ui.open({ kind: 'item', id: it.id, back: { kind: 'organize', view } })}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>

      {sel.length > 0 && (
        <div className="org-bar" role="toolbar" aria-label="成批修改">
          <div className="org-bar-head">
            <strong>已选 {sel.length} 件</strong>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </div>
          <div className="chips chips-scroll">
            <button type="button" className="chip" onClick={() => setSheet('kind')}>
              改款式
            </button>
            <button type="button" className="chip" onClick={() => setSheet('seasons')}>
              季节
            </button>
            <button type="button" className="chip" onClick={() => setSheet('occasions')}>
              场合
            </button>
            <button type="button" className="chip" onClick={() => setSheet('styles')}>
              风格
            </button>
            <button type="button" className="chip" onClick={() => setSheet('warmth')}>
              保暖度
            </button>
            <button type="button" className="chip" onClick={() => setSheet('pattern')}>
              花纹
            </button>
            {anyShape && (
              <button type="button" className="chip" onClick={() => setSheet('shape')}>
                版型长度
              </button>
            )}
            {anyUnverified && (
              <button
                type="button"
                className="chip"
                onClick={() => void apply({ verify: true }, (n) => `${n} 件标为核对过了`)}
              >
                <Icon name="check" />
                没问题
              </button>
            )}
            <button type="button" className="chip chip-danger" onClick={() => void removeSelected()}>
              删除
            </button>
          </div>
        </div>
      )}

      {sheet === 'kind' && <KindSheet items={sel} onClose={() => setSheet(null)} onApply={apply} />}
      {(sheet === 'seasons' || sheet === 'occasions' || sheet === 'styles') && (
        <TagSheet tagKey={sheet} items={sel} onClose={() => setSheet(null)} onApply={apply} />
      )}
      {sheet === 'warmth' && (
        <SingleSheet<Warmth>
          title="保暖度"
          options={[1, 2, 3]}
          labels={WARMTH_LABELS}
          current={commonValue(sel, 'warmth')}
          count={sel.length}
          onClose={() => setSheet(null)}
          onApply={(v) => apply({ warmth: v }, (n) => `${n} 件的保暖度改成${WARMTH_LABELS[v]}`)}
        />
      )}
      {sheet === 'pattern' && (
        <SingleSheet<Pattern>
          title="花纹"
          options={PATTERNS}
          labels={PATTERN_LABELS}
          current={commonValue(sel, 'pattern')}
          count={sel.length}
          onClose={() => setSheet(null)}
          onApply={(v) => apply({ pattern: v }, (n) => `${n} 件的花纹改成${PATTERN_LABELS[v]}`)}
        />
      )}
      {sheet === 'shape' && <ShapeSheet items={sel} onClose={() => setSheet(null)} onApply={apply} />}
    </div>
  );
}

function OrganizeTile({ item, selected, onToggle, onEdit }: { item: Item; selected: boolean; onToggle: () => void; onEdit: () => void }) {
  return (
    <div className="org-tile">
      <button
        type="button"
        className="tile org-pick"
        aria-pressed={selected}
        aria-label={`${item.name}，${item.subtype || '款式没认出'}${item.unverified ? '，未核对' : ''}`}
        onClick={onToggle}
      >
        <ItemThumb item={item} />
        <span className="org-check" aria-hidden="true">
          {selected && <Icon name="check" />}
        </span>
        <span className="tile-name">{item.name}</span>
        <span className="tile-meta">
          {item.unverified && <span className="org-flag" aria-hidden="true" />}
          {item.subtype || '款式没认出'}
        </span>
      </button>
      <button type="button" className="org-edit" aria-label={`细改${item.name}`} onClick={onEdit}>
        <Icon name="edit" />
      </button>
    </div>
  );
}

type ApplyFn = (edit: BulkEdit, done: (n: number) => string) => Promise<void>;

const UNSURE = '__unsure';

/** 改大类和款式：按新款式重新填季节、场合、风格等，算核对过 */
function KindSheet({ items, onClose, onApply }: { items: Item[]; onClose: () => void; onApply: ApplyFn }) {
  const cats = new Set(items.map((i) => i.category));
  const subs = new Set(items.map((i) => i.subtype));
  const [cat, setCat] = useState<Category | null>(cats.size === 1 ? items[0].category : null);
  const [sub, setSub] = useState<string | null>(cats.size === 1 && subs.size === 1 ? items[0].subtype || UNSURE : null);
  const ready = !!cat && sub !== null;
  return (
    <Sheet onClose={onClose} label="改款式">
      <h2>改款式</h2>
      <p>换了款式，季节、场合、风格、保暖度和版型会按新款式重新填好，这 {items.length} 件也算核对过了。</p>
      <Field label="类别">
        <ChipSelect<Category>
          options={CATEGORIES}
          value={cat}
          labels={CATEGORY_LABELS}
          allowEmpty={false}
          onChange={(c) => {
            if (!c || c === cat) return;
            setCat(c);
            setSub(null);
          }}
        />
      </Field>
      {cat && (
        <Field label="款式">
          <ChipSelect<string>
            options={[...subtypesOf(cat), UNSURE]}
            value={sub}
            labels={{ [UNSURE]: '款式不确定' }}
            allowEmpty={false}
            onChange={(s) => s && setSub(s)}
          />
        </Field>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={() => {
            if (!cat || sub === null) return;
            const subtype = sub === UNSURE ? '' : sub;
            void onApply({ category: cat, subtype }, (n) => `${n} 件改成了${subtype || CATEGORY_LABELS[cat]}`);
          }}
        >
          {ready ? `改 ${items.length} 件` : '先选款式'}
        </button>
      </div>
    </Sheet>
  );
}

const TAG_META: Record<TagKey, { title: string; options: readonly string[]; labels: Record<string, string> }> = {
  seasons: { title: '季节', options: SEASONS, labels: SEASON_LABELS },
  occasions: { title: '场合', options: OCCASIONS, labels: OCCASION_LABELS },
  styles: { title: '风格', options: STYLES, labels: STYLE_LABELS },
};

/** 季节、场合、风格：点一下给每一件都加上，再点一下都去掉；虚线表示只有一部分有 */
function TagSheet({ tagKey, items, onClose, onApply }: { tagKey: TagKey; items: Item[]; onClose: () => void; onApply: ApplyFn }) {
  const meta = TAG_META[tagKey];
  const [override, setOverride] = useState<Record<string, 'all' | 'none'>>({});
  const state = (v: string): TriState => (v in override ? override[v] : tagState(items, tagKey, v));
  const touched = Object.keys(override).filter((v) => override[v] !== tagState(items, tagKey, v));
  return (
    <Sheet onClose={onClose} label={meta.title}>
      <h2>{meta.title}</h2>
      <p>
        点一下给选中的 {items.length} 件都加上，再点一下都去掉。
        {meta.options.some((v) => tagState(items, tagKey, v) === 'some') ? '虚线框的是只有一部分有，不点就保持原样。' : ''}
      </p>
      <div className="chips" role="group" aria-label={meta.title}>
        {meta.options.map((v) => {
          const st = state(v);
          return (
            <button
              key={v}
              type="button"
              className={`chip${st === 'some' ? ' chip-partial' : ''}`}
              aria-pressed={st === 'all' ? true : st === 'some' ? 'mixed' : false}
              onClick={() => setOverride((o) => ({ ...o, [v]: st === 'all' ? 'none' : 'all' }))}
            >
              {meta.labels[v]}
            </button>
          );
        })}
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={touched.length === 0}
          onClick={() => {
            const add = touched.filter((v) => override[v] === 'all');
            const remove = touched.filter((v) => override[v] === 'none');
            void onApply(
              { add: { [tagKey]: add }, remove: { [tagKey]: remove } } as BulkEdit,
              (n) => `改好了 ${n} 件的${meta.title}`,
            );
          }}
        >
          {touched.length ? `改 ${items.length} 件` : '还没改'}
        </button>
      </div>
    </Sheet>
  );
}

function SingleSheet<T extends string | number>({
  title,
  options,
  labels,
  current,
  count,
  onClose,
  onApply,
}: {
  title: string;
  options: readonly T[];
  labels: Record<string, string>;
  current: T | undefined;
  count: number;
  onClose: () => void;
  onApply: (v: T) => Promise<void>;
}) {
  const [value, setValue] = useState<T | undefined>(current);
  return (
    <Sheet onClose={onClose} label={title}>
      <h2>{title}</h2>
      <p>{current === undefined ? `选中的 ${count} 件现在不一样，选一个统一改成它。` : `选中的 ${count} 件现在都是${labels[String(current)]}。`}</p>
      <ChipSelect<T> options={options} value={value} labels={labels} allowEmpty={false} onChange={(v) => v !== null && setValue(v)} />
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={value === undefined || value === current}
          onClick={() => value !== undefined && void onApply(value)}
        >
          {value === undefined || value === current ? '还没改' : `改 ${count} 件`}
        </button>
      </div>
    </Sheet>
  );
}

/** 版型、长度、腰线：只改适用的单品（鞋包没有版型，上衣没有腰线） */
function ShapeSheet({ items, onClose, onApply }: { items: Item[]; onClose: () => void; onApply: ApplyFn }) {
  const [fit, setFit] = useState<Fit | undefined>(undefined);
  const [length, setLength] = useState<Length | undefined>(undefined);
  const [rise, setRise] = useState<Rise | undefined>(undefined);
  const nFit = applicableCount(items, 'fit');
  const nLength = applicableCount(items, 'length');
  const nRise = applicableCount(items, 'rise');
  const cats = new Set(items.map((i) => i.category));
  const lenLabels =
    cats.size === 1
      ? lengthLabels(items[0].category, new Set(items.map((i) => i.subtype)).size === 1 ? items[0].subtype : undefined)
      : { short: '短', regular: '常规', long: '长' };
  const scope = (n: number) => (n < items.length ? `只改其中 ${n} 件` : undefined);
  const touched = fit !== undefined || length !== undefined || rise !== undefined;
  return (
    <Sheet onClose={onClose} label="版型、长度、腰线">
      <h2>版型、长度、腰线</h2>
      <p>录入时已按款式填好。只改你点了的那一项，没点的保持原样。</p>
      {nFit > 0 && (
        <Field label="版型" hint={scope(nFit)}>
          <Segmented<Fit> options={['slim', 'regular', 'loose']} value={fit ?? commonValue(items, 'fit')} labels={FIT_LABELS} onChange={setFit} />
        </Field>
      )}
      {nLength > 0 && (
        <Field label="长度" hint={scope(nLength)}>
          <Segmented<Length> options={['short', 'regular', 'long']} value={length ?? commonValue(items, 'length')} labels={lenLabels} onChange={setLength} />
        </Field>
      )}
      {nRise > 0 && (
        <Field label="腰线" hint={scope(nRise)}>
          <Segmented<Rise> options={['high', 'mid', 'low']} value={rise ?? commonValue(items, 'rise')} labels={RISE_LABELS} onChange={setRise} />
        </Field>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!touched}
          onClick={() => void onApply({ fit, length, rise }, (n) => `改好了 ${n} 件`)}
        >
          {touched ? '确定修改' : '还没改'}
        </button>
      </div>
    </Sheet>
  );
}
