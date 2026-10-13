// 内存存储：浏览器禁止保存数据（例如隐私模式）时的兜底，刷新页面后数据会消失。也用于单元测试。

import type { Backend, DocStore, StoredImage } from './backend';

export function createMemoryBackend(): Backend {
  const docs: Record<DocStore, Map<string, unknown>> = { items: new Map(), outfits: new Map(), records: new Map() };
  const kv = new Map<string, unknown>();
  const images = new Map<string, StoredImage>();
  const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    kind: 'memory',
    async getAll<T>(store: DocStore) {
      return [...docs[store].values()].map((v) => copy(v) as T);
    },
    async putMany(store, values) {
      for (const v of values) docs[store].set(v.id, copy(v));
    },
    async deleteMany(store, ids) {
      for (const id of ids) docs[store].delete(id);
    },
    async getKV<T>(key: string) {
      return copy(kv.get(key)) as T | undefined;
    },
    async setKV(key, value) {
      kv.set(key, copy(value));
    },
    async putImages(rows) {
      for (const r of rows) images.set(r.id, r);
    },
    async getImage(id) {
      return images.get(id);
    },
    async imageSrc(id) {
      const r = images.get(id);
      return r ? { url: URL.createObjectURL(r.blob), revoke: true } : undefined;
    },
    async deleteImages(ids) {
      for (const id of ids) images.delete(id);
    },
    async clearAll() {
      for (const m of Object.values(docs)) m.clear();
      kv.clear();
      images.clear();
    },
    async usage() {
      let n = 0;
      for (const r of images.values()) n += r.blob.size;
      return { usage: n, quota: 0, persisted: false };
    },
    async requestPersistence() {
      return false;
    },
  };
}
