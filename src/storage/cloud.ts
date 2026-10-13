// 云端存储：作为 claude.ai 发布页面运行时，用平台提供的文档数据库保存数据、用图片存储保存照片。
// 数据放在 data/users/<用户 id>/ 下，这是每个人私有的空间：别人打开同一个页面看不到你的衣橱。
//
// 路径结构（偶数段是文档，奇数段是集合）：
//   data/users/<uid>/w                    根文档（不需要真实存在）
//   data/users/<uid>/w/items/<id>         单品
//   data/users/<uid>/w/outfits/<id>       套装
//   data/users/<uid>/w/records/<id>       穿搭记录
//   data/users/<uid>/w/kv/<key>           设置、喜好、今日状态 { id, v }
//   data/users/<uid>/w/images/<图片 id>   图片索引 { id, asset, w, h, type }，asset 指向图片存储里的文件

import type { Backend, DocStore, StoredImage, UsageInfo } from './backend';
import {
  describeCloudError,
  isRetryable,
  type CloudAssets,
  type CloudDB,
  type CollectionRef,
  type DocRef,
  type Query,
} from './hosted';

interface ImageRow {
  id: string;
  asset: string;
  w: number;
  h: number;
  type: string;
  size?: number;
  at?: number;
}

const PAGE = 500;
const MAX_DOC_BYTES = 240_000;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class CloudError extends Error {
  code: string;
  constructor(cause: unknown) {
    super(describeCloudError(cause));
    this.code = typeof cause === 'object' && cause && 'code' in cause ? String((cause as { code: unknown }).code) : 'unknown';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 只在平台说明可以重试的情况下重试一次 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isRetryable(e)) throw new CloudError(e);
    await sleep(400 + Math.random() * 600);
    try {
      return await fn();
    } catch (e2) {
      throw new CloudError(e2);
    }
  }
}

/** 文档必须是纯 JSON：去掉 undefined 字段，并检查大小 */
function clean(value: unknown): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length > MAX_DOC_BYTES) throw new Error('这条数据太大，无法保存到云端');
  return JSON.parse(json) as Record<string, unknown>;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  let failed: unknown = null;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length && failed === null) {
      const x = items[i++];
      try {
        await fn(x);
      } catch (e) {
        failed = e;
      }
    }
  });
  await Promise.all(workers);
  if (failed !== null) throw failed;
}

export type BlobFetcher = (url: string) => Promise<Blob | null>;

const defaultFetcher: BlobFetcher = async (url) => {
  const res = await fetch(url);
  return res.ok ? res.blob() : null;
};

export class CloudBackend implements Backend {
  readonly kind = 'cloud' as const;
  private root: DocRef;
  private imageRows = new Map<string, ImageRow>();
  /** 同一文档的写入排队执行，避免并发写同一条数据 */
  private chains = new Map<string, Promise<unknown>>();
  private kvVersions = new Map<string, number>();

  constructor(
    db: CloudDB,
    private assets: CloudAssets,
    uid: string,
    private fetchBlob: BlobFetcher = defaultFetcher,
  ) {
    this.root = db.doc(`data/users/${uid}/w`);
  }

  async init(): Promise<void> {
    const rows = await this.readAll<ImageRow>('images');
    for (const r of rows) if (r && r.id && r.asset) this.imageRows.set(r.id, r);
  }

  private col(name: string): CollectionRef {
    return this.root.collection(name);
  }

