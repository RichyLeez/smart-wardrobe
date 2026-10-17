// 界面层状态：当前标签页、全屏覆盖层、提示条和确认框。

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OrganizeView } from '../core/organize';
import type { Occasion, Placement, RecordSource, Styling, WearRecord } from '../core/types';
import { Sheet } from './components/Controls';

export type Tab = 'today' | 'wardrobe' | 'builder' | 'records';
const TABS: Tab[] = ['today', 'wardrobe', 'builder', 'records'];

export interface RecordDraft {
  record?: WearRecord;
  itemIds?: string[];
  layout?: Record<string, Placement>;
  styling?: Styling;
  outfitId?: string;
  occasion?: Occasion | null;
  tempC?: number;
  date?: string;
  source: RecordSource;
}

export type Overlay = (
  /** back：从整理页打开的单品，关掉后回到整理页 */
  | { kind: 'item'; id: string | null; back?: { kind: 'organize'; view?: OrganizeView } }
  | { kind: 'organize'; view?: OrganizeView }
  | { kind: 'record'; draft: RecordDraft }
  | { kind: 'settings' }
  | { kind: 'view3d'; itemIds: string[]; layout?: Record<string, Placement>; styling?: Styling; title?: string }
  | { kind: 'match'; itemId: string }
) & {
  /** 每次打开时生成，用作组件 key，保证重新打开时是全新状态 */
  nonce?: number;
};

export interface BuilderSeed {
  itemIds: string[];
  layout?: Record<string, Placement>;
  styling?: Styling;
  outfitId?: string;
}

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText: string;
  danger?: boolean;
}

interface ToastState {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export interface UIApi {
  tab: Tab;
  go(tab: Tab): void;
  overlay: Overlay | null;
  open(o: Overlay): void;
  close(): void;
  toast(text: string, action?: { label: string; run: () => void }): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  builderSeed: BuilderSeed | null;
  sendToBuilder(seed: BuilderSeed): void;
  takeBuilderSeed(): BuilderSeed | null;
}

const UIContext = createContext<UIApi | null>(null);

export function useUI(): UIApi {
  const u = useContext(UIContext);
  if (!u) throw new Error('UIProvider 缺失');
  return u;
}

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#\/?/, '');
  return (TABS as string[]).includes(h) ? (h as Tab) : 'today';
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toastState, setToast] = useState<ToastState | null>(null);
  const [confirmState, setConfirm] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [builderSeed, setBuilderSeed] = useState<BuilderSeed | null>(null);
  const seedRef = useRef<BuilderSeed | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((t: Tab) => {
    setTab(t);
    try {
      history.replaceState(null, '', `#${t}`);
    } catch {
      /* 某些嵌入环境不允许修改地址 */
    }
    window.scrollTo({ top: 0 });
  }, []);

  const toast = useCallback((text: string, action?: { label: string; run: () => void }) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, action });
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 5000 : 2600);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ ...opts, resolve })),
    [],
  );

  const api: UIApi = {
    tab,
    go,
    overlay,
    open: (o) => setOverlay({ ...o, nonce: Date.now() }),
    close: () => setOverlay(null),
    toast,
    confirm,
    builderSeed,
    sendToBuilder(seed) {
      seedRef.current = seed;
      setBuilderSeed(seed);
      setOverlay(null);
      go('builder');
    },
    takeBuilderSeed() {
      const s = seedRef.current;
      seedRef.current = null;
      if (s) setBuilderSeed(null);
      return s;
    },
  };

  const finishConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirm(null);
  };

  return (
    <UIContext.Provider value={api}>
      {children}
      {toastState && (
        <div className="toast fade-in" role="status" key={toastState.id}>
          <span>{toastState.text}</span>
          {toastState.action && (
            <button
              type="button"
              onClick={() => {
                toastState.action?.run();
                setToast(null);
              }}
            >
              {toastState.action.label}
            </button>
          )}
        </div>
      )}
      {confirmState && (
        <Sheet onClose={() => finishConfirm(false)} label={confirmState.title}>
          <h2>{confirmState.title}</h2>
          {confirmState.body && <p>{confirmState.body}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => finishConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className={`btn ${confirmState.danger ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => finishConfirm(true)}
            >
              {confirmState.confirmText}
            </button>
          </div>
        </Sheet>
      )}
    </UIContext.Provider>
  );
}
