// 2D 人台：按身材数据画出无五官的轮廓，把衣物贴图按类别吸附到对应位置。
// 可以看正面或背面：背面用单品的背面照片，没有背面照片时用正面照片的镜像。

import { useMemo, useRef } from 'react';
import { DEFAULT_BODY, garmentView, hiddenFromBack, mannequinGeometry, mannequinShapes, type ViewSide } from '../../core/body';
import { sortByLayer } from '../../core/recommend';
import { drawOrder, isOpen, isTucked, tuckLine } from '../../core/styling';
import type { BodyProfile, Item, Placement, Styling } from '../../core/types';
import { flatId, openId } from '../flatImage';
import { useImageUrls, useStore } from '../store';

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
  /** 看正面还是背面；背面不能拖动调整 */
  side?: ViewSide;
  /** 穿法：上衣塞进下装、外套敞开 */
  styling?: Styling;
}

let clipSeq = 0;

export function Mannequin({ body, items, layout, editable: editableProp, selectedId, onSelect, onMove, animate, label, side = 'front', styling }: Props) {
  const b = body ?? DEFAULT_BODY;
  const editable = editableProp && side === 'front';
  const geom = useMemo(() => mannequinGeometry(b), [b]);
  const shapes = useMemo(() => mannequinShapes(geom), [geom]);
  const sorted = useMemo(
    () => drawOrder(sortByLayer(items), styling).filter((i) => side === 'front' || !hiddenFromBack(i)),
    [items, side, styling],
  );
  const views = useMemo(
    () =>
      new Map(
        sorted.map((i) => {
          const v = garmentView(i, geom, side, layout?.[i.id]);
          // 敞开穿：正面用拉开后的图（照片本身就是敞开的除外）
          if (side === 'front' && isOpen(i, styling) && !i.photoOpen) return [i.id, { ...v, image: openId(v.image), closed: v.image as string | undefined }];
          return [i.id, { ...v, closed: undefined as string | undefined }];
        }),
      ),
    [sorted, geom, side, layout, styling],
  );
  const clipId = useRef(`tuck-${++clipSeq}`).current;
  const tuckedTop = sorted.find((i) => isTucked(i, sorted, styling));
  const bottomItem = sorted.find((i) => i.category === 'bottom');
  const clipY = tuckedTop && bottomItem ? tuckLine(views.get(bottomItem.id)!.rect) : null;
  // 默认显示去掉褶皱的简化图形；图形还没生成好时先显示照片
  const flat = (useStore().settings.garmentLook ?? 'flat') === 'flat';
  // 拉开的外套图生成好之前先显示合上的样子
  const photoIds = sorted.flatMap((i) => {
    const v = views.get(i.id)!;
    return v.closed ? [v.image, v.closed] : [v.image];
  });
  const urls = useImageUrls(flat ? [...photoIds, ...photoIds.map(flatId)] : photoIds);
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

  const selectedRect = selectedId ? views.get(selectedId)?.rect ?? null : null;

  return (
    <svg
      ref={svgRef}
      className={`mannequin${animate ? ' dress-in' : ''}`}
      viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label ?? `人台${side === 'back' ? '背面' : ''}：${sorted.map((i) => i.name).join('、') || '未穿搭'}`}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? endDrag : undefined}
      onPointerCancel={editable ? endDrag : undefined}
      onPointerDown={editable ? () => onSelect?.(null) : undefined}
    >
      <path className="form-arm" d={shapes.armLeft} />
      <path className="form-arm" d={shapes.armRight} />
      <path className="form-fill" d={shapes.body} />
      <ellipse className="form-fill" cx={shapes.head.cx} cy={shapes.head.cy} rx={shapes.head.rx} ry={shapes.head.ry} />
      {clipY !== null && (
        <defs>
          <clipPath id={clipId}>
            <rect x={vb.x - 100} y={vb.y - 100} width={vb.width + 200} height={clipY - vb.y + 100} />
          </clipPath>
        </defs>
      )}
      {sorted.map((item, idx) => {
        const v = views.get(item.id)!;
        const pick = (id: string) => (flat ? urls[flatId(id)] : undefined) ?? urls[id];
        const url = pick(v.image) ?? (v.closed ? pick(v.closed) : undefined);
        if (!url) return null;
        const r = v.rect;
        // 塞进去的上衣在裤腰以下截断
        const clip = clipY !== null && item === tuckedTop ? `url(#${clipId})` : undefined;
        const image = (
          <image
            className="garment"
            data-styling={clip ? 'tucked' : isOpen(item, styling) ? 'open' : undefined}
            href={url}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            preserveAspectRatio="none"
            style={{ animationDelay: `${idx * 70}ms`, cursor: editable ? 'grab' : undefined }}
            onPointerDown={editable ? (e: React.PointerEvent<SVGImageElement>) => onPointerDown(e, item.id) : undefined}
          />
        );
        // 连帽上衣：摊开的帽子穿着时垂在背后，藏起来
        const hoodId = r.clipTop !== undefined ? `${clipId}-hood-${idx}` : null;
        const inner = v.mirrored ? <g transform={`translate(${2 * (r.x + r.width / 2)} 0) scale(-1 1)`}>{image}</g> : image;
        // 镜像放在外层分组上，避免和入场动画的 transform 冲突
        return (
          <g key={item.id} clipPath={clip}>
            {hoodId && (
              <defs>
                <clipPath id={hoodId}>
                  <rect x={vb.x - 100} y={r.clipTop} width={vb.width + 200} height={vb.height + 200} />
                </clipPath>
              </defs>
            )}
            {hoodId ? <g clipPath={`url(#${hoodId})`}>{inner}</g> : inner}
          </g>
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
