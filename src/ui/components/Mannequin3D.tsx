// 3D 人台：按身材数据生成人体，把单品的正面、背面照片包在外面，可以拖动 360° 转动。
// 浏览器不支持 WebGL 时，退回 2D 人台并提供正面 / 背面切换。

import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BODY, garmentView, type ViewSide } from '../../core/body';
import { body3d, bodyMesh, type Body3D } from '../../core/body3d';
import { outfitShells, shoeMesh, type AlphaGrid, type RGB, type ShellInput } from '../../core/garment3d';
import { hexToRgb } from '../../core/color';
import { sortByLayer } from '../../core/recommend';
import type { BodyProfile, Item, Placement } from '../../core/types';
import { Renderer3D, cssColor, type GarmentDraw } from '../gl3d';
import { createCanvas, loadImageElement } from '../imageTools';
import { flatId } from '../flatImage';
import { loadImageUrl, useStore } from '../store';
import { Mannequin } from './Mannequin';

type View = 'front' | 'side' | 'back';
const VIEW_YAW: Record<View, number> = { front: 0, side: Math.PI / 2, back: Math.PI };
const VIEW_LABELS: Record<View, string> = { front: '正面', side: '侧面', back: '背面' };

async function loadImageById(id: string): Promise<HTMLImageElement> {
  const url = await loadImageUrl(id);
  if (!url) throw new Error('图片读取失败');
  return loadImageElement(url);
}

/** 贴图统一缩放到 512×512（WebGL1 只有 2 的幂尺寸才能生成多级纹理） */
function textureCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = createCanvas(512, 512);
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, 512, 512);
  }
  return c;
}

function maskOf(img: HTMLImageElement, maxSide = 160): { mask: AlphaGrid; data: Uint8ClampedArray } {
  const w0 = img.naturalWidth || 1;
  const h0 = img.naturalHeight || 1;
  const s = maxSide / Math.max(w0, h0);
  const c = createCanvas(Math.max(4, w0 * s), Math.max(4, h0 * s));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const alpha = new Uint8Array(c.width * c.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { mask: { width: c.width, height: c.height, alpha }, data };
}

/** 鞋的照片：最下面一截取作鞋底颜色，其余取作鞋面颜色 */
function shoeColors(m: { mask: AlphaGrid; data: Uint8ClampedArray }, fallback: string): { upper: RGB; sole: RGB } {
  const { width, height } = m.mask;
  const acc = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let y = 0; y < height; y++) {
    const k = y > height * 0.84 ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = m.data[i + 3] / 255;
      if (a < 0.5) continue;
      acc[k][0] += m.data[i];
      acc[k][1] += m.data[i + 1];
      acc[k][2] += m.data[i + 2];
      acc[k][3] += 1;
    }
  }
  const base = hexToRgb(fallback).map((v) => v / 255) as RGB;
  const avg = (v: number[]): RGB => (v[3] > 0 ? [v[0] / v[3] / 255, v[1] / v[3] / 255, v[2] / v[3] / 255] : base);
  return { upper: avg(acc[0]), sole: avg(acc[1]) };
}

interface Built {
  garments: GarmentDraw[];
  shoes: ReturnType<typeof shoeMesh> | null;
}

async function buildScene(model: Body3D, items: Item[], layout: Record<string, Placement> | undefined, flat: boolean): Promise<Built> {
  const loadImage = (id: string) => loadImageById(flat ? flatId(id) : id);
  const sorted = sortByLayer(items);
  let shoes: Built['shoes'] = null;
  const inputs: ShellInput[] = [];
  const textures: Array<{ front: HTMLCanvasElement; back?: HTMLCanvasElement }> = [];
  const loaded = await Promise.all(
    sorted.map(async (item) => {
      const front = await loadImage(item.images.cutout);
      const back = item.category !== 'shoes' && item.images.backCutout ? await loadImage(item.images.backCutout) : null;
      return { item, front, back };
    }),
  );
  for (const { item, front, back } of loaded) {
    if (item.category === 'shoes') {
      const colors = shoeColors(maskOf(front), item.color.hex);
      shoes = shoeMesh(model, item.subtype, colors.upper, colors.sole);
      continue;
    }
    const fv = garmentView(item, model.g, 'front', layout?.[item.id]);
    const bv = garmentView(item, model.g, 'back', layout?.[item.id]);
    inputs.push({
      category: item.category,
      subtype: item.subtype,
      front: { rect: fv.rect, mask: maskOf(front).mask },
      back: back ? { rect: bv.rect, mask: maskOf(back).mask } : undefined,
      layer: inputs.length,
    });
    textures.push({ front: textureCanvas(front), back: back ? textureCanvas(back) : undefined });
  }
  const meshes = outfitShells(model, inputs);
  return { garments: meshes.map((mesh, i) => ({ mesh, ...textures[i] })), shoes };
}

