// 批量录入：一次选很多张照片（或连续拍），也可以一张照片里摆好几件。
// 每张照片自动去背、取色、按轮廓猜类别，存成"待整理"，最后在待整理页统一确认。

import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../components/Controls';
import { Icon } from '../components/Icon';
import { processPhoto } from '../batch';
import { useStore } from '../store';
import { useUI } from '../ui';

type Mode = 'one' | 'many';
const MODE_LABELS: Record<Mode, string> = { one: '每张拍一件', many: '一张拍好几件' };

interface Job {
  id: number;
  name: string;
  multi: boolean;
  state: 'waiting' | 'working' | 'done' | 'empty' | 'error';
  previews: string[];
  message?: string;
}

export function BatchImport() {
  const store = useStore();
  const ui = useUI();
  const [mode, setMode] = useState<Mode>('one');
  const [jobs, setJobs] = useState<Job[]>([]);
  // 处理循环读这里，界面读 jobs
  const queue = useRef<Job[]>([]);
  const files = useRef(new Map<number, File>());
  const running = useRef(false);
  const alive = useRef(true);
  const seq = useRef(0);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const saved = jobs.reduce((n, j) => n + (j.state === 'done' ? j.previews.length : 0), 0);
  const left = jobs.filter((j) => j.state === 'waiting' || j.state === 'working').length;
  const pendingTotal = store.items.filter((i) => i.status === 'pending').length;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const update = (fn: (js: Job[]) => Job[]) => {
    queue.current = fn(queue.current);
    setJobs(queue.current);
  };
  const patch = (id: number, p: Partial<Job>) => update((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));

  async function run() {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        if (!alive.current) return;
        const next = queue.current.find((j) => j.state === 'waiting');
        if (!next) return;
        const file = files.current.get(next.id);
        if (!file) {
          patch(next.id, { state: 'error', message: '照片读取失败' });
          continue;
        }
        patch(next.id, { state: 'working' });
        try {
          const pieces = await processPhoto(file, next.multi);
          if (!alive.current) return;
          for (const p of pieces) await store.saveItem(p.item, p.images);
          patch(next.id, pieces.length ? { state: 'done', previews: pieces.map((p) => p.preview) } : { state: 'empty' });
        } catch (e) {
          patch(next.id, { state: 'error', message: e instanceof Error ? e.message : '处理失败' });
        } finally {
          files.current.delete(next.id);
        }
      }
    } finally {
      running.current = false;
    }
  }

  function add(list: FileList | null) {
    if (!list || list.length === 0) return;
    const multi = mode === 'many';
    const added: Job[] = [];
    for (const f of Array.from(list)) {
      const id = ++seq.current;
      files.current.set(id, f);
      added.push({ id, name: f.name, multi, state: 'waiting', previews: [] });
    }
    update((js) => [...js, ...added]);
    if (cameraRef.current) cameraRef.current.value = '';
    if (albumRef.current) albumRef.current.value = '';
    void run();
  }

  async function close(next?: () => void) {
    if (left > 0) {
      const ok = await ui.confirm({
        title: `还有 ${left} 张没处理完`,
        body: '现在离开，没处理的照片就不录入了；已经存好的会留在「待整理」里。',
        confirmText: '离开',
      });
      if (!ok) return;
    }
    alive.current = false;
    if (next) next();
    else ui.close();
  }

  const statusText = (j: Job, n: number) => {
    const label = `第 ${n} 张`;
    switch (j.state) {
      case 'waiting':
        return `${label}：排队中`;
      case 'working':
        return `${label}：正在去背、取色…`;
      case 'done':
        return `${label}：存了 ${j.previews.length} 件`;
      case 'empty':
        return `${label}：没找到衣服，换个和衣服反差大的背景再拍`;
      default:
        return `${label}：${j.message ?? '处理失败'}`;
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="批量录入">
      <div className="overlay-inner">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => void close()}>
            <Icon name="close" />
          </button>
          <h1>批量录入</h1>
          <span style={{ width: 40 }} />
        </header>
        <div className="page batch-page">
          <Segmented<Mode> options={['one', 'many']} value={mode} labels={MODE_LABELS} onChange={setMode} />
          <div className="capture-zone batch-zone">
            <div>
              <p style={{ margin: '0 0 14px' }}>
                {mode === 'one'
                  ? '一次可以选很多张，每张照片里放一件。平铺、挂着拍都行。'
                  : '几件衣服平铺在床上或地上，互相隔开一拳宽，拍一张就拆成几件。袜子、配饰、叠好的 T 恤最合适。'}
              </p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => cameraRef.current?.click()}>
                  <Icon name="camera" />
                  拍照
                </button>
                <button type="button" className="btn" onClick={() => albumRef.current?.click()}>
                  <Icon name="image" />
                  从相册选
                </button>
              </div>
            </div>
          </div>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => add(e.target.files)}
          />
          <input
            ref={albumRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="batch-input"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => add(e.target.files)}
          />
          <ul className="tips">
            <li>拍完一张可以接着点「拍照」拍下一张，前面的会在后台处理。</li>
            <li>背景尽量是纯色、和衣服反差大的。白色或带白边、白字的衣服，换深色床单或地板拍。</li>
            <li>类别按衣服轮廓自动猜，存好后在「待整理」里点一下就能改，确认后才参与推荐。</li>
          </ul>

          {jobs.length > 0 && (
            <section className="section" aria-label="处理进度">
              <h2 className="section-title">
                处理进度 <small>{left ? `还剩 ${left} 张` : '全部处理完了'}</small>
              </h2>
              <ol className="batch-list">
                {jobs.map((j, idx) => (
                  <li key={j.id} className={`batch-row ${j.state}`}>
                    <span className="batch-text">{statusText(j, idx + 1)}</span>
                    {j.previews.length > 0 && (
                      <span className="batch-previews">
                        {j.previews.map((src, k) => (
                          <img key={k} src={src} alt="" />
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        {(saved > 0 || pendingTotal > 0) && (
          <div className="batch-bar">
            <span>
              {saved > 0 ? `这次存了 ${saved} 件` : ''}
              {saved > 0 && left ? '，' : ''}
              {left ? '还在处理' : ''}
              {!saved && !left ? `待整理 ${pendingTotal} 件` : ''}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => void close(() => ui.open({ kind: 'review' }))}>
              去整理
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
