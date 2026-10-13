// 应用状态：启动时选择存储（云端或本机，见 storage/db.ts），把全部数据载入内存（个人衣橱规模很小），
// 所有修改先写入存储，成功后再更新界面。

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { itemImageIds } from '../core/backup';
import { suggestGoals } from '../core/body';
import { hoodTop } from '../core/hood';
import { emptyFeedback } from '../core/recommend';
import { todayStr } from '../core/stats';
import type {
  BodyGoal,
  FeedbackState,
  Item,
  Occasion,
  Outfit,
  Settings,
  WearRecord,
  WeatherInput,
} from '../core/types';
import * as db from '../storage/db';
import { renderDemoImage } from './demo';
import { FLAT_PREFIX, OPEN_PREFIX, renderFlat, renderOpen } from './flatImage';
import { newId } from './ids';
import { createCanvas, loadImageElement } from './imageTools';

export { newId };

export interface TodayWeather extends WeatherInput {
  source: 'manual' | 'auto' | 'stale';
  code?: number;
  place?: string;
  fetchedAt?: number;
}

export interface TodayState {
  date: string;
  weather: TodayWeather;
  occasion: Occasion | null;
}

export interface NewImage {
  id: string;
  blob: Blob;
  width: number;
  height: number;
}

export const DEFAULT_SETTINGS: Settings = {
  body: null,
  goals: [],
  goalsCustomized: false,
  rotation: true,
};

function defaultToday(): TodayState {
  return { date: todayStr(), weather: { tempC: 20, rain: false, source: 'manual' }, occasion: null };
}

export interface AppData {
  items: Item[];
  outfits: Outfit[];
  records: WearRecord[];
  settings: Settings;
  feedback: FeedbackState;
  today: TodayState;
}

