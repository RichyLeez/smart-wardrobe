// 运行环境探测：是否作为 claude.ai 上发布的网页运行（此时可以使用云端数据库、图片存储和下载）。
// 这里只声明用到的那一小部分接口，完整定义以平台提供的类型为准。

export interface DbError {
  code: string;
  message: string;
}

export interface DocSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface QuerySnapshot {
  docs: DocSnapshot[];
  size: number;
}

export interface DocRef {
  id: string;
  path: string;
  get(): Promise<DocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  collection(path: string): CollectionRef;
}

export interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnapshot>;
}

export interface CollectionRef extends Query {
  path: string;
  doc(id?: string): DocRef;
}

export interface CloudDB {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
}

export interface AssetUpload {
  id: string;
  url: string;
  sizeBytes: number;
  contentType: string;
}

export interface AssetUsage {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

export interface CloudAssets {
  upload(blob: Blob, options?: { type?: string }): Promise<AssetUpload>;
  list(): Promise<{ assets: Array<{ id: string; sizeBytes: number }>; usage: AssetUsage }>;
  delete(ref: string): Promise<{ deleted: boolean }>;
}

export interface CloudUser {
  id(): Promise<string | null>;
}

export type PermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable';

export interface Permissions {
  state(): Promise<Record<string, PermissionState>>;
  request(names?: readonly string[]): Promise<Record<string, PermissionState>>;
  manage(): Promise<void>;
}

/** 给可能一直不返回的调用加上时限，超时返回 fallback */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface Downloads {
  save(req: { filename: string; data: Blob | string }): Promise<{ status: string }>;
}

interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

function runtime(): ClaudeRuntime | null {
  try {
    const c = (window as unknown as { claude?: ClaudeRuntime }).claude;
    return c && typeof c.use === 'function' ? c : null;
  } catch {
    return null;
  }
}

/** 页面是否运行在 claude.ai 的发布环境里（不保证云端功能可用） */
export function isHosted(): boolean {
  return runtime() !== null;
}

export async function getCapability<T>(name: string): Promise<T | null> {
  const r = runtime();
  if (!r) return null;
  try {
    return ((await r.use(name)) as T | null) ?? null;
  } catch {
    return null;
  }
}

/** 错误码 → 用户能看懂的中文说明 */
export function describeCloudError(e: unknown): string {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as DbError).code) : '';
  switch (code) {
    case 'quota_exceeded':
    case 'quota_or_state':
      return '云端存储空间已满，请删除一些不再需要的单品或记录后再试';
    case 'too_large':
      return '图片太大，无法上传';
    case 'resource_exhausted':
    case 'rate_limited':
      return '操作太频繁，请稍等几秒再试';
    case 'upstream_auth':
      return '登录状态已失效，请刷新页面后重试';
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return '云端存储暂时不可用，请刷新页面后重试';
    case 'invalid_argument':
    case 'invalid_request':
    case 'unsupported_type':
      return '数据格式有误，无法保存';
    case 'unavailable':
    case 'store_unavailable':
    case 'upstream_error':
      return '网络不稳定，没有保存成功，请稍后重试';
    default:
      return e instanceof Error ? e.message : '云端保存失败，请稍后重试';
  }
}

export function isRetryable(e: unknown): boolean {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as DbError).code) : '';
  return code === 'unavailable' || code === 'store_unavailable' || code === 'rate_limited';
}

/**
 * 把文件交给用户保存。发布环境里普通的下载链接不起作用，需要走平台的下载确认；
 * 其他环境用 <a download>。返回 false 表示用户取消或当前环境无法保存。
 */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (isHosted()) {
    const dl = await getCapability<Downloads>('downloads');
    if (!dl) throw new Error('当前页面无法下载文件，请在浏览器中打开后再导出');
    try {
      await dl.save({ filename, data: blob });
      return true;
    } catch (e) {
      const code = typeof e === 'object' && e && 'code' in e ? String((e as DbError).code) : '';
      if (code === 'declined') return false;
      if (code === 'rate_limited') throw new Error('已经有一个保存提示，请先处理它');
      throw new Error('文件保存失败，请稍后重试');
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
