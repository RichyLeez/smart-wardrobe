// 3D 查看：全屏显示一套穿搭的 3D 人台。

import { useMemo } from 'react';
import { hiddenFromBack } from '../../core/body';
import type { GarmentLook, Item, Placement } from '../../core/types';
import { Segmented } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Mannequin3D } from '../components/Mannequin3D';
import { useStore } from '../store';
import { useUI } from '../ui';

export const LOOK_LABELS: Record<GarmentLook, string> = { flat: '简化图形', photo: '照片' };

/** 拍背面有意义的类别 */
const BACK_MATTERS = new Set(['top', 'bottom', 'dress', 'outer']);

export function Viewer3D({ itemIds, layout, title }: { itemIds: string[]; layout?: Record<string, Placement>; title?: string }) {
  const store = useStore();
  const ui = useUI();
  const items = useMemo(
    () => itemIds.map((id) => store.items.find((i) => i.id === id)).filter((i): i is Item => !!i),
    [itemIds, store.items],
  );
  const noBack = items.filter((i) => BACK_MATTERS.has(i.category) && !i.images.backCutout && !hiddenFromBack(i));
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="3D 查看">
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => ui.close()}>
            <Icon name="close" />
          </button>
          <h1>{title ?? '3D 查看'}</h1>
          <span style={{ width: 40 }} />
        </header>
        <div className="page viewer3d-page">
          {items.length === 0 ? (
            <p className="muted">这套里的单品已经被删除了。</p>
          ) : (
            <Mannequin3D body={store.settings.body} items={items} layout={layout} />
          )}
          <div className="look-row">
            <span className="small muted">衣服显示为</span>
            <Segmented<GarmentLook>
              options={['flat', 'photo']}
              value={store.settings.garmentLook ?? 'flat'}
              labels={LOOK_LABELS}
              onChange={(v) => void store.updateSettings({ garmentLook: v })}
            />
          </div>
          <p className="small muted">
            拖动转动，双指缩放。人台按{store.settings.body ? '你的身材数据' : '默认身材'}生成，衣服用你拍的照片包裹，用来看配色和层次，不代表真实的布料和版型效果。
          </p>
          {noBack.length > 0 && (
            <p className="small muted">
              {noBack.map((i) => i.name).join('、')}还没有背面照片，背面先用正面照片的颜色代替。在衣橱里打开单品，点「拍背面」就能补上。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
