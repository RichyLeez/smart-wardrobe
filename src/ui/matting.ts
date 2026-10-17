// 抠图模型的下载、缓存和运行。
// 模型文件（约 56MB）放在自己的网站上（models/u2net.bin），第一次用时下载，存进浏览器的 Cache Storage，
// 之后直接从本机读取。照片只在本机显卡上计算，不上传。
// 用户在录入页点一次「下载」后记住（localStorage），以后打开录入页自动在后台准备好。

import { useEffect, useState } from 'react';
import type { RGBAImage } from '../core/background';
import { modelConfidence, parseModel, postprocess, preprocess, type U2Model } from '../core/u2net';
import { U2Gpu } from './u2netGpu';

export type MattingStatus = 'off' | 'unsupported' | 'downloading' | 'preparing' | 'ready' | 'error';

export interface MattingState {
  status: MattingStatus;
  /** 下载进度 0~1 */
  progress: number;
  /** 出错时的说明 */
  error?: string;
}

/** 模型文件的版本号：换模型时改这里，旧缓存自动作废 */
const MODEL_VERSION = 'u2net-v1';
const CACHE_NAME = `wardrobe-model-${MODEL_VERSION}`;
const ENABLED_KEY = 'wardrobe:matting';
export const MODEL_SIZE_MB = 56;

const modelUrl = () => new URL('models/u2net.bin', location.href).href;

let state: MattingState = { status: 'off', progress: 0 };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let model: U2Model | null = null;
let gpu: U2Gpu | null = null;

function setState(s: Partial<MattingState>): void {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
}

export function mattingState(): MattingState {
  return state;
}

export function useMatting(): MattingState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

/** 浏览器能不能用（file:// 打开的单文件版、claude.ai 发布页面、不支持 WebGL2 的浏览器都不行） */
export function mattingAvailable(): boolean {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return false;
  if (/claudeusercontent\.com$/.test(location.hostname)) return false;
  return U2Gpu.supported();
}

export function mattingEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // 浏览器禁止存储时，本次打开期间仍然可用
  }
}

async function cachedResponse(): Promise<Response | undefined> {
  if (typeof caches === 'undefined') return undefined;
  try {
    const c = await caches.open(CACHE_NAME);
    return (await c.match(modelUrl())) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 模型已经下载在本机了吗 */
export async function modelDownloaded(): Promise<boolean> {
  return !!(await cachedResponse());
}

async function download(): Promise<ArrayBuffer> {
  const hit = await cachedResponse();
  if (hit) return hit.arrayBuffer();
  setState({ status: 'downloading', progress: 0, error: undefined });
  const res = await fetch(modelUrl(), { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || MODEL_SIZE_MB * 1e6;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    setState({ progress: Math.min(1, got / total) });
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  try {
    const c = await caches.open(CACHE_NAME);
    await c.put(modelUrl(), new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
    // 清掉旧版本的模型
    for (const k of await caches.keys()) if (k.startsWith('wardrobe-model-') && k !== CACHE_NAME) await caches.delete(k);
  } catch {
    // 存不进缓存（空间不足、隐私模式）：这次照样能用，下次重新下载
  }
  return buf.buffer;
}

/** 下载（或从本机缓存读取）并准备好模型。enable 为真时记住用户的选择 */
export function prepareMatting(enable = false): Promise<void> {
  if (enable) remember(true);
  if (state.status === 'ready') return Promise.resolve();
  if (loading) return loading;
  if (!mattingAvailable()) {
    setState({ status: 'unsupported' });
    return Promise.resolve();
  }
  loading = (async () => {
    try {
      const buf = await download();
      setState({ status: 'preparing', progress: 1 });
      // 让界面先显示"正在准备"
      await new Promise((r) => setTimeout(r, 30));
      model = parseModel(buf);
      gpu = new U2Gpu(model);
      setState({ status: 'ready', error: undefined });
    } catch (e) {
      gpu = null;
      setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 关掉并删除本机的模型文件 */
export async function removeMatting(): Promise<void> {
  remember(false);
  gpu?.dispose();
  gpu = null;
  model = null;
  try {
    for (const k of await caches.keys()) if (k.startsWith('wardrobe-model-')) await caches.delete(k);
  } catch {
    // 忽略
  }
  setState({ status: 'off', progress: 0, error: undefined });
}

/** 模型输入尺寸；端到端测试在软件模拟的显卡上跑，可以用 localStorage 调小（32 的倍数）加快速度 */
function inputSize(m: U2Model): number {
  try {
    const v = Number(localStorage.getItem('wardrobe:matting-size'));
    if (v >= 64 && v <= 512 && v % 32 === 0) return v;
  } catch {
    // 忽略
  }
  return m.inputSize;
}

export interface MattingResult {
  /** 每个像素是衣服的概率，0~255，和照片同尺寸 */
  prior: Uint8Array;
  /** 模型对这张照片的把握（0~1），用来调整它在去背时的权重 */
  confidence: number;
  /** 计算用时（毫秒） */
  ms: number;
}

/** 用模型看一张照片；模型没准备好或出错时返回 null（去背照常按颜色进行） */
export async function runMatting(img: RGBAImage): Promise<MattingResult | null> {
  if (state.status !== 'ready' || !gpu || !model) return null;
  try {
    if (gpu.isLost) {
      gpu = new U2Gpu(model);
    }
    const t0 = performance.now();
    const size = inputSize(model);
    const input = preprocess(img, size, model.mean, model.std);
    const raw = gpu.run(input, size);
    return {
      prior: postprocess(raw, size, img.width, img.height, false),
      confidence: modelConfidence(raw),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    console.warn('抠图模型出错，改为按颜色去背', e);
    return null;
  }
}
