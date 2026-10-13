// 通用控件：单选/多选标签、分段选择、开关、底部弹层。

import { useEffect, type ReactNode } from 'react';

export function ChipSelect<T extends string | number>({
  options,
  value,
  onChange,
  labels,
  scroll,
  allowEmpty = true,
  suggested,
}: {
  options: readonly T[];
  value: T | null | undefined;
  onChange: (v: T | null) => void;
  labels: Record<string, string>;
  scroll?: boolean;
  allowEmpty?: boolean;
  suggested?: readonly T[];
}) {
  return (
    <div className={`chips${scroll ? ' chips-scroll' : ''}`} role="group">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          className={`chip${suggested?.includes(o) && value !== o ? ' chip-suggested' : ''}`}
          aria-pressed={value === o}
          onClick={() => onChange(value === o && allowEmpty ? null : o)}
        >
          {labels[String(o)] ?? String(o)}
        </button>
      ))}
    </div>
  );
}

export function ChipMulti<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: readonly T[];
  onChange: (v: T[]) => void;
  labels: Record<string, string>;
}) {
  return (
    <div className="chips" role="group">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
          >
            {labels[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T | undefined;
  onChange: (v: T) => void;
  labels: Record<string, string>;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>
          {labels[String(o)]}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="switch">
      <span>
        {label}
        {hint && (
          <>
            <br />
            <span className="field-hint">{hint}</span>
          </>
        )}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)} />
    </label>
  );
}

export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-scrim fade-in" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
