# models

| ファイル | 中身 | 出どころ・使ってよい条件 |
|---|---|---|
| `ultraface-RFB-640.onnx` | 写真の中の人の顔を探す小さなモデル（UltraFace version-RFB-640・1.6MB） | ONNX Model Zoo `validated/vision/body_analysis/ultraface/models/version-RFB-640.onnx`（https://github.com/onnx/models）。元は Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB（MIT License） |

使うのは `src/photos/faces.ts` だけ。写真はこの PC（箱）の中で調べ、外へは送らない。