  private queue<T>(path: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.chains.set(path, next);
    void next.finally(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    }).catch(() => undefined);
    return next;
  }

  /** 按 id 分页读取整个集合 */
  private async readAll<T>(name: string): Promise<T[]> {
    const col = this.col(name);
    const out: T[] = [];
    let last: string | null = null;
    for (let page = 0; page < 100; page++) {
      const q: Query = (last === null ? col : col.where('id', '>', last)).orderBy('id').limit(PAGE);
      const snap = await withRetry(() => q.get());
      for (const d of snap.docs) {
        const v = d.data();
        if (v) out.push(v as T);
      }
      if (snap.docs.length < PAGE) break;
      const tail = snap.docs[snap.docs.length - 1];
      const tailId = String((tail.data() as { id?: unknown } | undefined)?.id ?? tail.id);
      if (tailId === last) break;
      last = tailId;
    }
    return out;
  }

  async getAll<T>(store: DocStore): Promise<T[]> {
    return this.readAll<T>(store);
  }

  async putMany<T extends { id: string }>(store: DocStore, values: T[]): Promise<void> {
    const col = this.col(store);
    await pool(values, 4, async (v) => {
      const body = clean(v);
      const ref = col.doc(v.id);
      await this.queue(ref.path, () => withRetry(() => ref.set(body)));
    });
  }

  async deleteMany(store: DocStore, ids: string[]): Promise<void> {
    const col = this.col(store);
    await pool(ids, 4, async (id) => {
      const ref = col.doc(id);
      await this.queue(ref.path, () => withRetry(() => ref.delete()));
    });
  }

  async getKV<T>(key: string): Promise<T | undefined> {
    const snap = await withRetry(() => this.col('kv').doc(key).get());
    if (!snap.exists) return undefined;
    return (snap.data() as { v?: T } | undefined)?.v;
  }

  /** 连续多次修改同一个键时，只写入最后一次的值 */
  async setKV(key: string, value: unknown): Promise<void> {
    const version = (this.kvVersions.get(key) ?? 0) + 1;
    this.kvVersions.set(key, version);
    const body = clean({ id: key, v: value ?? null, at: Date.now() });
    const ref = this.col('kv').doc(key);
    await this.queue(ref.path, async () => {
      if (this.kvVersions.get(key) !== version) return;
      await withRetry(() => ref.set(body));
    });
  }

  async putImages(rows: StoredImage[]): Promise<void> {
    const uploaded: string[] = [];
    try {
      for (const row of rows) {
        const type = UPLOAD_TYPES.has(row.blob.type) ? row.blob.type : 'image/png';
        const up = await withRetry(() => this.assets.upload(row.blob, { type }));
        uploaded.push(up.id);
        const map: ImageRow = {
          id: row.id,
          asset: up.id,
          w: Math.round(row.width),
          h: Math.round(row.height),
          type: up.contentType || type,
          size: up.sizeBytes,
          at: Date.now(),
        };
        const ref = this.col('images').doc(row.id);
        await this.queue(ref.path, () => withRetry(() => ref.set(clean(map))));
        this.imageRows.set(row.id, map);
        uploaded.pop();
      }
    } catch (e) {
      // 已上传但还没有索引指向的文件，删掉以免占用空间
      for (const id of uploaded) await this.assets.delete(id).catch(() => undefined);
      throw e;
    }
  }

  private async lookup(id: string): Promise<ImageRow | undefined> {
    const cached = this.imageRows.get(id);
    if (cached) return cached;
    try {
      const snap = await this.col('images').doc(id).get();
      const row = snap.exists ? (snap.data() as unknown as ImageRow) : undefined;
      if (row?.asset) this.imageRows.set(id, row);
      return row?.asset ? row : undefined;
    } catch {
      return undefined;
    }
  }

  async getImage(id: string): Promise<StoredImage | undefined> {
    const row = await this.lookup(id);
    if (!row) return undefined;
    const blob = await this.fetchBlob(`/_blob/${row.asset}`).catch(() => null);
    if (!blob) return undefined;
    const typed = blob.type ? blob : new Blob([blob], { type: row.type });
    return { id, blob: typed, width: row.w, height: row.h };
  }

  async imageSrc(id: string): Promise<{ url: string; revoke: boolean } | undefined> {
    const row = await this.lookup(id);
    return row ? { url: `/_blob/${row.asset}`, revoke: false } : undefined;
  }

  async deleteImages(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = await this.lookup(id);
      if (row) await this.assets.delete(row.asset).catch(() => undefined);
      const ref = this.col('images').doc(id);
      await this.queue(ref.path, () => withRetry(() => ref.delete()));
      this.imageRows.delete(id);
    }
  }

  async clearAll(): Promise<void> {
    const images = await this.readAll<ImageRow>('images');
    await this.deleteImages(images.map((r) => r.id));
    for (const store of ['items', 'outfits', 'records'] as DocStore[]) {
      const rows = await this.readAll<{ id: string }>(store);
      await this.deleteMany(store, rows.map((r) => r.id));
    }
    const kv = await this.readAll<{ id: string }>('kv');
    const keys = new Set([...kv.map((r) => r.id), 'settings', 'feedback', 'today']);
    for (const key of keys) {
      this.kvVersions.set(key, (this.kvVersions.get(key) ?? 0) + 1);
      const ref = this.col('kv').doc(key);
      await this.queue(ref.path, () => withRetry(() => ref.delete()));
    }
    this.imageRows.clear();
  }

  async usage(): Promise<UsageInfo | null> {
    try {
      const { usage } = await this.assets.list();
      return { usage: usage.bytes, quota: usage.maxBytes, persisted: true };
    } catch {
      return null;
    }
  }

  async requestPersistence(): Promise<boolean> {
    return true;
  }
}
