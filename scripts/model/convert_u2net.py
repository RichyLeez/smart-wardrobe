# 把 U²-Net 的 ONNX 模型转换成浏览器里用的精简格式（public/models/u2net.bin）。
#
# 用法：python3 scripts/model/convert_u2net.py u2net.onnx public/models/u2net.bin
# 模型来源：https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
#   （U²-Net，Qin et al. 2020，https://github.com/xuebinqin/U-2-Net ，Apache-2.0）
#   sha256 8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491
#
# 精简：
#   - 只保留算出最终输出（融合后的 d0）需要的算子；计算尺寸用的 Shape/Gather/Slice 等丢掉；
#   - Conv 后面紧跟的 Relu、Sigmoid 合进 Conv；
#   - Concat 不单独执行：下一个 Conv 直接读几个输入（按通道依次拼起来）；
#   - Resize（双线性）的目标尺寸取它所在 Concat 里另一路的尺寸。
# 权重：参数量 ≥ 100 万的大层按输出通道对称量化成 int8（每个输出通道一个缩放系数），
# 其余小层存 float16（小层对量化很敏感，全部 int8 时杂乱照片上约 8% 的像素会翻转）；偏置保留 float32。
#
# 文件格式（小端）：
#   'U2NB' | uint32 版本(1) | uint32 头长度 | 头（UTF-8 JSON，补齐到 4 字节） | 数据区
#   头：{ inputSize, mean, std, output, tensors: [通道数...], ops: [...] }
#   op：{ t:'conv', out, ins:[张量...], k, dil, relu, sigmoid, o, i, q:'i8'|'f16', w(数据区偏移), s(仅 i8), b }
#       { t:'pool', out, in } { t:'resize', out, in, like } { t:'add', out, a, b }
#   张量 0 是输入（3 通道）。

import json, struct, sys, hashlib
import numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from onnxparse import load

SHAPE_OPS = {'Shape', 'Gather', 'Unsqueeze', 'Cast', 'Slice', 'Constant'}