export interface Store extends AppData {
  ready: boolean;
  error: string | null;
  /** 数据存在哪里：云端 / 本机浏览器 / 内存 */
  storage: db.StorageInfo | null;
  /** 启动进度；slow 表示已经等了比较久 */
  boot: { stage: db.BootStage; slow: boolean };
  /** 云端迟迟连不上时，改为先把数据存在这个浏览器里 */
  switchToLocal(): Promise<void>;
  goals: BodyGoal[];
  saveItem(item: Item, images?: NewImage[], replacedImageIds?: string[]): Promise<void>;
  deleteItem(id: string): Promise<void>;
  saveOutfit(o: Outfit): Promise<void>;
  deleteOutfit(id: string): Promise<void>;
  saveRecord(r: WearRecord, photo?: NewImage, replacedPhotoId?: string): Promise<void>;
  deleteRecord(id: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setFeedback(fb: FeedbackState): Promise<void>;
  setToday(patch: Partial<TodayState>): Promise<void>;
  /** 用新数据整体替换（导入备份、清空、载入示例后调用） */
  reload(): Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreProvider 缺失');
  return s;
}

// ---------- 图片 URL 缓存 ----------

const urlCache = new Map<string, string>();
/** 需要在不用时释放的临时 blob 地址 */
const revocable = new Set<string>();
const pending = new Map<string, Promise<string | undefined>>();
const listeners = new Set<() => void>();

export function imageUrlSync(id: string | undefined): string | undefined {
  return id ? urlCache.get(id) : undefined;
}

async function resolveImage(id: string): Promise<{ url: string; revoke: boolean } | undefined> {
  if (id.startsWith(FLAT_PREFIX)) {
    const base = await loadImageUrl(id.slice(FLAT_PREFIX.length));
    if (!base) return undefined;
    return { url: URL.createObjectURL(await renderFlat(base)), revoke: true };
  }
  if (id.startsWith(OPEN_PREFIX)) {
    const base = await loadImageUrl(id.slice(OPEN_PREFIX.length));
    if (!base) return undefined;
    return { url: URL.createObjectURL(await renderOpen(base)), revoke: true };
  }
  if (db.isVirtualImage(id)) {
    const blob = await renderDemoImage(id);
    return blob ? { url: URL.createObjectURL(blob), revoke: true } : undefined;
  }
  return db.imageSrc(id);
}

export function loadImageUrl(id: string): Promise<string | undefined> {
  const cached = urlCache.get(id);
  if (cached) return Promise.resolve(cached);
  let p = pending.get(id);
  if (!p) {
    p = resolveImage(id)
      .then((src) => {
        if (!src) return undefined;
        urlCache.set(id, src.url);
        if (src.revoke) revocable.add(id);
        listeners.forEach((l) => l());
        return src.url;
      })
      .catch(() => undefined)
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

function forgetImages(ids: string[]): void {
  for (const id of ids.flatMap((x) => [x, FLAT_PREFIX + x, OPEN_PREFIX + x, FLAT_PREFIX + OPEN_PREFIX + x])) {
    const u = urlCache.get(id);
    if (u && revocable.has(id)) URL.revokeObjectURL(u);
    revocable.delete(id);
    urlCache.delete(id);
  }
}

export function forgetAllImages(): void {
  forgetImages([...urlCache.keys()]);
}

/** 读取图片地址；首次读取时异步加载，加载完成后组件自动刷新 */
export function useImageUrl(id: string | undefined): string | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!id || urlCache.has(id)) return;
    let alive = true;
    loadImageUrl(id).then(() => alive && setTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, [id]);
  return imageUrlSync(id);
}

/** 批量预加载，返回已就绪的 id → url 映射 */
export function useImageUrls(ids: string[]): Record<string, string> {
  const [, setTick] = useState(0);
  const key = ids.join(',');
  useEffect(() => {
    let alive = true;
    const missing = ids.filter((id) => !urlCache.has(id));
    if (missing.length === 0) return;
    Promise.all(missing.map(loadImageUrl)).then(() => alive && setTick((t) => t + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const out: Record<string, string> = {};
  for (const id of ids) {
    const u = urlCache.get(id);
    if (u) out[id] = u;
  }
  return out;
}

// ---------- Provider ----------

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>({
    items: [],
    outfits: [],
    records: [],
    settings: DEFAULT_SETTINGS,
    feedback: emptyFeedback(),
    today: defaultToday(),
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<db.StorageInfo | null>(null);
  const [boot, setBoot] = useState<{ stage: db.BootStage; slow: boolean }>({ stage: 'start', slow: false });
  const booted = useRef(false);
  // 异步操作读取最新数据，避免连续两次修改时互相覆盖
  const latest = useRef(data);
  latest.current = data;

  async function loadAll(): Promise<void> {
    const [items, outfits, records, settings, feedback, today] = await Promise.all([
      db.getAll<Item>('items'),
      db.getAll<Outfit>('outfits'),
      db.getAll<WearRecord>('records'),
      db.getKV<Settings>('settings'),
      db.getKV<FeedbackState>('feedback'),
      db.getKV<TodayState>('today'),
    ]);
    let t = today ?? defaultToday();
    if (t.date !== todayStr()) {
      t = {
        ...t,
        date: todayStr(),
        weather: { tempC: t.weather.tempC, rain: false, source: 'stale' },
      };
    }
    setData({
      items: items.sort((a, b) => b.createdAt - a.createdAt),
      outfits: outfits.sort((a, b) => b.updatedAt - a.updatedAt),
      records: records.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1)),
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      feedback: feedback ?? emptyFeedback(),
      today: t,
    });
  }

  useEffect(() => {
    // 等了 8 秒还没打开，就在页面上给出说明和"先用本机模式"的选项
    const slowTimer = window.setTimeout(() => setBoot((b) => ({ ...b, slow: true })), 8000);
    (async () => {
      const info = await db.initStorage((stage) => {
        if (!booted.current) setBoot((b) => ({ ...b, stage }));
      });
      if (booted.current) return;
      booted.current = true;
      setStorage(info);
      setBoot((b) => ({ ...b, stage: 'loading' }));
      await loadAll();
      setReady(true);
    })().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setReady(true);
    });
    return () => window.clearTimeout(slowTimer);
  }, []);

  // 云端模式：页面从后台回到前台时重新读取，拿到在其他设备上做的修改
  useEffect(() => {
    if (storage?.mode !== 'cloud') return;
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > 20_000) {
        hiddenAt = 0;
        loadAll().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage?.mode]);

  // 以前录入的上衣、外套还没量过帽子：打开后在后台补量一次（量过的记为数字，没帽子记 0）
  const hoodsMeasured = useRef(false);
  useEffect(() => {
    if (!ready || hoodsMeasured.current) return;
    hoodsMeasured.current = true;
    const todo = latest.current.items.filter(
      (i) => (i.category === 'top' || i.category === 'outer') && i.hoodTop === undefined && !db.isVirtualImage(i.images.cutout),
    );
    if (!todo.length) return;
    (async () => {
      for (const item of todo) {
        const url = await loadImageUrl(item.images.cutout);
        if (!url) continue;
        const img = await loadImageElement(url);
        const c = createCanvas(img.naturalWidth, img.naturalHeight);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const alpha = new Uint8Array(c.width * c.height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
        const t = Math.round(hoodTop(alpha, c.width, c.height) * 1000) / 1000;
        // 这期间用户可能改过这件，以最新的为准，只补上帽子
        const cur = latest.current.items.find((i) => i.id === item.id);
        if (!cur || cur.hoodTop !== undefined) continue;
        const next = { ...cur, hoodTop: t };
        await db.put('items', next);
        setData((dd) => ({ ...dd, items: dd.items.map((i) => (i.id === next.id ? next : i)) }));
        await new Promise((r) => setTimeout(r, 30));
      }
    })().catch(() => undefined);
  }, [ready]);

  const goals = useMemo<BodyGoal[]>(() => {
    const s = data.settings;
    if (s.goalsCustomized || !s.body) return s.goals;
    return suggestGoals(s.body).map((g) => g.goal);
  }, [data.settings]);

  const store: Store = {
    ...data,
    ready,
    error,
    storage,
    boot,
    goals,
    async switchToLocal() {
      if (booted.current) return;
      booted.current = true;
      const info = await db.chooseLocal();
      setStorage(info);
      setBoot((b) => ({ ...b, stage: 'loading' }));
      try {
        await loadAll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setReady(true);
    },
    async saveItem(item, images = [], replacedImageIds = []) {
      await db.putMany(
        'images',
        images.map((i) => ({ id: i.id, blob: i.blob, width: i.width, height: i.height })),
      );
      await db.put('items', item);
      const stale = replacedImageIds.filter((id) => !images.some((i) => i.id === id));
      if (stale.length) {
        await db.deleteMany('images', stale);
        forgetImages(stale);
      }
      setData((d) => {
        const exists = d.items.some((i) => i.id === item.id);
        return {
          ...d,
          items: exists ? d.items.map((i) => (i.id === item.id ? item : i)) : [item, ...d.items],
        };
      });
    },
    async deleteItem(id) {
      const item = data.items.find((i) => i.id === id);
      if (!item) return;
      const imageIds = itemImageIds(item);
      // 套装里去掉这件；穿搭记录保留名称快照
      const outfits = data.outfits
        .filter((o) => o.itemIds.includes(id))
        .map((o) => ({ ...o, itemIds: o.itemIds.filter((x) => x !== id), updatedAt: Date.now() }));
      await db.putMany('outfits', outfits);
      await db.deleteMany('items', [id]);
      await db.deleteMany('images', imageIds);
      forgetImages(imageIds);
      setData((d) => ({
        ...d,
        items: d.items.filter((i) => i.id !== id),
        outfits: d.outfits.map((o) => outfits.find((x) => x.id === o.id) ?? o),
      }));
    },
    async saveOutfit(o) {
      await db.put('outfits', o);
      setData((d) => ({ ...d, outfits: [o, ...d.outfits.filter((x) => x.id !== o.id)] }));
    },
    async deleteOutfit(id) {
      await db.deleteMany('outfits', [id]);
      setData((d) => ({ ...d, outfits: d.outfits.filter((x) => x.id !== id) }));
    },
    async saveRecord(r, photo, replacedPhotoId) {
      if (photo) await db.put('images', { id: photo.id, blob: photo.blob, width: photo.width, height: photo.height });
      await db.put('records', r);
      if (replacedPhotoId && replacedPhotoId !== r.photo) {
        await db.deleteMany('images', [replacedPhotoId]);
        forgetImages([replacedPhotoId]);
      }
      setData((d) => {
        const others = d.records.filter((x) => x.id !== r.id);
        const records = [r, ...others].sort((a, b) =>
          a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1,
        );
        return { ...d, records };
      });
    },
    async deleteRecord(id) {
      const r = data.records.find((x) => x.id === id);
      await db.deleteMany('records', [id]);
      if (r?.photo) {
        await db.deleteMany('images', [r.photo]);
        forgetImages([r.photo]);
      }
      setData((d) => ({ ...d, records: d.records.filter((x) => x.id !== id) }));
    },
    async updateSettings(patch) {
      const next = { ...latest.current.settings, ...patch };
      latest.current = { ...latest.current, settings: next };
      setData((d) => ({ ...d, settings: next }));
      await db.setKV('settings', next);
    },
    async setFeedback(fb) {
      latest.current = { ...latest.current, feedback: fb };
      setData((d) => ({ ...d, feedback: fb }));
      await db.setKV('feedback', fb);
    },
    async setToday(patch) {
      const next = { ...latest.current.today, ...patch };
      latest.current = { ...latest.current, today: next };
      setData((d) => ({ ...d, today: next }));
      await db.setKV('today', next);
    },
    async reload() {
      forgetAllImages();
      await loadAll();
    },
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
