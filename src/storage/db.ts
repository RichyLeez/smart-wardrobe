// 存储入口。启动时选择后端：
//   - 作为 claude.ai 发布页面打开且已登录 → 云端（手机和电脑看到同一份衣橱）
//   - 直接打开文件 / 本地开发 → 本机浏览器（IndexedDB）
//   - 浏览器禁止保存数据 → 内存（刷新即丢失，界面会提示）
// 界面层只调用这里导出的函数。

import type { Backend, BackendKind, DocStore, StoreName, StoredImage, UsageInfo } from './backend';
import { CloudBackend } from './cloud';
import {
  getCapability,
  isHosted,
  withTimeout,
  type CloudAssets,
  type CloudDB,
  type CloudUser,
  type PermissionState,
  type Permissions,
} from './hosted';
import { idbBackend, localAvailable } from './idb';
import { createMemoryBackend } from './memory';

export type { StoreName, StoredImage, DocStore, BackendKind };

export interface StorageInfo {
  mode: BackendKind;
  /** 是否作为 claude.ai 发布页面运行 */
  hosted: boolean;
  /** 云端不可用时的原因，用于界面提示 */
  note?: string;
}

/** 启动阶段，用于在页面上显示进度 */
export type BootStage = 'start' | 'permission' | 'connecting' | 'loading';

let backend: Backend = idbBackend;
let info: StorageInfo = { mode: 'local', hosted: false };
/** 用户在等待云端时选择了"先用本机模式"，之后云端连接结果不再生效 */
let localChosen = false;

const CLOUD_CAPS = ['db', 'user', 'assets', 'downloads'];

/** 示例衣橱的图片按需绘制，不占用存储，id 以此前缀开头 */
export const VIRTUAL_IMAGE_PREFIX = 'demo:';
export const isVirtualImage = (id: string) => id.startsWith(VIRTUAL_IMAGE_PREFIX);

async function connectCloud(onStage: (s: BootStage) => void): Promise<{ backend?: Backend; note?: string }> {
  const [cdb, user, assets, perms] = await Promise.all([
    getCapability<CloudDB>('db'),
    getCapability<CloudUser>('user'),
    getCapability<CloudAssets>('assets'),
    getCapability<Permissions>('permissions'),
  ]);
  if (!cdb || !user) return { note: '没有连上云端数据库（可能是未登录）' };

  // 第一次使用时平台会询问是否允许页面保存数据。先读状态（不弹窗），需要时一次性请求，
  // 避免第一次读写卡在没被注意到的授权提示上。
  if (perms) {
    const states = await withTimeout<Record<string, PermissionState> | null>(perms.state(), 5000, null);
    if (states?.db === 'denied') return { note: '这个页面的云端存储权限被拒绝了，可以在页面的权限菜单里重新打开' };
    const ask = states ? CLOUD_CAPS.filter((n) => states[n] === 'prompt') : [];
    if (ask.length) {
      onStage('permission');
      const res = await perms.request(ask).catch(() => null);
      if (res?.db === 'denied') return { note: '你没有允许页面保存数据到云端' };
    }
  }

  onStage('connecting');
  const uid = await withTimeout(user.id(), 15000, null);
  if (!uid) return { note: '没有识别到你的账号' };
  if (!assets) return { note: '当前账号没有这个页面的编辑权限，照片无法保存到云端' };
  const cloud = new CloudBackend(cdb, assets, uid);
  const timedOut = Symbol('timeout');
  try {
    const r = await withTimeout<unknown>(cloud.init(), 25000, timedOut);
    if (r === timedOut) return { note: '连接云端超时' };
  } catch (e) {
    return { note: e instanceof Error ? e.message : '云端数据读取失败' };
  }
  return { backend: cloud };
}

async function fallbackLocal(hosted: boolean, note?: string): Promise<StorageInfo> {
  if (await localAvailable()) {
    backend = idbBackend;
    info = { mode: 'local', hosted, note };
  } else {
    backend = createMemoryBackend();
    info = { mode: 'memory', hosted, note: note ?? '浏览器不允许保存数据（可能是隐私模式）' };
  }
  return info;
}

/** 选择存储后端，只需在启动时调用一次 */
export async function initStorage(onStage: (s: BootStage) => void = () => undefined): Promise<StorageInfo> {
  const hosted = isHosted();
  let note: string | undefined;
  if (hosted) {
    const res = await connectCloud(onStage);
    if (localChosen) return info;
    if (res.backend) {
      backend = res.backend;
      info = { mode: 'cloud', hosted };
      return info;
    }
    note = res.note;
  }
  if (localChosen) return info;
  return fallbackLocal(hosted, note);
}

/** 云端迟迟连不上时，由用户选择先用本机浏览器保存 */
export async function chooseLocal(): Promise<StorageInfo> {
  localChosen = true;
  return fallbackLocal(isHosted(), '你选择了先用本机模式');
}

/** 打开平台的权限面板（只能由用户点击触发） */
export async function openPermissionPanel(): Promise<boolean> {
  const perms = await getCapability<Permissions>('permissions');
  if (!perms) return false;
  try {
    await perms.manage();
    return true;
  } catch {
    return false;
  }
}

/** 测试或特殊场景下直接指定后端 */
export function useBackend(b: Backend, i: StorageInfo): void {
  backend = b;
  info = i;
}

export function storageInfo(): StorageInfo {
  return info;
}

export function getAll<T>(store: DocStore): Promise<T[]> {
  return backend.getAll<T>(store);
}

export async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  if (store !== 'images') throw new Error(`getOne 只支持图片，收到 ${store}`);
  if (isVirtualImage(key)) return undefined;
  return (await backend.getImage(key)) as T | undefined;
}

export async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  if (store === 'images') {
    const rows = (values as StoredImage[]).filter((r) => !isVirtualImage(r.id));
    if (rows.length) await backend.putImages(rows);
    return;
  }
  if (store === 'kv') throw new Error('请使用 setKV 保存键值数据');
  await backend.putMany(store, values as Array<{ id: string }>);
}

export function put(store: StoreName, value: unknown): Promise<void> {
  return putMany(store, [value]);
}

export async function deleteMany(store: StoreName, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (store === 'images') {
    const real = keys.filter((k) => !isVirtualImage(k));
    if (real.length) await backend.deleteImages(real);
    return;
  }
  if (store === 'kv') throw new Error('不支持批量删除键值数据');
  await backend.deleteMany(store, keys);
}

export function getKV<T>(key: string): Promise<T | undefined> {
  return backend.getKV<T>(key);
}

export function setKV(key: string, value: unknown): Promise<void> {
  return backend.setKV(key, value);
}

export function clearAll(): Promise<void> {
  return backend.clearAll();
}

export function imageSrc(id: string): Promise<{ url: string; revoke: boolean } | undefined> {
  return backend.imageSrc(id);
}

/** 请求浏览器把本站数据标记为持久保存（不保证被批准；云端恒为 true） */
export function requestPersistence(): Promise<boolean> {
  return backend.requestPersistence();
}

export function storageEstimate(): Promise<UsageInfo | null> {
  return backend.usage();
}