def convert(src, dst):
  nodes, inits, ins, outs = load(src)
  prod = {o: n for n in nodes for o in n['out']}
  cons = {}
  for n in nodes:
    for i in n['in']:
      cons.setdefault(i, []).append(n)
  final = outs[0]
  # 从最终输出往回找需要的节点
  need = set()
  stack = [final]
  while stack:
    t = stack.pop()
    n = prod.get(t)
    if n is None or id(n) in need or n['op'] in SHAPE_OPS:
      continue
    need.add(id(n))
    for i in n['in']:
      if i and i not in inits:
        stack.append(i)
  order = [n for n in nodes if id(n) in need]

  tid = {ins[0]: 0}
  chans = [3]
  alias = {}  # Relu/Sigmoid 合并后，输出名指向 Conv 的张量

  def T(name):
    name = alias.get(name, name)
    return tid[name]

  def new(name, c):
    tid[name] = len(chans)
    chans.append(c)
    return tid[name]

  ops = []
  blobs = []
  offset = 0

  def add_blob(b):
    nonlocal offset
    pad = (-len(b)) % 4
    blobs.append(b + b'\0' * pad)
    o = offset
    offset += len(b) + pad
    return o

  qerr = []
  for n in order:
    op = n['op']
    if op == 'Conv':
      W = inits[n['in'][1]].astype(np.float32)
      B = inits[n['in'][2]].astype(np.float32) if len(n['in']) > 2 else np.zeros(W.shape[0], np.float32)
      a = n['attrs']
      k = W.shape[2]
      dil = a.get('dilations', [1, 1])[0]
      pads = a.get('pads', [0, 0, 0, 0])
      assert a.get('strides', [1, 1]) == [1, 1] and a.get('group', 1) == 1
      assert pads[0] == (dil * (k - 1)) // 2, (pads, dil, k)
      src_t = n['in'][0]
      p = prod.get(src_t)
      if p is not None and p['op'] == 'Concat':
        inputs = [T(x) for x in p['in']]
      else:
        inputs = [T(src_t)]
      assert sum(chans[i] for i in inputs) == W.shape[1]
      out_name = n['out'][0]
      nxt = cons.get(out_name, [])
      relu = len(nxt) >= 1 and all(c['op'] == 'Relu' for c in nxt if c['op'] not in SHAPE_OPS) and any(c['op'] == 'Relu' for c in nxt)
      sigmoid = out_name != final and any(c['op'] == 'Sigmoid' for c in nxt) and prod.get(final) in nxt
      O = W.shape[0]
      flat = W.reshape(O, -1)
      big = flat.size >= 1_000_000
      out_id = new(out_name, O)
      if relu:
        for c in nxt:
          if c['op'] == 'Relu':
            alias[c['out'][0]] = out_name
      if sigmoid:
        alias[final] = out_name
      entry = {
        't': 'conv', 'out': out_id, 'ins': inputs, 'k': int(k), 'dil': int(dil),
        'relu': bool(relu), 'sigmoid': bool(sigmoid), 'o': int(O), 'i': int(W.shape[1]),
      }
      if big:
        scale = np.maximum(np.abs(flat).max(axis=1), 1e-12) / 127.0
        q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8)
        qerr.append(float(np.abs(q * scale[:, None] - flat).max() / (np.abs(flat).max() + 1e-12)))
        entry.update(q='i8', w=add_blob(q.tobytes()), s=add_blob(scale.astype(np.float32).tobytes()))
      else:
        entry.update(q='f16', w=add_blob(flat.astype('<f2').tobytes()))
      entry['b'] = add_blob(B.astype(np.float32).tobytes())
      ops.append(entry)
    elif op == 'Relu':
      assert n['out'][0] in alias, 'Relu 必须紧跟在 Conv 后面'
    elif op == 'Sigmoid':
      assert n['out'][0] in alias
    elif op == 'MaxPool':
      a = n['attrs']
      assert a['kernel_shape'] == [2, 2] and a['strides'] == [2, 2] and a.get('ceil_mode') == 1
      ops.append({'t': 'pool', 'out': new(n['out'][0], chans[T(n['in'][0])]), 'in': T(n['in'][0])})
    elif op == 'Resize':
      a = n['attrs']
      assert a['mode'] == 'linear' and a['coordinate_transformation_mode'] in ('pytorch_half_pixel', 'half_pixel')
      (c,) = [c for c in cons[n['out'][0]] if c['op'] == 'Concat']
      like = [x for x in c['in'] if x != n['out'][0]][0]
      ops.append({'t': 'resize', 'out': new(n['out'][0], chans[T(n['in'][0])]), 'in': T(n['in'][0]), 'like': T(like)})
    elif op == 'Add':
      a, b = T(n['in'][0]), T(n['in'][1])
      ops.append({'t': 'add', 'out': new(n['out'][0], chans[a]), 'a': a, 'b': b})
    elif op == 'Concat':
      pass
    else:
      raise NotImplementedError(op)

  header = {
    'name': 'u2net', 'inputSize': 320,
    'mean': [0.485, 0.456, 0.406], 'std': [0.229, 0.224, 0.225],
    'output': T(final), 'tensors': chans, 'ops': ops,
  }
  hj = json.dumps(header, separators=(',', ':')).encode()
  hj += b' ' * ((-len(hj)) % 4)
  data = b''.join(blobs)
  with open(dst, 'wb') as f:
    f.write(b'U2NB' + struct.pack('<II', 1, len(hj)) + hj + data)
  print(f'{len(ops)} ops ({sum(o["t"] == "conv" for o in ops)} conv), {len(chans)} tensors, '
        f'{(12 + len(hj) + len(data)) / 1e6:.1f} MB, max relative quantization error {max(qerr):.4f}')
  print('sha256', hashlib.sha256(open(dst, 'rb').read()).hexdigest())

if __name__ == '__main__':
  convert(sys.argv[1], sys.argv[2])
