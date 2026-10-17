# 最小的 ONNX protobuf 解析（不依赖 onnx 包）：节点、属性、权重
import struct, numpy as np
def varint(b, i):
  r = 0; s = 0
  while True:
    c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
    if c < 0x80: return r, i
def fields(b):
  i = 0; n = len(b)
  while i < n:
    key, i = varint(b, i); f = key >> 3; t = key & 7
    if t == 0: v, i = varint(b, i)
    elif t == 1: v = b[i:i+8]; i += 8
    elif t == 2:
      l, i = varint(b, i); v = b[i:i+l]; i += l
    elif t == 5: v = b[i:i+4]; i += 4
    else: raise ValueError(t)
    yield f, t, v
def packed(v, t):
  if t == 0: return [v]
  out = []; i = 0
  while i < len(v):
    x, i = varint(v, i); out.append(x)
  return out
def sint(x):
  return x - (1 << 64) if x >= (1 << 63) else x
DT = {1: np.float32, 10: np.float16, 7: np.int64, 6: np.int32, 11: np.float64, 2: np.uint8, 3: np.int8}
def tensor(b):
  dims = []; dt = 1; raw = None; fl = []; i64 = []; name = ''
  for f, t, v in fields(b):
    if f == 1: dims += [sint(x) for x in packed(v, t)]
    elif f == 2: dt = v
    elif f == 4: fl += list(struct.unpack(f'<{len(v)//4}f', v)) if t == 2 else [struct.unpack('<f', v)[0]]
    elif f == 7: i64 += [sint(x) for x in packed(v, t)]
    elif f == 8: name = v.decode()
    elif f == 9: raw = v
  if raw is not None: arr = np.frombuffer(raw, dtype=DT[dt]).copy()
  elif fl: arr = np.array(fl, np.float32)
  else: arr = np.array(i64, np.int64)
  return name, arr.reshape(dims) if dims else (arr.reshape(()) if arr.size == 1 else arr)
def attr(b):
  name = ''; val = None; ints = []; floats = []
  for f, t, v in fields(b):
    if f == 1: name = v.decode()
    elif f == 2: val = struct.unpack('<f', v)[0]
    elif f == 3: val = sint(v)
    elif f == 4: val = v.decode(errors='replace')
    elif f == 5: val = tensor(v)[1]
    elif f == 7: floats += list(struct.unpack(f'<{len(v)//4}f', v)) if t == 2 else [struct.unpack('<f', v)[0]]
    elif f == 8: ints += [sint(x) for x in packed(v, t)]
  if ints: val = ints
  if floats: val = floats
  return name, val
def node(b):
  d = {'in': [], 'out': [], 'op': '', 'attrs': {}, 'name': ''}
  for f, t, v in fields(b):
    if f == 1: d['in'].append(v.decode())
    elif f == 2: d['out'].append(v.decode())
    elif f == 3: d['name'] = v.decode()
    elif f == 4: d['op'] = v.decode()
    elif f == 5:
      k, val = attr(v); d['attrs'][k] = val
  return d
def valueinfo(b):
  for f, t, v in fields(b):
    if f == 1: return v.decode()
def load(path):
  b = open(path, 'rb').read()
  graph = None; opset = None
  for f, t, v in fields(b):
    if f == 7: graph = v
  nodes = []; inits = {}; inputs = []; outputs = []
  for f, t, v in fields(graph):
    if f == 1: nodes.append(node(v))
    elif f == 5:
      n, a = tensor(v); inits[n] = a
    elif f == 11: inputs.append(valueinfo(v))
    elif f == 12: outputs.append(valueinfo(v))
  return nodes, inits, [i for i in inputs if i not in inits], outputs
