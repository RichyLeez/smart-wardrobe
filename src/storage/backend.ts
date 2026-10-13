// 存储后端接口：本机 IndexedDB 与云端（claude.ai 发布页面的数据库 + 图片存储）实现同一套方法，
// 界面层只通过 storage/db.ts 访问，不关心数据实际存在哪里。

export type DocStore = 'items' | 'outfits' | 'records';
export type StoreName = DocStore | 'images' | 'kv';

export interface StoredImage {
  id: string;
  blob: Blob;
  width: number;
  height: number;
}

export interface UsageInfo {
  /** 已用字节 */
  usage: number;
  /** 上限字节；未知时为 0 */
  quota: number;
  /** 浏览器是否已把本地数据标记为持久保存（云端恒为 true） */
  persisted: boolean;
}

export type BackendKind = 'local' | 'cloud' | 'memory';

export interface Backend {
  kind: BackendKind;
  getAll<T>(store: DocStore): Promise<T[]>;
  putMany<T extends { id: string }>(store: DocStore, values: T[]): Promise<void>;
  deleteMany(store: DocStore, ids: string[]): Promise<void>;
  getKV<T>(key: string): Promise<T | undefined>;
  setKV(key: string, value: unknown): Promise<void>;
  putImages(rows: StoredImage[]): Promise<void>;
  /** 取回图片原始数据（导出备份时使用） */
  getImage(id: string): Promise<StoredImage | undefined>;
  /** 用于 <img src> 的地址；revoke 为 true 时是临时的 blob 地址，不再使用时应释放 */
  imageSrc(id: string): Promise<{ url: string; revoke: boolean } | undefined>;
  deleteImages(ids: string[]): Promise<void>;
  clearAll(): Promise<void>;
  usage(): Promise<UsageInfo | null>;
  requestPersistence(): Promise<boolean>;
}
