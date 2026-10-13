// 待整理：批量录入的单品先按轮廓猜了类别，在这里点一下改类别、选款式，确认后才参与推荐。

import { CATEGORIES, CATEGORY_LABELS, subtypesOf } from '../../core/catalog';
import { confirmPending, readyToConfirm, withCategory } from '../../core/pending';
import type { Category, Item } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { Icon } from '../components/Icon';
import { useStore } from '../store';
import { useUI } from '../ui';

export function Review() {
  const store = useStore();
  const ui = useUI();
  const pending = store.items.filter((i) => i.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const ready = pending.filter(readyToConfirm);

  async function change(item: Item, category: Category, subtype: string) {
    await store.saveItem(withCategory(item, category, subtype));
  }

  async function confirm(item: Item) {
    await store.saveItem(confirmPending(item, Date.now()));
  }

  async function confirmAll() {
    const now = Date.now();
    for (const it of ready) await store.saveItem(confirmPending(it, now));
    const rest = pending.length - ready.length;
    ui.toast(rest ? `已确认 ${ready.length} 件，还有 ${rest} 件没选款式` : `已确认 ${ready.length} 件，都放进衣橱了`);
  }

  async function remove(item: Item) {
    const ok = await ui.confirm({ title: `删除"${item.name}"？`, body: '这张照片拍得不好、或者不是衣服时删掉。', confirmText: '删除', danger: true });
    if (ok) await store.deleteItem(item.id);
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="待整理">
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>
            待整理<span className="sub">{pending.length ? `${pending.length} 件` : ''}</span>
          </h1>
          {ready.length > 0 ? (
            <button type="button" className="btn btn-primary btn-small" onClick={() => void confirmAll()}>
              全部确认
            </button>
          ) : (
            <span style={{ width: 40 }} />
          )}
        </header>
        <div className="page">
          {pending.length === 0 ? (
            <div className="empty">
              <h2>都整理好了</h2>
              <p>确认过的单品已经放进衣橱，会参与每天的推荐。</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => ui.open({ kind: 'batch' })}>
                  <Icon name="layers" />
                  继续批量录入
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    ui.close();
                    ui.go('wardrobe');
                  }}
                >
                  去衣橱看看
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="small muted">类别是按衣服轮廓猜的，点一下就能改；选好款式后点「确认」。颜色、季节、场合等按款式自动填好了，需要细调时点「细改」。</p>
              <div className="review-list">
                {pending.map((it) => (
                  <article key={it.id} className="review-card" aria-label={it.name}>
                    <div className="review-head">
                      <div className="review-thumb">
                        <ItemThumb item={it} className="fill" />
                      </div>
                      <div className="grow">
                        <strong>{it.name}</strong>
                        <div className="small muted review-color">
                          <span className="swatch" style={{ background: it.color.hex }} />
                          {it.color.name}
                          {it.color2 ? `、${it.color2.name}` : ''}
                        </div>
                        {it.reviewNote && <p className="small review-note">{it.reviewNote}</p>}
                      </div>
                    </div>
                    <div className="chips chips-scroll" role="group" aria-label="类别">
                      {CATEGORIES.map((c) => (
                        <button key={c} type="button" className="chip" aria-pressed={it.category === c} onClick={() => void change(it, c, '')}>
                          {CATEGORY_LABELS[c]}
                        </button>
                      ))}
                    </div>
                    <div className="chips chips-scroll" role="group" aria-label="款式">
                      {subtypesOf(it.category).map((s) => (
                        <button key={s} type="button" className="chip" aria-pressed={it.subtype === s} onClick={() => void change(it, it.category, s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <button type="button" className="btn btn-primary btn-small grow" disabled={!readyToConfirm(it)} onClick={() => void confirm(it)}>
                        <Icon name="check" />
                        {readyToConfirm(it) ? '确认' : '先选款式'}
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => ui.open({ kind: 'item', id: it.id, back: 'review' })}>
                        细改
                      </button>
                      <button type="button" className="btn btn-small btn-ghost btn-danger" aria-label={`删除${it.name}`} onClick={() => void remove(it)}>
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
