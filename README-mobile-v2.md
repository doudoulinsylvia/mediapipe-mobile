# 手机眼动实验 v2.2.0

本版实现稳定采样与稳健拟合，并提供 MediaPipe Face Landmarker 对照入口。手机测试入口：[改进采样版](https://doudoulinsylvia.github.io/mediapipe-mobile/food2/revised.html?pilot=1&v=2.2.0)、[Face Landmarker 对照版](https://doudoulinsylvia.github.io/mediapipe-mobile/food2/revised-tasks.html?pilot=1&v=2.2.0)。发布后请核对页面版本为 v2.2.0。 原 `index.html`、旧脚本、图片和历史实验数据未改动。

## 入口与运行

解压完整包，在 `mediapipe-mobile-v2` 目录启动静态服务器：

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

电脑访问以下路径；手机必须部署到 HTTPS 后使用 Safari / Chrome，不能使用电脑的 localhost 地址或普通局域网 HTTP。

| 用途 | 上下图片布局 | 左右图片布局 |
|---|---|---|
| 原检测器＋改进采样 | `/food2/revised.html?pilot=1&v=2.2.0` | `/food3_formal/revised.html?pilot=1&v=2.2.0` |
| 新版检测器对照 | `/food2/revised-tasks.html?pilot=1&v=2.2.0` | `/food3_formal/revised-tasks.html?pilot=1&v=2.2.0` |

`pilot=1` 保留完整两轮校准和九点独立验证，但任务缩短为6张评分、6次选择。新版检测器只允许预实验模式，没有自动退回旧检测器的机制。查询参数中的版本号不证明网站已经更新，需同时核对页面显示的版本。

原检测器入口去掉 `pilot=1` 仍为200张评分、150次选择，保留正式任务流程；v2.2.0 的精度尚未实机验证，正式采集前需完成手机预实验。

## 改进内容

1. **开始前准备。** 点击“准备好了，开始练习”，注视中央圆点；3秒倒计时后还要获得连续稳定结果，随后自动进入首个校准点。练习数据不参与拟合，首点重新等待和积累稳定窗。准备阶段18秒截止，可下载诊断后重试。
2. **每点稳定后采样。** 两轮九点各保留唯一呈现身份。目标画出后先等待600ms，再等待至少600ms且至少12帧的连续有效特征。达到标准后进度环开始填充，并采集至少1400ms的连续稳定结果。
3. **异常中断并留痕。** 无效结果、过长间断、单帧跳变、特征分散或漂移超限会中断采集段，重新等稳。整个1400ms采集段也必须达标。每点自首次呈现起最多12秒，重试不会延长截止。中止段不会进入拟合，其样本和原因仍保留。
4. **每段中位数拟合。** 每个完成段四维眼部特征分别取中位数。每个训练轮实际有9个代表观测，最终有18个；没有把中位数复制成多条样本。仍按整轮交叉检验选择原有两种固定候选，held-out轮分数以及逐点残差使用原始有效帧。代表特征退化会明确失败，不静默退回其他拟合方式。
5. **新版检测器对照。** 固定 `@mediapipe/tasks-vision@0.10.32` 与 `face_landmarker/float16/1`，本地资源、GPU、VIDEO、单脸；启用眼部表情系数与面部变换矩阵。它们目前只保存在诊断中，未改变质量判定或作为映射输入，以便先比较检测器变化。
6. **保持独立验证。** 原九个验证位置、600ms等待、1400ms采集、质量与恢复期规则、误差门槛不变。验证不使用新增稳定性筛选，不参与中位数拟合或模型选择，原始坐标保持未裁剪。X/Y平均误差、P95、覆盖率和逐点结果均须检查。
7. **离开页面立即暂停。** preparation/calibration/validation等活动阶段发生pagehide即中止，随后visibilitychange的事件顺序不会留下活动计时器。

## 稳定规则的含义

默认工程候选：每个眼部特征以眼角宽度归一化，P90−P10≤0.06，前后半时间窗的中位数差≤0.025，连续帧变化≤0.08；相邻有效帧间隔≤150ms。600ms窗口保留边界锚帧，以适应33/34ms等不规则帧间隔。整个采集段完成于第一次满足1400ms完整窗口的真实回调。

这些数值描述输入特征稳定性，**不是屏幕定位误差或注视正确性的标准**。连续稳定地看错位置仍可能通过采样规则，因此独立验证不可省略。中位数不能修复整段错误或稳定偏差；升级检测器也不保证更准确。

## 数据与复现

继续使用schemaVersion=2，需结合 `appVersion/coreVersion=2.2.0` 与 `calibrationProtocol=stable_two_round_median_v2` 识别新协议。完整备份包含：

- 所有相机结果，包括练习、等待、无效、恢复、过期阶段与中断采集。
- 每点 `attempts`：所有等待结束后的尝试；`fitEligible=true` 仅表示最终完成的稳定采集段用于拟合。不能把全部 `valid=true` 的等待样本混入拟合。
- `samplingWindows`：每次采集开始、结束、状态、原因、sampleIds、全段稳定性；暂停中止的目标也保存状态。
- `samplingSummary`：采集时长、拟合纳入数/总尝试数、中断重采次数。比较版本时同时报告等待和失败情况，不能只比较成功段。
- 模型 `aggregation=presentation_median`、每折代表观测、原始帧数、候选分数、完整系数、逐点和跨轮诊断。
- 每行 `tracking_engine` / `tracking_diagnostics`：新版检测器的原始表情系数和面部矩阵；后者不是眼球方向、屏幕落点或经过标定的测距结果。
- `preparation_stability` / `calibration_stability` / `calibration_window_id`；会话记录引擎、固定版本、资源地址、配置、实际视频分辨率和视口历史。

新增眼部和矩阵诊断会增加JSON体积。图像只在设备本地处理，不保存照片/视频，不自动上传；刷新或关闭会丢失未下载数据。优先下载完整JSON备份。

## 验证与限制

```sh
node --test tests/*.test.cjs
python3 scripts/build-v2-bundle.py --out /path/to/output
```

当前132项自动化检查通过，覆盖原流程、稳定窗、跳变/漂移、重采截止、准备超时、页面隐藏、代表中位数、验证隔离、Tasks入口和取消/迟到回调。测试使用合成输入检查程序，不代表设备眼动精度。

本地桌面浏览器用Google官方静态人像实际加载GPU Tasks模型成功，输出478关键点、52系数和16个矩阵元素。已检查390×844的两个启动界面。尚未完成真实iPhone Safari全流程、耗时、内存或X/Y精度验证；此阶段不宣称误差降低。

包内 `shared/tasks-vision/0.10.32/manifest.json` 保存下载来源、npm原始SHA-512与各资源SHA-256。下载时验证了npm包完整性；采集时不会对全部文件重新计算哈希。旧FaceMesh资源仍在原路径。

完整包包含模型和400张图片；覆盖包包含新版文件和Tasks资源，需要仓库已有旧FaceMesh资源与图片。覆盖已有版本前请备份代码。生成的新增文件补丁仅用于原始基准提交51868f7；已经安装v2.1.0的仓库不能直接套用新增文件补丁。

## 官方依据

- [MediaPipe Iris的能力边界](https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/)：虹膜跟踪不直接推断屏幕注视点。
- [Face Landmarker Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)：VIDEO、单脸、可选表情与面部矩阵；推理为同步执行，iPhone性能须实测。
- [FaceMesh V2模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)、[Blendshape模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf)：Apache-2.0，模型用途与局限。
