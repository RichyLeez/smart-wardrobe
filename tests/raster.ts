// 测试用的简易矢量栅格化：支持 M / L / Q / Z 路径（填充或描边）和矩形，
// 用来把示例衣橱的轮廓画成蒙版，检验按轮廓猜类别。

export interface Shape {
  d?: string;
  rect?: [number, number, number, number];
  dx?: number;
  dy?: number;
  /** 只描边不填充时的线宽 */
  stroke?: number;
}

function flatten(d: string, dx: number, dy: number): Array<Array<[number, number]>> {
  const tokens = d.match(/[MLQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const polys: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let i = 0;
  let cmd = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLQZ]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'M') {
      if (cur.length) polys.push(cur);
      cur = [[num() + dx, num() + dy]];
      cmd = 'L';
    } else if (cmd === 'L') {
      cur.push([num() + dx, num() + dy]);
    } else if (cmd === 'Q') {
      const [x0, y0] = cur[cur.length - 1];
      const cx = num() + dx;
      const cy = num() + dy;
      const x1 = num() + dx;
      const y1 = num() + dy;
      for (let t = 0.1; t <= 1.0001; t += 0.1) {
        const u = 1 - t;
        cur.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
      }
    } else if (cmd === 'Z') {
      polys.push(cur);
      cur = [];
      cmd = '';
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

function insidePoly(poly: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

function nearPolyline(poly: Array<[number, number]>, x: number, y: number, r: number): boolean {
  for (let k = 1; k < poly.length; k++) {
    const [x0, y0] = poly[k - 1];
    const [x1, y1] = poly[k];
    const vx = x1 - x0;
    const vy = y1 - y0;
    const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy || 1)));
    if (Math.hypot(x - (x0 + vx * t), y - (y0 + vy * t)) <= r) return true;
  }
  return false;
}

/** 把形状画成 w×h（形状坐标乘以 scale，四周留 pad 像素）的不透明度蒙版 */
export function raster(shapes: Shape[], viewW: number, viewH: number, scale = 2, pad = 20) {
  const w = Math.round(viewW * scale) + pad * 2;
  const h = Math.round(viewH * scale) + pad * 2;
  const alpha = new Uint8Array(w * h);
  const prepared = shapes.map((s) => ({
    s,
    polys: s.d ? flatten(s.d, s.dx ?? 0, s.dy ?? 0) : [],
  }));
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px - pad + 0.5) / scale;
      const y = (py - pad + 0.5) / scale;
      let on = false;
      for (const { s, polys } of prepared) {
        if (s.rect) {
          const [rx, ry, rw, rh] = s.rect;
          if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) on = true;
        } else if (s.stroke) {
          if (polys.some((p) => nearPolyline(p, x, y, s.stroke! / 2))) on = true;
        } else if (polys.some((p) => insidePoly(p, x, y))) on = true;
        if (on) break;
      }
      if (on) alpha[py * w + px] = 255;
    }
  }
  return { alpha, w, h };
}
