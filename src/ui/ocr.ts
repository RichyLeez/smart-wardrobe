// 吊牌文字识别：第一次使用时从 jsDelivr 加载开源识别组件 Tesseract.js（简体中文 + 英文字库，约 8MB，之后由浏览器缓存），
// 在本机浏览器里识别，照片不会上传到任何服务器。网络无法访问 jsDelivr 时，界面提示改用"粘贴文字"。

import { createCanvas, loadImageElement } from './imageTools';

export const TESSERACT_VERSION = '5.1.1';
export const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;

interface TesseractWorker {
  recognize(image: HTMLCanvasElement): Promise<{ data: { text?: string } }>;
  terminate(): Promise<unknown>;
}
interface TesseractLib {
  createWorker(
    langs: string | string[],
    oem?: number,
    options?: { logger?: (m: { status?: string; progress?: number }) => void },
  ): Promise<TesseractWorker>;
}

type WithTesseract = Window & { Tesseract?: TesseractLib };

let libPromise: Promise<TesseractLib> | null = null;

function loadLibrary(timeoutMs = 45000): Promise<TesseractLib> {
  const w = window as WithTesseract;
  if (w.Tesseract) return Promise.resolve(w.Tesseract);
  if (libPromise) return libPromise;
  libPromise = new Promise<TesseractLib>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => reject(new Error('识别组件下载超时')), timeoutMs);
    script.src = TESSERACT_URL;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (w.Tesseract) resolve(w.Tesseract);
      else reject(new Error('识别组件加载不完整'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('识别组件下载失败'));
    };
    document.head.appendChild(script);
  });
  libPromise.catch(() => {
    libPromise = null;
  });
  return libPromise;
}

/** 缩放到合适尺寸、转灰度并拉开对比度，吊牌上的小字更容易认 */
export async function prepareTagImage(file: Blob, maxSide = 1800): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = createCanvas(img.naturalWidth * scale, img.naturalHeight * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器不支持画布，无法处理图片');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const g = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
      px[i] = g;
      hist[g]++;
    }
    // 2% 和 98% 分位数之间拉伸到 0~255
    const total = px.length / 4;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc <= total * 0.02) lo = v;
      if (acc <= total * 0.98) hi = v;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      const g = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / span));
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type OcrStage = 'download' | 'language' | 'init' | 'recognize';

export const OCR_STAGE_TEXT: Record<OcrStage, string> = {
  download: '正在下载识别组件（第一次约 8MB）…',
  language: '正在下载中文字库…',
  init: '正在准备识别…',
  recognize: '正在识别文字',
};

function stageOf(status = ''): OcrStage {
  if (status.includes('language')) return 'language';
  if (status.includes('recogniz')) return 'recognize';
  if (status.includes('core')) return 'download';
  return 'init';
}

/** 识别一张吊牌照片，返回原始文字 */
export async function recognizeTagImage(file: Blob, onProgress: (stage: OcrStage, progress: number) => void): Promise<string> {
  const canvas = await prepareTagImage(file);
  onProgress('download', 0);
  let lib: TesseractLib;
  try {
    lib = await loadLibrary();
  } catch {
    throw new Error('识别组件下载失败，可能是当前网络打不开 jsDelivr。可以改用「粘贴文字」：iPhone 相机对准吊牌，点文字图标拷贝后粘贴。');
  }
  let worker: TesseractWorker;
  try {
    worker = await lib.createWorker(['chi_sim', 'eng'], 1, {
      logger: (m) => onProgress(stageOf(m.status), Math.round((m.progress ?? 0) * 100)),
    });
  } catch {
    throw new Error('中文字库下载失败，请检查网络后重试，或改用「粘贴文字」。');
  }
  try {
    const { data } = await worker.recognize(canvas);
    return data.text ?? '';
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
