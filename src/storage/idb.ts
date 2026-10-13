// 本机存储：IndexedDB。直接打开单文件版、开发模式，或云端不可用时使用。

import type { Backend, DocStore, StoredImage, UsageInfo } from './backend';

const DB_NAME = 'smart-wardrobe';
const DB_VERSION = 1;
const ALL = ['items', 'images', 'outfits', 'records', 'kv'] as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持本地数据库（IndexedDB），无法保存数据'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['items', 'images', 'outfits', 'records']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地数据库'));
    req.onblocked = () => reject(new Error('本地数据库被其他标签页占用，请关闭其他标签页后重试'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('写入被中止，可能是存储空间不足'));
  });
}

async function putRows(store: string, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await done(tx);
}

async function deleteRows(store: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const k of keys) os.delete(k);
  await done(tx);
}

/** 检查本机数据库能否打开（隐私模式、被禁用的站点数据等情况下会失败） */
export async function localAvailable(): Promise<boolean> {
  try {
    await openDB();
    return true;
  } catch {
    return false;
  }
}

export const idbBackend: Backend = {
  kind: 'local',
  async getAll<T>(store: DocStore): Promise<T[]> {
    const db = await openDB();
    return wrap(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
  },
  putMany: (store, values) => putRows(store, values),
  deleteMany: (store, ids) => deleteRows(store, ids),
  async getKV<T>(key: string): Promise<T | undefined> {
    const db = await openDB();
    return wrap(db.transaction('kv', 'readonly').objectStore('kv').get(key) as IDBRequest<T | undefined>);
  },
  async setKV(key, value) {
    const db = await openDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await done(tx);
  },
  putImages: (rows) => putRows('images', rows),
  async getImage(id) {
    const db = await openDB();
    return wrap(db.transaction('images', 'readonly').objectStore('images').get(id) as IDBRequest<StoredImage | undefined>);
  },
  async imageSrc(id) {
    const rec = await idbBackend.getImage(id);
    return rec ? { url: URL.createObjectURL(rec.blob), revoke: true } : undefined;
  },
  deleteImages: (ids) => deleteRows('images', ids),
  async clearAll() {
    const db = await openDB();
    const tx = db.transaction([...ALL], 'readwrite');
    for (const n of ALL) tx.objectStore(n).clear();
    await done(tx);
  },
  async usage(): Promise<UsageInfo | null> {
    try {
      if (!navigator.storage?.estimate) return null;
      const e = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
    } catch {
      return null;
    }
  },
  async requestPersistence() {
    try {
      if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch {
      /* 部分浏览器不支持 */
    }
    return false;
  },
};
