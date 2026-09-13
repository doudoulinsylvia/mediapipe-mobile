# MGazeNet 浏览器图像输入适配

此目录只提供输入预处理与合成算子验证。`preprocess.js` 不访问摄像头，不运行神经网络，也不输出屏幕注视坐标或准确率。

契约依据 GazeFollower 提交 `7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa` 的实际代码：

- [MGazeNetGazeEstimator.py](https://github.com/GanchengZhu/GazeFollower/blob/7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa/gazefollower/gaze_estimator/MGazeNetGazeEstimator.py)：face 224×224、left/right 112×112，RGB uint8 先 resize，再 float32 除255，仅 right 在 resize 后水平翻转。Python placeholder 是 NHWC；模型底层报告NCHW不改变这些打包张量的NHWC约定，MNN调用端需要正确声明源布局。
- [MediaPipeFaceAlignment.py](https://github.com/GanchengZhu/GazeFollower/blob/7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa/gazefollower/face_alignment/MediaPipeFaceAlignment.py)：脸和眼睛ROI、像素取整、眼睛边界过滤以及眼部多边形面积。
- [WebCamCamera.py](https://github.com/GanchengZhu/GazeFollower/blob/7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa/gazefollower/camera/WebCamCamera.py)：实际视频链路在进入检测器前将BGR转为RGB；对齐器文档字符串中的BGR描述不能替代执行链路。

## API

CommonJS 与无DOM浏览器UMD均可用，浏览器全局名为 `MGazePreprocess`。

```javascript
const rois = MGazePreprocess.roisFromLandmarks(landmarks, image.width, image.height);
if (!rois.ok) {
  // 保留 rois.reason；当前帧不送入模型。
} else {
  const tensors = MGazePreprocess.prepareInputs({
    rgba: image.data, width: image.width, height: image.height,
    face: rois.face, leftEye: rois.leftEye, rightEye: rois.rightEye,
    sourceMirrored: false
  });
  // tensors.face / left / right / rect 各为 {data:Float32Array, shape:[...]}
  // 此处再交给独立的MNN运行模块；预处理本身不运行推理。
}
```

`roisFromLandmarks` 接受未镜像来源图像的478个归一化 `{x,y,z}` FaceMesh点，返回 `{ok,reason,face,leftEye,rightEye,diagnostics}`。ROI生成复制上游的 NumPy ties-to-even 像素取整、Python整数截断、脸框调整和严格眼边界检查：模型left用33/133，right用362/263，标签不能按CSS预览左右位置重新命名。输入点不会被修改。仅ROI需要的x/y被使用；z不进入这些矩形。

异常输入显式拒绝：非有限坐标、错误点数、int16范围溢出、空或倒置ROI。溢出及空ROI拒绝比原Python更严格，避免复现原代码的int16溢出或空裁剪。脸框按原代码调整/限制；`prepareInputs` 接受显式ROI时不偷偷裁切越界矩形。

`prepareInputs` 接受未预乘alpha的RGBA uint8数据（如ImageData）；alpha不参与RGB模型输入。ROI格式固定为来源图像像素整数 `{x,y,width,height}`，右/下端点排他。输入长度必须严格等于`width*height*4`。页面CSS大小、DPR和屏幕坐标不参与裁剪。

输出：

| 名称 | 形状 | 数值与操作 |
|---|---|---|
| face | `[1,224,224,3]` | RGB NHWC，uint8 resize后除255 |
| left | `[1,112,112,3]` | 同上 |
| right | `[1,112,112,3]` | resize后水平翻转，再按同一NHWC顺序打包 |
| rect | `[1,12]` | 每组依次`w/W,h/H,x/W,y/H`，组序face、left、right |

`sourceMirrored:true` 仅用于像素与ROI都已经实际镜像的来源：适配器反射ROI的x并反向读取像素，恢复未镜像输入，再执行模型要求的右眼翻转。模型眼睛标签保持不变。CSS `scaleX(-1)`只改变预览时，应仍使用`false`。FaceMesh提取最好直接使用原始未镜像图像；不要把来自不同镜像状态的像素和关键点混用。

## 数值差异与验证

浏览器实现显式的半像素双线性插值、裁剪区域边缘复制及uint8四舍五入，再转float32，不依赖Canvas resize隐含的插值或颜色处理。

**这不是OpenCV `INTER_LINEAR`的逐位复刻。** OpenCV 4.14.0的三个独立合成图像案例中，同尺寸输入完全相等；非整数缩放的最大差为2个uint8灰阶，即归一化前`2/255`。这是当前fixture的实测范围，不保证覆盖所有图片和OpenCV后端。高频降采样face张量中仅1/150528个元素差2，其余差不超过1。Python独立浮点双线性计算也复现了该差异；关闭OpenCV优化后差异仍存在。未修改上游为`INTER_LINEAR_EXACT`。

与Python/MNN比较时应分开验证：

1. 两端读取同一组最终float32输入张量，检查运行时的布局和推理数值。
2. 同一来源图像各自预处理，另报告像素舍入及推理输出差异。

不能把预处理误差容限或合成测试通过当作真人手机眼动精度证明。

运行纯Node测试：

```sh
node --test work/phone-model-research/browser/preprocess.test.cjs
```

重新生成OpenCV/上游ROI oracle：

```sh
work/phone-model-research/.venv/bin/python work/phone-model-research/browser/generate-oracle.py
```

`generate-oracle.py`用真实`cv2.resize`生成RGB参照字节，并执行固定提交的原始`MediaPipeFaceAlignment.detect()`，注入合成478点代替真实人脸检测。它不调用摄像头、MediaPipe检测器或神经网络。`preprocess-oracle.json`保留OpenCV版本、提交和测试输入定义。七个ROI案例覆盖横/竖图像、半整数取整、脸框边缘和眼框拒绝，输出坐标逐项完全匹配。

`compare-preprocessing.py` 另使用已有公开肖像与一张合成高频图，分别执行OpenCV/JS预处理以及原生MNN/WASM MNN，保留四种组合的完整258维输出和输入哈希到 `preprocessing-mnn-parity.json`。肖像使用明确记录的手工整数ROI，只作为共同数值测试输入，不能代替真实FaceMesh或眼动真值。

```sh
work/phone-model-research/.venv/bin/python work/phone-model-research/browser/compare-preprocessing.py
```

当前肖像结果：两端完全相同的OpenCV张量输入时，base模型258维最大输出差为0.000421，mobilenet_v4为0.000085；两端各自预处理时分别为0.003530和0.023869。这里的输出是网络原生数值，**不是屏幕百分比或眼动误差**。WASM由Node承载，此测试也不代表iPhone Safari性能。

`image-calibration-audit.test.cjs` 对独立个人校准模块提供额外解析测试：二维和256维归一化线性核与闭式岭回归解一致，训练折的均值/标准差不使用另一轮，重复帧数量不改变位置权重，验证身份和混合输出维度被拒绝。

## 归属与许可

ROI算法和预处理契约来自 **GC Zhu / Gancheng Zhu 的 GazeFollower**。本JavaScript适配作了语言移植、镜像来源处理、输入完整性检查和显式数值实现，并新增合成测试。对上游代码的适配部分遵循同一 **Creative Commons Attribution–NonCommercial–ShareAlike 4.0 International（CC BY-NC-SA 4.0）**许可。

完整许可见[仓库内上游许可](../image-model/upstream/LICENSE-CC-BY-NC-SA)及[上游许可](https://github.com/GanchengZhu/GazeFollower/blob/7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa/LICENSE-CC-BY-NC-SA)。保留归属、非商业及相同方式共享条件；模型权重的许可和分发清单由`image-model`目录单独记录。
