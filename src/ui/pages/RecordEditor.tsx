// 穿搭记录编辑：日期、单品、场合、上身照、备注。

import { useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, OCCASIONS, OCCASION_LABELS } from '../../core/catalog';
import type { Item, Occasion, WearRecord } from '../../core/types';
import { ItemThumb } from '../components/Bits';
import { ChipSelect, Field } from '../components/Controls';
import { Icon } from '../components/Icon';
import { canvasToBlob, loadPhoto } from '../imageTools';
import { newId, useImageUrl, useStore, type NewImage } from '../store';
import { useUI, type RecordDraft } from '../ui';

export function RecordEditor({ draft }: { draft: RecordDraft }) {
  const store = useStore();
  const ui = useUI();
  const existing = draft.record ? store.records.find((r) => r.id === draft.record!.id) ?? draft.record : undefined;
  const [date, setDate] = useState(existing?.date ?? draft.date ?? store.today.date);
  const [ids, setIds] = useState<string[]>(existing?.itemIds ?? draft.itemIds ?? []);
  const [occasion, setOccasion] = useState<Occasion | null>(existing?.occasion ?? draft.occasion ?? null);
  const [temp, setTemp] = useState<string>(
    existing?.tempC !== undefined ? String(existing.tempC) : draft.tempC !== undefined ? String(draft.tempC) : '',
  );
  const [note, setNote] = useState(existing?.note ?? '');
  const [photo, setPhoto] = useState<NewImage | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const existingPhotoUrl = useImageUrl(existing?.photo);

  const active = store.items.filter((i) => i.status === 'active' || ids.includes(i.id));
  const groups = useMemo(
    () => CATEGORIES.map((c) => ({ c, items: active.filter((i) => i.category === c) })).filter((g) => g.items.length),
    [active],
  );

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const p = await loadPhoto(file, 64, 1280);
      const blob = await canvasToBlob(p.archive, 'image/jpeg', 0.85);
      setPhoto({ id: newId('img-'), blob, width: p.archive.width, height: p.archive.height });
      setPhotoPreview(p.archive.toDataURL('image/jpeg', 0.7));
      setRemovePhoto(false);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : '照片读取失败');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (ids.length === 0 && !photo && !existing?.photo) return ui.toast('至少选择一件单品或添加一张照片');
    setBusy(true);
    try {
      const now = Date.now();
      const chosen = ids.map((id) => store.items.find((i) => i.id === id)).filter((i): i is Item => !!i);
      // 已删除单品的快照保留下来
      const keptSnapshots = (existing?.itemSnapshots ?? []).filter((s) => ids.includes(s.id) && !chosen.some((i) => i.id === s.id));
      const t = temp.trim() === '' ? undefined : Number(temp);
      const rec: WearRecord = {
        id: existing?.id ?? newId('rec-'),
        date,
        itemIds: ids,
        itemSnapshots: [
          ...chosen.map((i) => ({ id: i.id, name: i.name, category: i.category, colorHex: i.color.hex })),
          ...keptSnapshots,
        ],
        outfitId: existing?.outfitId ?? draft.outfitId,
        layout: existing?.layout ?? draft.layout,
        occasion: occasion ?? undefined,
        tempC: t !== undefined && Number.isFinite(t) ? t : undefined,
        note: note.trim() || undefined,
        photo: photo ? photo.id : removePhoto ? undefined : existing?.photo,
        source: existing?.source ?? draft.source,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        demo: existing?.demo,
      };
      const replaced = existing?.photo && (photo || removePhoto) ? existing.photo : undefined;
      await store.saveRecord(rec, photo ?? undefined, replaced);
      ui.toast(existing ? '记录已更新' : '已添加记录');
      ui.close();
    } catch (e) {
      ui.toast(e instanceof Error ? `保存失败：${e.message}` : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  const shownPhoto = photoPreview ?? (removePhoto ? null : existingPhotoUrl);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={existing ? '编辑记录' : '补记穿搭'}>
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>{existing ? '编辑记录' : '补记穿搭'}</h1>
          <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={save}>
            保存
          </button>
        </header>
        <div className="page">
          <Field label="日期">
            <input className="input" type="date" value={date} max={store.today.date} onChange={(e: React.ChangeEvent<HTMLInputElement>) => e.target.value && setDate(e.target.value)} />
          </Field>
          <Field label="上身照片" hint="真实效果以照片为准">
            {shownPhoto ? (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <img src={shownPhoto} alt="上身照片预览" style={{ width: 120, borderRadius: 'var(--r-m)' }} />
                <button
                  type="button"
                  className="btn btn-small btn-ghost btn-danger"
                  onClick={() => {
                    setPhoto(null);
                    setPhotoPreview(null);
                    setRemovePhoto(true);
                  }}
                >
                  移除照片
                </button>
              </div>
            ) : (
              <label className="btn" style={{ justifySelf: 'start' }}>
                <Icon name="camera" />
                {busy ? '正在读取…' : '添加照片'}
                <input type="file" accept="image/*" hidden onChange={(e: React.ChangeEvent<HTMLInputElement>) => onPhoto(e.target.files?.[0])} />
              </label>
            )}
          </Field>
          <Field label="场合">
            <ChipSelect<Occasion> options={OCCASIONS} value={occasion} labels={OCCASION_LABELS} onChange={setOccasion} />
          </Field>
          <Field label="气温">
            <div className="input-unit" style={{ maxWidth: 160 }}>
              <input className="input" type="number" inputMode="numeric" value={temp} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTemp(e.target.value)} aria-label="气温" />
              <span>°C</span>
            </div>
          </Field>
          <Field label="穿了哪些单品" hint={`已选 ${ids.length} 件`}>
            {groups.length === 0 && <span className="muted small">衣橱里还没有单品。</span>}
            {groups.map(({ c, items }) => (
              <div key={c} style={{ display: 'grid', gap: 6 }}>
                <span className="small muted">{CATEGORY_LABELS[c]}</span>
                <div className="select-grid">
                  {items.map((i) => {
                    const on = ids.includes(i.id);
                    return (
                      <button
                        key={i.id}
                        type="button"
                        className="pick"
                        aria-pressed={on}
                        onClick={() => setIds(on ? ids.filter((x) => x !== i.id) : [...ids, i.id])}
                      >
                        <ItemThumb item={i} />
                        <span>{i.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </Field>
          <Field label="备注">
            <textarea className="input" value={note} placeholder="例如：这套走路很舒服；裤长偏长" onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)} />
          </Field>
          <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={busy} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
