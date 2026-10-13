// 测试用的云端替身：按平台文档实现路径规则（偶数段为文档、奇数段为集合）、
// 查询（where / orderBy / limit）和图片存储，并记录同一文档的并发写入次数。

import type {
  AssetUpload,
  CloudAssets,
  CloudDB,
  CollectionRef,
  DocRef,
  DocSnapshot,
  Query,
  QuerySnapshot,
} from '../src/storage/hosted';

const SEGMENT = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

function checkPath(path: string, wantEven: boolean): string[] {
  const parts = path.split('/');
  for (const p of parts) {
    if (!SEGMENT.test(p) || p === '.' || p === '..') throw new TypeError(`非法路径段 "${p}"（${path}）`);
  }
  if (parts.length > 16) throw new TypeError(`路径过深：${path}`);
  if ((parts.length % 2 === 0) !== wantEven) {
    throw new TypeError(`${wantEven ? '文档' : '集合'}路径段数不对（${parts.length} 段）：${path}`);
  }
  return parts;
}

const tick = () => new Promise((r) => setTimeout(r, 1));

type Filter = [string, string, unknown];

export class FakeCloud implements CloudDB {
  docs = new Map<string, Record<string, unknown>>();
  writes = 0;
  inflight = new Map<string, number>();
  maxInflight = 0;
  /** 让接下来的若干次写入失败，模拟平台错误 */
  failWrites: Array<{ code: string }> = [];

  doc(path: string): DocRef {
    checkPath(path, true);
    const self = this;
    return {
      id: path.split('/').pop()!,
      path,
      async get(): Promise<DocSnapshot> {
        await tick();
        const d = self.docs.get(path);
        return { id: path.split('/').pop()!, exists: !!d, data: () => (d ? structuredClone(d) : undefined) };
      },
      async set(data: Record<string, unknown>) {
        await self.write(path, async () => {
          if (data === null || typeof data !== 'object' || Array.isArray(data)) throw { code: 'invalid_argument', message: 'body' };
          JSON.stringify(data);
          self.docs.set(path, structuredClone(data));
        });
      },
      async delete() {
        await self.write(path, async () => {
          self.docs.delete(path);
        });
      },
      collection(name: string): CollectionRef {
        return self.collection(`${path}/${name}`);
      },
    };
  }

  private async write(path: string, op: () => Promise<void>): Promise<void> {
    const n = (this.inflight.get(path) ?? 0) + 1;
    this.inflight.set(path, n);
    this.maxInflight = Math.max(this.maxInflight, n);
    try {
      await tick();
      const fail = this.failWrites.shift();
      if (fail) throw { ...fail, message: fail.code };
      this.writes++;
      await op();
    } finally {
      this.inflight.set(path, (this.inflight.get(path) ?? 1) - 1);
    }
  }

  collection(path: string): CollectionRef {
    checkPath(path, false);
    const self = this;
    const makeQuery = (filters: Filter[], order: [string, 'asc' | 'desc'] | null, lim: number | null): Query => ({
      where(field, op, value) {
        if (filters.length >= 10) throw new TypeError('过多筛选条件');
        return makeQuery([...filters, [field, op, value]], order, lim);
      },
      orderBy(field, dir = 'asc') {
        return makeQuery(filters, [field, dir], lim);
      },
      limit(n) {
        if (n < 1 || n > 1000) throw new TypeError('limit 超出 1-1000');
        return makeQuery(filters, order, n);
      },
      async get(): Promise<QuerySnapshot> {
        await tick();
        const prefix = `${path}/`;
        let rows = [...self.docs.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map(([p, d]) => ({ id: p.slice(prefix.length), d }));
        for (const [f, op, v] of filters) {
          rows = rows.filter(({ d }) => {
            const x = d[f] as never;
            switch (op) {
              case '>':
                return x > (v as never);
              case '>=':
                return x >= (v as never);
              case '<':
                return x < (v as never);
              case '==':
                return x === v;
              default:
                throw new Error(`替身未实现操作符 ${op}`);
            }
          });
        }
        if (order) {
          const [f, dir] = order;
          rows.sort((a, b) => {
            const x = a.d[f] as never;
            const y = b.d[f] as never;
            const c = x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1;
            return dir === 'asc' ? c : -c;
          });
        } else {
          rows.sort((a, b) => (a.id < b.id ? -1 : 1));
        }
        if (lim !== null) rows = rows.slice(0, lim);
        const docs = rows.map(({ id, d }) => ({ id, exists: true, data: () => structuredClone(d) }));
        return { docs, size: docs.length };
      },
    });
    const base = makeQuery([], null, null);
    return {
      ...base,
      path,
      doc(id?: string) {
        return self.doc(`${path}/${id ?? Math.random().toString(36).slice(2)}`);
      },
    };
  }
}

export class FakeAssets implements CloudAssets {
  files = new Map<string, Blob>();
  uploads = 0;
  failUploadsAfter = Infinity;
  private seq = 0;

  async upload(blob: Blob, options?: { type?: string }): Promise<AssetUpload> {
    await tick();
    if (this.uploads >= this.failUploadsAfter) throw { code: 'quota_or_state', message: 'full' };
    this.uploads++;
    const type = options?.type ?? blob.type;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw { code: 'unsupported_type', message: type };
    const id = (++this.seq).toString(16).padStart(32, '0');
    this.files.set(id, new Blob([await blob.arrayBuffer()], { type }));
    return { id, url: `/_blob/${id}`, sizeBytes: blob.size, contentType: type };
  }

  async list() {
    const assets = [...this.files.entries()].map(([id, b]) => ({ id, sizeBytes: b.size }));
    const bytes = assets.reduce((n, a) => n + a.sizeBytes, 0);
    return { assets, usage: { files: assets.length, bytes, maxFiles: 5000, maxBytes: 500 * 1024 * 1024 } };
  }

  async delete(ref: string) {
    await tick();
    const id = ref.replace('/_blob/', '');
    return { deleted: this.files.delete(id) };
  }

  fetcher = async (url: string): Promise<Blob | null> => this.files.get(url.replace('/_blob/', '')) ?? null;
}
