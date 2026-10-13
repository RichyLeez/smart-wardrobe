// 网格图最大流 / 最小割（Boykov–Kolmogorov 算法），用于智能去背。
// 每个像素是一个节点，与上下左右四个邻居相连；另外连向"衣物"（源点）和"背景"（汇点）两个端点。
// 容量请使用整数（或乘以系数后取整），避免浮点误差让剩余容量停在极小的正数上。

const NONE = -1;
const TERMINAL = -2;
const ORPHAN = -3;
const INF_D = 1 << 30;

/** 方向：0 = 右，1 = 左，2 = 下，3 = 上；相反方向为 d ^ 1 */
export class GridMaxflow {
  readonly width: number;
  readonly height: number;
  readonly n: number;
  private rcap: Float64Array;
  private tr: Float64Array;
  private parent: Int32Array;
  private sink: Uint8Array;
  private ts: Int32Array;
  private dist: Int32Array;
  private flowValue = 0;
  // 活动节点队列（每个节点最多在队列里出现一次）
  private queue: Int32Array;
  private qHead = 0;
  private qCount = 0;
  private inQueue: Uint8Array;
  // 孤儿节点双端队列
  private orphans: Int32Array;
  private oHead = 0;
  private oCount = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.n = n;
    this.rcap = new Float64Array(n * 4);
    this.tr = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.sink = new Uint8Array(n);
    this.ts = new Int32Array(n);
    this.dist = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.inQueue = new Uint8Array(n);
    this.orphans = new Int32Array(n);
  }

  /** 节点到源点（衣物）和汇点（背景）的容量 */
  setTerminal(i: number, toSource: number, toSink: number): void {
    this.tr[i] = toSource - toSink;
    this.flowValue += Math.min(toSource, toSink);
  }

  /** 节点 i 与右边（dir=0）或下边（dir=2）邻居之间的边，正反方向容量 */
  setEdge(i: number, dir: 0 | 2, cap: number, revCap = cap): void {
    const j = this.head(i * 4 + dir);
    if (j < 0) return;
    this.rcap[i * 4 + dir] = cap;
    this.rcap[j * 4 + (dir ^ 1)] = revCap;
  }

  private head(a: number): number {
    const i = a >> 2;
    const w = this.width;
    switch (a & 3) {
      case 0:
        return (i % w) + 1 < w ? i + 1 : -1;
      case 1:
        return i % w > 0 ? i - 1 : -1;
      case 2:
        return i + w < this.n ? i + w : -1;
      default:
        return i - w >= 0 ? i - w : -1;
    }
  }

  private sister(a: number): number {
    return (this.head(a) << 2) | ((a & 3) ^ 1);
  }

  private setActive(i: number): void {
    if (this.inQueue[i]) return;
    this.inQueue[i] = 1;
    this.queue[(this.qHead + this.qCount) % this.n] = i;
    this.qCount++;
  }

  private nextActive(): number {
    while (this.qCount > 0) {
      const i = this.queue[this.qHead];
      this.qHead = (this.qHead + 1) % this.n;
      this.qCount--;
      this.inQueue[i] = 0;
      if (this.parent[i] !== NONE) return i;
    }
    return -1;
  }

  private orphanFront(i: number): void {
    this.parent[i] = ORPHAN;
    this.oHead = (this.oHead - 1 + this.n) % this.n;
    this.orphans[this.oHead] = i;
    this.oCount++;
  }

  private orphanRear(i: number): void {
    this.parent[i] = ORPHAN;
    this.orphans[(this.oHead + this.oCount) % this.n] = i;
    this.oCount++;
  }

  private popOrphan(): number {
    const i = this.orphans[this.oHead];
    this.oHead = (this.oHead + 1) % this.n;
    this.oCount--;
    return i;
  }

  /** 求最大流，返回流量；之后用 isSource 读取分割结果 */
  maxflow(): number {
    const { parent, sink, tr, rcap, ts, dist } = this;
    for (let i = 0; i < this.n; i++) {
      if (tr[i] > 0) {
        sink[i] = 0;
        parent[i] = TERMINAL;
        ts[i] = 0;
        dist[i] = 1;
        this.setActive(i);
      } else if (tr[i] < 0) {
        sink[i] = 1;
        parent[i] = TERMINAL;
        ts[i] = 0;
        dist[i] = 1;
        this.setActive(i);
      } else {
        parent[i] = NONE;
      }
    }
    let time = 0;
    let current = -1;
    for (;;) {
      let i = -1;
      if (current >= 0 && parent[current] !== NONE) i = current;
      current = -1;
      if (i < 0) {
        i = this.nextActive();
        if (i < 0) break;
      }
      // 生长：从 i 向外找邻居
      let mid = -1;
      if (!sink[i]) {
        for (let d = 0; d < 4; d++) {
          const a = i * 4 + d;
          if (!(rcap[a] > 0)) continue;
          const j = this.head(a);
          if (parent[j] === NONE) {
            sink[j] = 0;
            parent[j] = this.sister(a);
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
            this.setActive(j);
          } else if (sink[j]) {
            mid = a;
            break;
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = this.sister(a);
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
          }
        }
      } else {
        for (let d = 0; d < 4; d++) {
          const a = i * 4 + d;
          const j = this.head(a);
          if (j < 0) continue;
          const sa = this.sister(a);
          if (!(rcap[sa] > 0)) continue;
          if (parent[j] === NONE) {
            sink[j] = 1;
            parent[j] = sa;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
            this.setActive(j);
          } else if (!sink[j]) {
            mid = sa;
            break;
          } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = sa;
            ts[j] = ts[i];
            dist[j] = dist[i] + 1;
          }
        }
      }
      time++;
      if (mid >= 0) {
        current = i;
        this.augment(mid);
        while (this.oCount > 0) {
          const o = this.popOrphan();
          if (sink[o]) this.adoptSink(o, time);
          else this.adoptSource(o, time);
        }
      }
    }
    return this.flowValue;
  }

  private augment(mid: number): void {
    const { parent, rcap, tr } = this;
    let bottleneck = rcap[mid];
    let i = mid >> 2;
    for (;;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      const c = rcap[this.sister(a)];
      if (c < bottleneck) bottleneck = c;
      i = this.head(a);
    }
    if (tr[i] < bottleneck) bottleneck = tr[i];
    i = this.head(mid);
    for (;;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      if (rcap[a] < bottleneck) bottleneck = rcap[a];
      i = this.head(a);
    }
    if (-tr[i] < bottleneck) bottleneck = -tr[i];

    rcap[this.sister(mid)] += bottleneck;
    rcap[mid] -= bottleneck;
    i = mid >> 2;
    for (;;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      const sa = this.sister(a);
      rcap[a] += bottleneck;
      rcap[sa] -= bottleneck;
      const next = this.head(a);
      if (rcap[sa] === 0) this.orphanFront(i);
      i = next;
    }
    tr[i] -= bottleneck;
    if (tr[i] === 0) this.orphanFront(i);
    i = this.head(mid);
    for (;;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      rcap[this.sister(a)] += bottleneck;
      rcap[a] -= bottleneck;
      const next = this.head(a);
      if (rcap[a] === 0) this.orphanFront(i);
      i = next;
    }
    tr[i] += bottleneck;
    if (tr[i] === 0) this.orphanFront(i);
    this.flowValue += bottleneck;
  }

  /** 沿父节点追溯到端点的距离；途中遇到孤儿返回无穷大 */
  private originDistance(j: number, time: number): number {
    const { parent, ts, dist } = this;
    let d = 0;
    let k = j;
    for (;;) {
      if (ts[k] === time) {
        d += dist[k];
        break;
      }
      const a = parent[k];
      d++;
      if (a === TERMINAL) {
        ts[k] = time;
        dist[k] = 1;
        break;
      }
      if (a === ORPHAN) return INF_D;
      k = this.head(a);
    }
    // 沿路标记，后面的查询可以直接复用
    for (k = j; ts[k] !== time; k = this.head(parent[k])) {
      ts[k] = time;
      dist[k] = d--;
    }
    return ts[j] === time ? dist[j] : INF_D;
  }

  private adoptSource(i: number, time: number): void {
    const { parent, sink, rcap, ts, dist } = this;
    let best = -1;
    let bestD = INF_D;
    for (let d = 0; d < 4; d++) {
      const a0 = i * 4 + d;
      const j = this.head(a0);
      if (j < 0) continue;
      if (!(rcap[this.sister(a0)] > 0)) continue;
      if (sink[j] || parent[j] === NONE) continue;
      const dd = this.originDistance(j, time);
      if (dd < bestD) {
        best = a0;
        bestD = dd;
      }
    }
    if (best >= 0) {
      parent[i] = best;
      ts[i] = time;
      dist[i] = bestD + 1;
      return;
    }
    parent[i] = NONE;
    for (let d = 0; d < 4; d++) {
      const a0 = i * 4 + d;
      const j = this.head(a0);
      if (j < 0 || sink[j] || parent[j] === NONE) continue;
      if (rcap[this.sister(a0)] > 0) this.setActive(j);
      const pa = parent[j];
      if (pa !== TERMINAL && pa !== ORPHAN && this.head(pa) === i) this.orphanRear(j);
    }
  }

  private adoptSink(i: number, time: number): void {
    const { parent, sink, rcap, ts, dist } = this;
    let best = -1;
    let bestD = INF_D;
    for (let d = 0; d < 4; d++) {
      const a0 = i * 4 + d;
      const j = this.head(a0);
      if (j < 0) continue;
      if (!(rcap[a0] > 0)) continue;
      if (!sink[j] || parent[j] === NONE) continue;
      const dd = this.originDistance(j, time);
      if (dd < bestD) {
        best = a0;
        bestD = dd;
      }
    }
    if (best >= 0) {
      parent[i] = best;
      ts[i] = time;
      dist[i] = bestD + 1;
      return;
    }
    parent[i] = NONE;
    for (let d = 0; d < 4; d++) {
      const a0 = i * 4 + d;
      const j = this.head(a0);
      if (j < 0 || !sink[j] || parent[j] === NONE) continue;
      if (rcap[a0] > 0) this.setActive(j);
      const pa = parent[j];
      if (pa !== TERMINAL && pa !== ORPHAN && this.head(pa) === i) this.orphanRear(j);
    }
  }

  /** 最小割之后，节点是否在源点（衣物）一侧 */
  isSource(i: number): boolean {
    return this.parent[i] !== NONE && !this.sink[i];
  }
}