interface Props {
  body: BodyProfile | null;
  items: Item[];
  layout?: Record<string, Placement>;
}

export function Mannequin3D({ body, items, layout }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<Renderer3D | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'nogl' | 'error'>('loading');
  const [auto, setAuto] = useState(true);
  const [view, setView] = useState<View | null>(null);
  const [side2d, setSide2d] = useState<ViewSide>('front');
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const target = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; zoom: number } | null>(null);
  const b = body ?? DEFAULT_BODY;
  const model = useMemo(() => body3d(b), [b]);
  const flat = (useStore().settings.garmentLook ?? 'flat') === 'flat';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = Renderer3D.create(canvas);
    if (!r) {
      setStatus('nogl');
      return;
    }
    rRef.current = r;
    r.bodyColor = cssColor('--form-3d', r.bodyColor);
    r.onFrame = (dt) => {
      if (target.current !== null) {
        const d = target.current - r.yaw;
        if (Math.abs(d) < 0.003) {
          r.yaw = target.current;
          target.current = null;
          return autoRef.current;
        }
        r.yaw += d * Math.min(1, dt * 8);
        return true;
      }
      if (autoRef.current) {
        r.yaw += dt * 0.55;
        return true;
      }
      return false;
    };
    r.resize();
    let ro: ResizeObserver | null = null;
    const onResize = () => r.resize();
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    } else window.addEventListener('resize', onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      r.dispose();
      rRef.current = null;
    };
  }, []);

  useEffect(() => {
    rRef.current?.setBody(bodyMesh(model), model.g.height);
  }, [model]);

  useEffect(() => {
    const r = rRef.current;
    if (!r) return;
    let alive = true;
    setStatus('loading');
    buildScene(model, items, layout, flat)
      .then((scene) => {
        if (!alive || rRef.current !== r) return;
        r.setShoes(scene.shoes);
        r.setGarments(scene.garments);
        setStatus('ready');
      })
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, [model, items, layout, flat]);

  useEffect(() => {
    if (auto) rRef.current?.requestRender();
  }, [auto]);

  function goTo(v: View) {
    const r = rRef.current;
    setView(v);
    setAuto(false);
    if (!r) return;
    const base = VIEW_YAW[v];
    target.current = base + Math.PI * 2 * Math.round((r.yaw - base) / (Math.PI * 2));
    r.requestRender();
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    target.current = null;
    setAuto(false);
    setView(null);
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(p.x - q.x, p.y - q.y), zoom: rRef.current?.zoom ?? 1 };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    const r = rRef.current;
    if (!prev || !r) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      r.yaw -= (e.clientX - prev.x) * 0.012;
      r.pitch = Math.max(-0.15, Math.min(0.6, r.pitch + (e.clientY - prev.y) * 0.004));
    } else if (pinch.current && pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      r.zoom = Math.max(0.7, Math.min(2.4, (pinch.current.zoom * Math.hypot(p.x - q.x, p.y - q.y)) / Math.max(1, pinch.current.d)));
    }
    r.requestRender();
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const r = rRef.current;
    if (!r) return;
    r.zoom = Math.max(0.7, Math.min(2.4, r.zoom * (1 - e.deltaY * 0.001)));
    r.requestRender();
  };

  if (status === 'nogl') {
    return (
      <div className="view3d">
        <div className="view3d-canvas">
          <Mannequin body={body} items={items} layout={layout} side={side2d} />
        </div>
        <p className="small muted view3d-note">这台设备的浏览器不支持 3D 显示，先用平面人台看正面和背面。</p>
        <div className="view3d-controls">
          <div className="segmented">
            {(['front', 'back'] as ViewSide[]).map((s) => (
              <button key={s} type="button" aria-pressed={side2d === s} onClick={() => setSide2d(s)}>
                {s === 'front' ? '正面' : '背面'}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view3d">
      <div className="view3d-canvas">
        <canvas
          ref={canvasRef}
          data-testid="mannequin-3d"
          data-status={status}
          role="img"
          aria-label={`3D 人台：${items.map((i) => i.name).join('、') || '未穿搭'}，拖动可以转动`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onWheel={onWheel}
        />
        {status === 'loading' && <div className="view3d-status">正在生成 3D 人台…</div>}
        {status === 'error' && <div className="view3d-status">有图片读取失败，部分单品没有显示</div>}
      </div>
      <div className="view3d-controls">
        <div className="segmented" role="group" aria-label="视角">
          {(['front', 'side', 'back'] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => goTo(v)}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chip"
          aria-pressed={auto}
          onClick={() => {
            if (!auto) setView(null);
            setAuto(!auto);
          }}
        >
          自动旋转
        </button>
      </div>
    </div>
  );
}
