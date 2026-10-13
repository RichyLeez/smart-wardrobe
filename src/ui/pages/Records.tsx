// 记录：月历、当天的穿搭、穿着统计与闲置提醒。

import { useMemo, useState } from 'react';
import { MAIN_CATEGORIES, OCCASION_LABELS } from '../../core/catalog';
import { idleItems, recordsInMonth, wearStats } from '../../core/stats';
import type { Item, WearRecord } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { Icon } from '../components/Icon';
import { Mannequin } from '../components/Mannequin';
import { useImageUrl, useStore } from '../store';
import { useUI } from '../ui';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function RecordsPage() {
  const store = useStore();
  const ui = useUI();
  const [ty, tm] = store.today.date.split('-').map(Number);
  const [month, setMonth] = useState<{ y: number; m: number }>({ y: ty, m: tm });
  const [selected, setSelected] = useState(store.today.date);
  const stats = useMemo(() => wearStats(store.records), [store.records]);
  const byDate = useMemo(() => {
    const map = new Map<string, WearRecord[]>();
    for (const r of store.records) map.set(r.date, [...(map.get(r.date) ?? []), r]);
    return map;
  }, [store.records]);

  const first = new Date(month.y, month.m - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysIn = new Date(month.y, month.m, 0).getDate();
  const cells: Array<string | null> = [...Array(offset).fill(null), ...Array.from({ length: daysIn }, (_, i) => ymd(month.y, month.m, i + 1))];
  while (cells.length % 7) cells.push(null);

  const monthRecords = recordsInMonth(store.records, month.y, month.m);
  const monthDays = new Set(monthRecords.map((r) => r.date)).size;
  const dayRecords = byDate.get(selected) ?? [];
  const active = store.items.filter((i) => i.status === 'active');
  const top = active
    .map((i) => ({ item: i, count: stats.get(i.id)?.count ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const idle = idleItems(store.items, stats, store.today.date, 30);
  const neverWorn = active.filter((i) => !stats.has(i.id)).length;
  const usage = active.length ? Math.round(((active.length - neverWorn) / active.length) * 100) : 0;

  const shift = (delta: number) =>
    setMonth(({ y, m }) => {
      const d = new Date(y, m - 1 + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    });

  async function remove(r: WearRecord) {
    const ok = await ui.confirm({ title: '删除这条记录？', body: '相关单品的穿着次数会随之更新。', confirmText: '删除', danger: true });
    if (!ok) return;
    await store.deleteRecord(r.id);
    ui.toast('记录已删除');
  }

  return (
    <>
      <header className="topbar">
        <h1>记录</h1>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => ui.open({ kind: 'record', draft: { date: selected, source: 'manual' } })}
        >
          <Icon name="plus" />
          补记
        </button>
      </header>
      <div className="page">
        <div className="month-nav">
          <button type="button" className="icon-btn" aria-label="上个月" onClick={() => shift(-1)}>
            <Icon name="back" />
          </button>
          <h2>
            {month.y}年{month.m}月
          </h2>
          <button type="button" className="icon-btn" aria-label="下个月" onClick={() => shift(1)} style={{ transform: 'scaleX(-1)' }}>
            <Icon name="back" />
          </button>
        </div>
        <div className="calendar" role="grid" aria-label={`${month.y}年${month.m}月穿搭日历`}>
          {DOW.map((d) => (
            <div key={d} className="dow" role="columnheader">
              {d}
            </div>
          ))}
          {cells.map((date, i) => {
            if (!date) return <div key={`x${i}`} className="day other" aria-hidden="true" />;
            const recs = byDate.get(date) ?? [];
            const colors = recs
              .flatMap((r) => r.itemSnapshots.filter((s) => MAIN_CATEGORIES.includes(s.category)).map((s) => s.colorHex))
              .slice(0, 3);
            return (
              <button
                key={date}
                type="button"
                className={`day${date === store.today.date ? ' today' : ''}`}
                aria-pressed={date === selected}
                aria-label={`${Number(date.slice(8))}日${recs.length ? `，${recs.length} 条记录` : ''}`}
                onClick={() => setSelected(date)}
              >
                <span>{Number(date.slice(8))}</span>
                <span className="dotset">
                  {colors.map((c, k) => (
                    <i key={k} style={{ background: c }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <section className="section">
          <h2 className="section-title">
            {Number(selected.slice(5, 7))}月{Number(selected.slice(8))}日
            <small>{dayRecords.length ? `${dayRecords.length} 条` : '没有记录'}</small>
          </h2>
          {dayRecords.length === 0 && (
            <button type="button" className="callout" onClick={() => ui.open({ kind: 'record', draft: { date: selected, source: 'manual' } })}>
              <Icon name="plus" />
              <span>补记这一天穿了什么</span>
            </button>
          )}
          {dayRecords.map((r) => (
            <RecordCard key={r.id} record={r} items={store.items} onEdit={() => ui.open({ kind: 'record', draft: { record: r, source: r.source } })} onDelete={() => remove(r)} />
          ))}
        </section>

        <section className="section">
          <h2 className="section-title">
            穿着统计 <small>本月记录 {monthDays} 天</small>
          </h2>
          <div className="panel">
            <div className="kv">
              <span>穿过的单品占比</span>
              <b>{usage}%</b>
            </div>
            <div className="kv">
              <span>还没穿过</span>
              <b>{neverWorn} 件</b>
            </div>
          </div>
          {top.length > 0 && (
            <>
              <h3 className="small muted" style={{ margin: '16px 0 4px', fontWeight: 400 }}>
                穿得最多
              </h3>
              {top.map(({ item, count }) => (
                <div key={item.id} className="rank">
                  <ItemThumb item={item} />
                  <span>{item.name}</span>
                  <span>
                    <b>{count}</b> 次
                  </span>
                </div>
              ))}
            </>
          )}
          {idle.length > 0 && (
            <>
              <h3 className="small muted" style={{ margin: '16px 0 4px', fontWeight: 400 }}>
                超过 30 天没穿
              </h3>
              {idle.slice(0, 8).map(({ item, days }) => (
                <button key={item.id} type="button" className="rank" style={{ width: '100%', border: 0, background: 'none', textAlign: 'left' }} onClick={() => ui.open({ kind: 'item', id: item.id })}>
                  <ItemThumb item={item} />
                  <span>{item.name}</span>
                  <span className="muted">{days === null ? '从未穿过' : `${days} 天`}</span>
                </button>
              ))}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function RecordCard({ record, items, onEdit, onDelete }: { record: WearRecord; items: Item[]; onEdit: () => void; onDelete: () => void }) {
  const store = useStore();
  const photo = useImageUrl(record.photo);
  const its = record.itemIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
  const missing = record.itemSnapshots.filter((s) => !items.some((i) => i.id === s.id));
  return (
    <article className="record">
      {photo ? (
        <img className="photo" src={photo} alt="上身照片" />
      ) : (
        <div className="stage">
          <Mannequin body={store.settings.body} items={its} layout={record.layout} />
        </div>
      )}
      <div>
        <h3>{record.occasion ? OCCASION_LABELS[record.occasion] : '日常'}</h3>
        <div className="meta">
          {record.tempC !== undefined ? `${record.tempC}°C ` : ''}
          {record.source === 'recommend' ? '来自推荐' : record.source === 'builder' ? '来自试搭' : '手动记录'}
        </div>
        <div className="items">
          {record.itemSnapshots.map((s) => s.name).join('、')}
          {missing.length > 0 && <span className="muted">（{missing.length} 件已删除）</span>}
        </div>
        {record.note && <div className="small">{record.note}</div>}
        <div className="row" style={{ marginTop: 6 }}>
          <button type="button" className="btn btn-small" onClick={onEdit}>
            <Icon name="edit" />
            编辑
          </button>
          <button type="button" className="btn btn-small btn-ghost btn-danger" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </article>
  );
}
