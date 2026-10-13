// 这件怎么搭：以一件单品为中心，按今天的气温和场合给出几套搭配，并说明配色、面料、风格上的理由。

import { useMemo, useState } from 'react';
import { OCCASION_LABELS } from '../../core/catalog';
import { applyFeedback, recommend, summarizeNotes, type OutfitEvaluation, type RecommendContext } from '../../core/recommend';
import { ItemThumb, NoteList, PaletteBar, PartBars, ScoreTape } from '../components/Bits';
import { Icon } from '../components/Icon';
import { Mannequin } from '../components/Mannequin';
import { newId, useStore } from '../store';
import { useUI } from '../ui';
import { snapshotRecord } from './Today';

export function MatchPage({ itemId }: { itemId: string }) {
  const store = useStore();
  const ui = useUI();
  const { items, records, feedback, settings, today, goals } = store;
  const item = items.find((i) => i.id === itemId);
  const [exclude, setExclude] = useState<string[]>([]);
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [openParts, setOpenParts] = useState<number | null>(null);

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
    [items, today, goals, records, feedback, settings.rotation],
  );
  const result = useMemo(() => recommend(ctx, { pinned: [itemId], exclude, seed }), [ctx, itemId, exclude, seed]);

  async function wear(o: OutfitEvaluation) {
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
    ui.close();
    ui.go('today');
    ui.toast('已记为今天的穿搭');
  }

  function more() {
    setExclude((prev) => [...prev, ...result.outfits.map((o) => o.signature)]);
    setSeed(Math.floor(Math.random() * 1e6));
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="这件怎么搭">
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>这件怎么搭</h1>
          <span style={{ width: 40 }} />
        </header>
        <div className="page">
          {!item ? (
            <p className="muted">这件单品已经被删除了。</p>
          ) : (
            <>
              <div className="match-head">
                <div className="match-thumb">
                  <ItemThumb item={item} className="fill" />
                </div>
                <div>
                  <strong>{item.name}</strong>
                  <p className="small muted">
                    按今天 {today.weather.tempC}°C{today.occasion ? `、${OCCASION_LABELS[today.occasion]}` : ''} 来搭，综合配色、面料、风格、版型、天气和场合打分。
                  </p>
                </div>
              </div>
              {result.outfits.length === 0 && <NoteList notes={result.notes} />}
              {result.outfits.map((o, idx) => (
                <article className="match-card" key={o.signature} aria-label={`搭配 ${idx + 1}，${o.score} 分`}>
                  <div className="stage">
                    <Mannequin body={settings.body} items={o.items} animate />
                  </div>
                  <ScoreTape score={o.score} />
                  <PaletteBar items={o.items} />
                  <p className="small match-items">{o.items.map((i) => i.name).join('、')}</p>
                  <NoteList notes={summarizeNotes(o)} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    style={{ paddingLeft: 0 }}
                    aria-expanded={openParts === idx}
                    onClick={() => setOpenParts(openParts === idx ? null : idx)}
                  >
                    {openParts === idx ? '收起评分明细' : '查看评分明细'}
                  </button>
                  {openParts === idx && <PartBars evaluation={o} />}
                  <div className="row" style={{ marginTop: 10 }}>
                    <button type="button" className="btn btn-primary grow" onClick={() => wear(o)}>
                      <Icon name="check" />
                      就穿这套
                    </button>
                    <button type="button" className="btn" onClick={() => ui.sendToBuilder({ itemIds: o.items.map((i) => i.id) })}>
                      去试搭调整
                    </button>
                  </div>
                </article>
              ))}
              {result.outfits.length > 0 && (
                <>
                  {result.notes.length > 0 && <NoteList notes={result.notes} />}
                  <button type="button" className="btn btn-ghost btn-block" onClick={more}>
                    <Icon name="refresh" />
                    换一批
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
