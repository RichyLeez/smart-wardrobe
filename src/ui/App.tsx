import { Component, useEffect, type ReactNode } from 'react';
import { Icon } from './components/Icon';
import { BuilderPage } from './pages/Builder';
import { ItemEditor } from './pages/ItemEditor';
import { RecordEditor } from './pages/RecordEditor';
import { RecordsPage } from './pages/Records';
import { SettingsPage } from './pages/Settings';
import { TodayPage } from './pages/Today';
import { MatchPage } from './pages/MatchPage';
import { Viewer3D } from './pages/Viewer3D';
import { WardrobePage } from './pages/Wardrobe';
import { openPermissionPanel } from '../storage/db';
import { StoreProvider, useStore } from './store';
import { UIProvider, useUI, type Tab } from './ui';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'today', label: '今日', icon: 'today' },
  { key: 'wardrobe', label: '衣橱', icon: 'wardrobe' },
  { key: 'builder', label: '试搭', icon: 'builder' },
  { key: 'records', label: '记录', icon: 'records' },
];

/** 页面出错时显示原因和重试按钮，而不是一片空白。已保存的数据不受影响。 */
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    // 切换页面后自动清除错误状态
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" style={{ paddingTop: 32 }}>
        <div className="warnbox">
          这个页面出了问题：{this.state.error.message}
          <br />
          已经保存的数据没有受到影响。可以切换到其他页面，或刷新后重试。
        </div>
        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => location.reload()}>
          刷新页面
        </button>
      </div>
    );
  }
}

const BOOT_TEXT = {
  start: '正在打开衣橱…',
  permission: '第一次打开，需要你允许页面保存数据',
  connecting: '正在连接你的云端衣橱…',
  loading: '正在读取衣橱…',
} as const;

/** 启动中的说明：始终告诉用户在等什么，等久了给出可操作的选项 */
function BootScreen() {
  const store = useStore();
  const ui = useUI();
  const { stage, slow } = store.boot;
  return (
    <div className="page boot">
      <h1 className="boot-title">智能衣橱</h1>
      <p className="boot-msg" role="status">
        {BOOT_TEXT[stage]}
      </p>
      {stage === 'permission' && (
        <p className="small muted">
          Claude 会弹出提示，询问是否允许这个页面保存数据。点允许后，衣物、照片和记录会保存在你的账号下，只有你自己能看到。
        </p>
      )}
      {slow && (
        <div className="boot-slow">
          <p className="small muted">
            {stage === 'permission'
              ? '没有看到授权提示的话，可以打开权限设置手动允许，或者先用本机模式。'
              : '云端一直没有响应。可以继续等一会儿，或者先用本机模式：这次的修改只保存在这个浏览器里，下次打开页面会重新连接云端。'}
          </p>
          <div className="row row-wrap">
            {stage === 'permission' && (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  if (!(await openPermissionPanel())) ui.toast('打不开权限设置，请在页面右上角的菜单里找到权限');
                }}
              >
                打开权限设置
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => void store.switchToLocal()}>
              先用本机模式
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const ui = useUI();
  const store = useStore();
  const overlay = ui.overlay;

  // 覆盖层打开时锁住背后页面的滚动
  useEffect(() => {
    document.body.style.overflow = overlay ? 'hidden' : '';
  }, [overlay]);

  // 启动完成后，页面级的出错提示（index.html 里的小脚本）不再弹出
  useEffect(() => {
    if (store.ready) (window as unknown as { __wardrobeBooted?: boolean }).__wardrobeBooted = true;
  }, [store.ready]);

  return (
    <>
      <main className="app" aria-hidden={overlay ? true : undefined}>
        {store.error && (
          <div className="page" style={{ paddingTop: 16 }}>
            <div className="warnbox">{store.error}</div>
          </div>
        )}
        {store.storage?.hosted && store.storage.mode !== 'cloud' && (
          <div className="page" style={{ paddingTop: 12 }}>
            <div className="warnbox">
              云端存储不可用{store.storage.note ? `（${store.storage.note}）` : ''}，
              {store.storage.mode === 'memory' ? '刷新页面后录入的内容会丢失。' : '现在的数据只保存在这个浏览器里。'}
              登录 Claude 后重新打开这个页面即可同步。
            </div>
          </div>
        )}
        {store.ready ? (
          <ErrorBoundary resetKey={ui.tab}>
            {ui.tab === 'today' && <TodayPage />}
            {ui.tab === 'wardrobe' && <WardrobePage />}
            {ui.tab === 'builder' && <BuilderPage />}
            {ui.tab === 'records' && <RecordsPage />}
          </ErrorBoundary>
        ) : (
          <BootScreen />
        )}
      </main>
      <nav className="tabbar" aria-label="主导航">
        <div className="tabbar-inner">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="tab"
              aria-current={ui.tab === t.key ? 'page' : undefined}
              onClick={() => {
                ui.close();
                ui.go(t.key);
              }}
            >
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <ErrorBoundary resetKey={overlay ? `${overlay.kind}-${overlay.nonce}` : 'none'}>
        {overlay?.kind === 'item' && <ItemEditor key={overlay.nonce} id={overlay.id} />}
        {overlay?.kind === 'record' && <RecordEditor key={overlay.nonce} draft={overlay.draft} />}
        {overlay?.kind === 'settings' && <SettingsPage />}
        {overlay?.kind === 'match' && <MatchPage key={overlay.nonce} itemId={overlay.itemId} />}
        {overlay?.kind === 'view3d' && <Viewer3D key={overlay.nonce} itemIds={overlay.itemIds} layout={overlay.layout} title={overlay.title} />}
      </ErrorBoundary>
    </>
  );
}

export function App() {
  return (
    <StoreProvider>
      <UIProvider>
        <Shell />
      </UIProvider>
    </StoreProvider>
  );
}
