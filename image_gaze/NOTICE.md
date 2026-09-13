# 手机图像眼动预实验 0.1.0 — 来源与许可

本入口由当前实验项目独立实现个人校准、独立验证、采样记录和手机页面。图像模型与 ROI 预处理参考 Gancheng Zhu / GC Zhu 的 [GazeFollower](https://github.com/GanchengZhu/GazeFollower)，固定提交为 `7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa`。

- 原始模型文件 `mobilenet_v4.mnn`、`base.mnn` 未修改，来自该提交。
- 模型和由 GazeFollower 改编的 ROI/图像预处理代码遵循 **CC BY-NC-SA 4.0**；本入口新增的个人校准、采样、页面、样式及模型桥接源代码也以该许可提供。需保留署名，用于非商业用途，改编后以相同许可分享。完整许可：[CC BY-NC-SA 4.0](./mnn/LICENSE-GazeFollower-CC-BY-NC-SA-4.0.txt)。
- 本实现把 Python ROI/裁剪流程移植到浏览器，加入输入校验、显式双线性缩放和固定时间窗口。浏览器缩放与 OpenCV 默认线性缩放存在少量舍入差异，未声称逐位相同。
- 使用 Alibaba **MNN 3.5.0** 官方源代码编译的单线程 SIMD WebAssembly，Emscripten 4.0.14。MNN 为 [Apache-2.0](./mnn/LICENSE-MNN-Apache-2.0.txt)，另保留 [half MIT](./mnn/LICENSE-half-MIT.txt) 和 [FlatBuffers Apache-2.0](./mnn/LICENSE-flatbuffers-Apache-2.0.txt) 许可。模型桥接源代码见仓库的 `image_gaze/runtime-source/`。
- MediaPipe FaceMesh 和原实验的共享跟踪模块从现有实验目录加载，原许可保持不变。

两个模型的 SHA-256：

- MobileNet V4：`db04d6568a15b85bd9d007e7f8ca7021422e390c24035a54d5108ae949f536d8`
- base：`2f96b95275fe6d7b79e98df3237ebb96e15ef5522c96968f08167da7e1954a96`

这是使用公开 GazeFollower 权重的浏览器研究实现，不是作者手机 SDK 的移植或论文准确率的复现。冻结的网络输出 2 个原生预测值和 256 个特征；本程序通过个人校准生成屏幕坐标。验证数据不用于训练或选择模型，预测不截断到屏幕边界，失败门槛不会自动放宽。

摄像头图像只在本机内存中处理，不保存照片或视频、不自动上传采样。用户主动下载的诊断 JSON 包含数值特征、设备参数、个人映射和误差，宜自行妥善保存。合成数值自测通过不代表真人手机眼动精度。
