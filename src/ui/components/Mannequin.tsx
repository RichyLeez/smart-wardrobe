// 2D 人台：按身材数据画出无五官的正面轮廓，把衣物贴图按类别吸附到对应位置。

import { useMemo, useRef } from 'react';
import { DEFAULT_BODY, applyPlacement, mannequinGeometry, mannequinShapes, placeGarment } from '../../core/body';
import { sortByLayer } from '../../core/recommend';
import type { BodyProfile, Item, Placement } from '../../core/types';
import { useImageUrls } from '../store';

interface Props {
  body: BodyProfile | null;
  items: Item[];
  layout?: Record<string, Placement>;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, p: Placement) => void;
  animate?: boolean;
  label?: string;
}

export function Mannequin({ body, items, layout, editable, selectedId, onSelect, onMove, animate, label }: Props) {
  const b = body ?? DEFAULT_BODY;
  const geom = useMemo(() => mannequinGeometry(b), [b]);
  const shapes = useMemo(() => mannequinShapes(geom), [geom]);
  const sorted = useMemo(() => sortByLayer(items), [items]);
  const urls = useImageUrls(sorted.map((i) => i.images.cutout));
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; start: Placement; pointerId: number } | null>(null);
  const vb = shapes.viewBox;

  const unitsPerPixel = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 1;
    // preserveAspectRatio=meet：取两个方向中较大的缩放比
    return Math.max(vb.width / rect.width, vb.height / rect.height);
  };

  const onPointerDown = (e: React.PointerEvent<SVGImageElement>, id: string) => {
    if (!editable) return;
    e.stopPropagation();
    onSelect?.(id);
    const start = layout?.[id] ?? { dx: 0, dy: 0, scale: 1 };
    drag.current = { id, x: e.clientX, y: e.clientY, start, pointerId: e.pointerId };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || !onMove) return;
    const k = unitsPerPixel();
    onMove(d.id, { ...d.start, dx: d.start.dx + (e.clientX - d.x) * k, dy: d.start.dy + (e.clientY - d.y) * k });
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) svgRef.current?.releasePointerCapture?.(drag.current.pointerId);
    drag.current = null;
    void e;
  };

  const selectedRect = (() => {
    const it = sorted.find((i) => i.id === selectedId);
    if (!it) return null;
    return applyPlacement(placeGarment(it, geom), layout?.[it.id]);
  })();

  return (
    <svg
      ref={svgRef}
      className={`mannequin${animate ? ' dress-in' : ''}`}
      viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label ?? `人台：${sorted.map((i) => i.name).join('、') || '未穿搭'}`}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? endDrag : undefined}
      onPointerCancel={editable ? endDrag : undefined}
      onPointerDown={editable ? () => onSelect?.(null) : undefined}
    >
      <path className="form-arm" d={shapes.armLeft} />
      <path className="form-arm" d={shapes.armRight} />
      <path className="form-fill" d={shapes.body} />
      <ellipse className="form-fill" cx={shapes.head.cx} cy={shapes.head.cy} rx={shapes.head.rx} ry={shapes.head.ry} />
      {sorted.map((item, idx) => {
        const url = urls[item.images.cutout];
        if (!url) return null;
        const r = applyPlacement(placeGarment(item, geom), layout?.[item.id]);
        return (
          <image
            key={item.id}
            className="garment"
            href={url}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            preserveAspectRatio="xMidYMid meet"
            style={{ animationDelay: `${idx * 70}ms`, cursor: editable ? 'grab' : undefined }}
            onPointerDown={editable ? (e: React.PointerEvent<SVGImageElement>) => onPointerDown(e, item.id) : undefined}
          />
        );
      })}
      {editable && selectedRect && (
        <rect
          className="garment-box"
          x={selectedRect.x - 0.8}
          y={selectedRect.y - 0.8}
          width={selectedRect.width + 1.6}
          height={selectedRect.height + 1.6}
          rx={1}
        />
      )}
    </svg>
  );
}
