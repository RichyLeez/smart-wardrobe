// 小组件：单品缩略图、卷尺评分、理由列表、评分明细。

import { PART_KEYS, PART_LABELS, type OutfitEvaluation } from '../../core/recommend';
import type { Item, Note } from '../../core/types';
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
