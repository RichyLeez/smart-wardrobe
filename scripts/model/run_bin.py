# 用 numpy 执行 public/models/u2net.bin（参考实现），检查和原始 ONNX 模型的输出是否一致。
# 用法：python3 scripts/model/run_bin.py u2net.bin [u2net.onnx] 图片...
import json, struct, sys
import numpy as np
from PIL import Image

def read(path):
  b = open(path, 'rb').read()
  assert b[:4] == b'U2NB'
  ver, hl = struct.unpack('<II', b[4:12])
  head = json.loads(b[12:12 + hl])
  data = b[12 + hl:]
  return head, data

def conv(x, w, b, dil, k):
  C, H, W = x.shape
  O = w.shape[0]
  if k == 1:
    return (w.reshape(O, C) @ x.reshape(C, -1)).reshape(O, H, W) + b[:, None, None]
  p = dil
  xp = np.pad(x, ((0, 0), (p, p), (p, p)))
  cols = np.empty((C, 3, 3, H, W), np.float32)
  for i in range(3):
    for j in range(3):
      cols[:, i, j] = xp[:, i * dil:i * dil + H, j * dil:j * dil + W]
  return (w.reshape(O, -1) @ cols.reshape(C * 9, H * W)).reshape(O, H, W) + b[:, None, None]

def pool(x):
  C, H, W = x.shape
  Ho, Wo = -(-H // 2), -(-W // 2)
  xp = np.full((C, Ho * 2, Wo * 2), -np.inf, np.float32)
  xp[:, :H, :W] = x
  return xp.reshape(C, Ho, 2, Wo, 2).max(axis=(2, 4))

def resize(x, Ho, Wo):
  C, H, W = x.shape
  def coords(o, i):
    c = np.clip((np.arange(o) + 0.5) * (i / o) - 0.5, 0, i - 1)
    lo = np.floor(c).astype(int)
    return lo, np.minimum(lo + 1, i - 1), (c - lo).astype(np.float32)
  yl, yh, fy = coords(Ho, H)
  xl, xh, fx = coords(Wo, W)
  r0 = x[:, yl]
  r1 = x[:, yh]
  fx = fx[None, None]
  fy = fy[None, :, None]
  return (r0[:, :, xl] * (1 - fx) + r0[:, :, xh] * fx) * (1 - fy) + (r1[:, :, xl] * (1 - fx) + r1[:, :, xh] * fx) * fy

def forward(head, data, x):
  T = {0: x}
  for op in head['ops']:
    t = op['t']
    if t == 'conv':
      inp = np.concatenate([T[i] for i in op['ins']], 0)
      O, I, k = op['o'], op['i'], op['k']
      if op['q'] == 'i8':
        q = np.frombuffer(data, np.int8, O * I * k * k, op['w']).astype(np.float32).reshape(O, I, k, k)
        w = q * np.frombuffer(data, np.float32, O, op['s'])[:, None, None, None]
      else:
        w = np.frombuffer(data, '<f2', O * I * k * k, op['w']).astype(np.float32).reshape(O, I, k, k)
      b = np.frombuffer(data, np.float32, O, op['b'])
      y = conv(inp, w, b, op['dil'], k)
      if op['relu']: y = np.maximum(y, 0)
      if op['sigmoid']: y = 1 / (1 + np.exp(-y))
      T[op['out']] = y
    elif t == 'pool':
      T[op['out']] = pool(T[op['in']])
    elif t == 'resize':
      ref = T[op['like']]
      T[op['out']] = resize(T[op['in']], ref.shape[1], ref.shape[2])
    elif t == 'add':
      T[op['out']] = T[op['a']] + T[op['b']]
  return T[head['output']][0]

def preprocess(head, img):
  n = head['inputSize']
  x = np.asarray(img.convert('RGB').resize((n, n), Image.BILINEAR)).astype(np.float32) / 255
  x = x / max(x.max(), 1e-6)
  x = (x - np.array(head['mean'], np.float32)) / np.array(head['std'], np.float32)
  return x.transpose(2, 0, 1).astype(np.float32)

if __name__ == '__main__':
  head, data = read(sys.argv[1])
  onnx = sys.argv[2] if sys.argv[2].endswith('.onnx') else None
  imgs = sys.argv[3:] if onnx else sys.argv[2:]
  sess = None
  if onnx:
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx, providers=['CPUExecutionProvider'])
  for f in imgs:
    x = preprocess(head, Image.open(f))
    y = forward(head, data, x)
    msg = f'{f.rsplit("/", 1)[-1]}: mean {y.mean():.4f}'
    if sess:
      r = sess.run(None, {sess.get_inputs()[0].name: x[None]})[0][0, 0]
      msg += f'  max |int8 - fp32| {np.abs(y - r).max():.4f}  mask agreement {((y > 0.5) == (r > 0.5)).mean():.4f}'
    print(msg)
