// 小组件：单品缩略图、卷尺评分、理由列表、评分明细。

import { useMemo } from 'react';
import { PART_KEYS, PART_LABELS, outfitPalette, type OutfitEvaluation } from '../../core/recommend';
import { canToggleOpen, canTuck, isOpen, isTucked, toggleStyling } from '../../core/styling';
import type { Item, Note, Styling } from '../../core/types';
import { useImageUrl } from '../store';
import { Icon } from './Icon';

export function ItemThumb({ item, swap, className }: { item: Item; swap?: boolean; className?: string }) {
  const url = useImageUrl(item.images.thumb);
  return (
    <div className={`thumb${className ? ' ' + className : ''}`}>
      {url ? <img src={url} alt="" loading="lazy" /> : null}
      {swap && (
        <span className="swap" aria-hidden="true">
          <Icon name="swap" />
        </span>
      )}
    </div>
  );
}

/** 卷尺：0–100 的刻度，指针停在得分处 */
export function ScoreTape({ score }: { score: number }) {
  const labels = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const pos = Math.max(3, Math.min(97, score));
  return (
    <div className="tape" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label={`搭配得分 ${score}`}>
      {labels.map((l) => (
        <span key={l} className="tape-label" style={{ left: `${l}%` }}>
          {l}
        </span>
      ))}
      <span className="tape-marker" style={{ left: `${pos}%` }}>
        <b>{score}</b>
      </span>
    </div>
  );
}

const MARKS: Record<Note['kind'], string> = { good: '✓', warn: '!', info: '·' };

export function NoteList({ notes }: { notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map((n, i) => (
        <li key={i} className={n.kind}>
          <span className="mark" aria-label={n.kind === 'good' ? '优点' : n.kind === 'warn' ? '注意' : '提示'}>
            {MARKS[n.kind]}
          </span>
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function PartBars({ evaluation }: { evaluation: OutfitEvaluation }) {
  return (
    <div className="parts">
      {PART_KEYS.map((k) => {
        const v = Math.round(evaluation.parts[k].score * 100);
        return (
          <div key={k} style={{ display: 'contents' }}>
            <span>{PART_LABELS[k]}</span>
            <span className="bar">
              <i style={{ width: `${v}%` }} />
            </span>
            <span className="val">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 色板：按视觉面积排出这一套的颜色，并说明配色方式 */
export function PaletteBar({ items, styling }: { items: Item[]; styling?: Styling }) {
  const pal = useMemo(() => outfitPalette(items, styling), [items, styling]);
  if (pal.swatches.length === 0) return null;
  return (
    <div className="palette-bar" role="img" aria-label={`配色：${pal.scheme}`}>
      <div className="palette-strip">
        {pal.swatches.map((s) => (
          <span key={s.name} style={{ background: s.hex, flexGrow: Math.max(0.04, s.share) }} />
        ))}
      </div>
      <div className="palette-meta">
        <strong>{pal.scheme}</strong>
        <span>{pal.swatches.slice(0, 4).map((s) => `${s.name} ${Math.round(s.share * 100)}%`).join('、')}</span>
      </div>
    </div>
  );
}

/**
 * 穿法开关：上衣塞进下装、外套敞开。只显示这一套能用的开关；
 * 照片本身就是敞开的外套显示为已敞开、不能切换。
 */
export function StylingChips({ items, styling, onChange }: { items: Item[]; styling: Styling | undefined; onChange: (s: Styling) => void }) {
  const top = items.find((i) => i.category === 'top');
  const bottom = items.find((i) => i.category === 'bottom');
  const outer = items.find((i) => i.category === 'outer');
  const tuckable = top && canTuck(top, bottom);
  const openToggle = outer && canToggleOpen(outer);
  const openFixed = outer && outer.photoOpen;
  if (!tuckable && !openToggle && !openFixed) return null;
  const intoSkirt = bottom && /裙/.test(bottom.subtype);
  return (
    <div className="styling-row" role="group" aria-label="穿法">
      <span className="small muted">穿法</span>
      {tuckable && top && (
        <button
          type="button"
          className="chip"
          aria-pressed={isTucked(top, items, styling)}
          onClick={() => onChange(toggleStyling(styling, 'tucked', top.id))}
        >
          {intoSkirt ? '塞进裙腰' : '塞进裤腰'}
        </button>
      )}
      {outer && (openToggle || openFixed) && (
        <button
          type="button"
          className="chip"
          aria-pressed={isOpen(outer, styling)}
          disabled={!openToggle}
          title={openFixed ? '这件外套拍的时候就是敞开的' : undefined}
          onClick={() => onChange(toggleStyling(styling, 'open', outer.id))}
        >
          {openFixed ? '外套敞开（照片）' : '外套敞开'}
        </button>
      )}
    </div>
  );
}
