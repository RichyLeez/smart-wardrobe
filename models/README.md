# 抠图模型

`u2net.bin` 由 U²-Net 转换而来，用于在浏览器里识别照片中的衣服（`scripts/model/convert_u2net.py`）。

- 模型：U²-Net — Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane, Martin Jagersand,
  "U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection", Pattern Recognition 2020。
  代码与权重：https://github.com/xuebinqin/U-2-Net ，Apache License 2.0（见 `LICENSE-U2Net.txt`）。
- 转换所用的 ONNX 文件：https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
  （sha256 8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491）。
- 修改：去掉只用于计算尺寸的算子，ReLU/Sigmoid 合并进卷积；参数量 ≥ 100 万的卷积层权重按输出通道量化为 int8，
  其余存为 float16。和原模型相比，测试照片上 0.5 阈值的蒙版一致率 99.1%～100%。
