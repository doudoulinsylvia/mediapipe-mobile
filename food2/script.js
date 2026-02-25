const videoElement = document.getElementById('input_video');
const canvas = document.getElementById('experiment-canvas');
const ctx = canvas.getContext('2d');
const statusElement = document.getElementById('status');
const loadingOverlay = document.getElementById('loading-overlay');
const registrationOverlay = document.getElementById('registration-overlay');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');

// 实验参数
const TRIAL_LIMIT = 3; // 正式实验试次数
const TOTAL_IMITS_COUNT = 200; // 总图片数
const IMAGES_PER_TRIAL = 2; // 二元选择（上下排布）
const BG_COLOR = '#ffffff';
const TEXT_COLOR = '#000000';
const SELECT_COLOR = '#ff0000';

let loadedImages = {}; // 存储预加载的图片对象

// 实验状态
const State = {
    LOADING: 'LOADING',
    REGISTRATION: 'REGISTRATION',
    CALIBRATION: 'CALIBRATION',
    TRIAL_FIXATION: 'TRIAL_FIXATION',
    TRIAL_DECISION: 'TRIAL_DECISION',
    TRIAL_FEEDBACK: 'TRIAL_FEEDBACK',
    BREAK: 'BREAK',
    FINISHED: 'FINISHED'
};

// ✅ 请将下方 URL 替换为您的 Google Apps Script 部署地址
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbzjb2x1vhDStjDxu3k7qjWZhFUeOZ4xjAnDWvY-X_xXf6sxLKJZ6qiOlP7VJa4WPrfxPA/exec";
// Last Update: 2026-02-19 21:45

let currentState = State.LOADING;
let subjectInfo = {};
let trials = [];
let currentTrialIndex = 0;
let behaviorLog = [];
let gazeLog = [];
let lastGaze = { x: 0, y: 0, valid: false, landmarks: null, mesh: null, pupil_size: 0, raw_x: 0.5 };

// MediaPipe 状态
let faceMesh;
let camera;
let calibLimits = { x_min: 0, x_max: 1, x_center: 0.5 };
let calibData = [];
let calibPoints = [
    { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }, { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.8 }, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }
];
let currentCalibIndex = 0;

// 窗口与画布自适应
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function updateStatus(msg) {
    statusElement.innerHTML = msg;
    console.log(msg);
}

// ==========================================================================
// 1. 初始化 MediaPipe
// ==========================================================================
function preloadImages(imageIds) {
    return Promise.all(imageIds.map(id => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                loadedImages[id] = img;
                resolve();
            };
            img.onerror = () => {
                console.warn(`无法加载图片 ${id}.jpg，将使用空白框代替`);
                resolve(); // 忽略错误继续加载
            };
            img.src = `images/${id}.jpg`;
        });
    }));
}

async function initMediaPipe() {
    updateStatus("正在载入实验环境与图片资源，请稍候...");

    // 随机抽选本次实验用到的图片，避免加载所有200张
    const reqCount = TRIAL_LIMIT * IMAGES_PER_TRIAL;
    const allIds = Array.from({ length: TOTAL_IMITS_COUNT }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const selectedIds = allIds.slice(0, reqCount);

    const loaderWatchdog = setTimeout(() => {
        if (currentState === State.LOADING) {
            updateStatus("⚠️ 网络加载较慢，正在尝试备用线路，请保持页面开启...");
        }
    }, 20000);

    try {
        await preloadImages(selectedIds);

        // 生成 Trial 数据
        trials = [];
        for (let i = 0; i < TRIAL_LIMIT; i++) {
            trials.push({
                images: selectedIds.slice(i * 2, i * 2 + 2)
            });
        }

        faceMesh = new FaceMesh({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`;
            }
        });

        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        faceMesh.onResults(onResults);

        camera = new Camera(videoElement, {
            onFrame: async () => {
                await faceMesh.send({ image: videoElement });
            },
            width: 640,
            height: 480
        });

        await camera.start();
        clearTimeout(loaderWatchdog);

        updateStatus("✅ 环境与图片准备完毕，请录入信息");
        document.getElementById('loading-overlay').style.display = 'none';
        document.getElementById('registration-overlay').style.display = 'block';
        currentState = State.SUBJECT_INFO;
    } catch (e) {
        clearTimeout(loaderWatchdog);
        console.error("Init Error:", e);
        updateStatus("❌ 启动失败: 请检查您的浏览器是否授权摄像头权限，并使用 HTTPS 访问。");
    }
}

function onResults(results) {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const lms = results.multiFaceLandmarks[0];

        const leftInner = lms[133];
        const leftOuter = lms[33];
        const rightInner = lms[362];
        const rightOuter = lms[263];

        const leftIrisTop = lms[159];
        const leftIrisBottom = lms[145];

        // --- 核心计算 (复刻 PC 端 Python 逻辑) ---
        // 1. 垂直与水平距离 (用于有效性判断)
        const v_dist = Math.hypot(lms[159].x - lms[145].x, lms[159].y - lms[145].y);
        const h_dist = Math.hypot(lms[133].x - lms[33].x, lms[133].y - lms[33].y);
        const ratio = v_dist / (h_dist + 1e-6);
        const valid = ratio > 0.14 ? 1 : 0;

        // 2. 映射 X 计算 (lx, rx)
        const h_dist_lx = Math.hypot(lms[133].x - lms[33].x, lms[133].y - lms[33].y); // 使用水平总宽作为参考
        const lx = Math.hypot(lms[468].x - lms[33].x, lms[468].y - lms[33].y) / (h_dist_lx + 1e-6);

        const h_dist_rx_total = Math.hypot(lms[263].x - lms[362].x, lms[263].y - lms[362].y);
        const rx = Math.hypot(lms[473].x - lms[362].x, lms[473].y - lms[362].y) / (h_dist_rx_total + 1e-6);

        const raw_x = (lx + rx) / 2.0;

        // 3. 瞳孔大小计算 (复刻 PC 端 Python 逻辑)
        const l_iris_size = Math.hypot(lms[469].x - lms[471].x, lms[469].y - lms[471].y);
        const r_iris_size = Math.hypot(lms[474].x - lms[476].x, lms[474].y - lms[476].y);
        const pupil_size = ((l_iris_size + r_iris_size) / 2.0) / (h_dist + 1e-6);

        // 记录状态
        lastGaze.raw_x = raw_x;
        lastGaze.valid = !!valid;
        lastGaze.ratio = ratio; // 新增：保存比例用于调试
        lastGaze.pupil_size = pupil_size;

        // 映射到屏幕坐标
        lastGaze.x = mapX(raw_x);
        lastGaze.y = canvas.height / 2;

        // 记录 468 个点 (关键改进)
        // 为了 CSV 效率，将其存为特定格式的字符串
        lastGaze.mesh = lms.map(p => `${p.x.toFixed(4)}:${p.y.toFixed(4)}`).join('|');

        // 记录关键点
        lastGaze.landmarks = {
            leftIris: { x: lms[468].x.toFixed(4), y: lms[468].y.toFixed(4) },
            rightIris: { x: lms[473].x.toFixed(4), y: lms[473].y.toFixed(4) },
            leftInner: { x: lms[133].x.toFixed(4), y: lms[133].y.toFixed(4) },
            leftOuter: { x: lms[33].x.toFixed(4), y: lms[33].y.toFixed(4) },
            rightInner: { x: lms[362].x.toFixed(4), y: lms[362].y.toFixed(4) },
            rightOuter: { x: lms[263].x.toFixed(4), y: lms[263].y.toFixed(4) }
        };

        if (currentState === State.TRIAL_DECISION || currentState === State.TRIAL_FIXATION || currentState === State.TRIAL_FEEDBACK) {
            recordGazeFrame();
        }
    } else {
        lastGaze.valid = false;
        lastGaze.landmarks = null;
        lastGaze.mesh = null;
    }
}

function mapX(rx) {
    const { x_min, x_max, x_center } = calibLimits;
    if (rx < x_center) {
        let norm = (rx - x_min) / (x_center - x_min);
        return Math.max(0, norm) * (canvas.width / 2);
    } else {
        let norm = (rx - x_center) / (x_max - x_center);
        return (canvas.width / 2) + Math.min(1, norm) * (canvas.width / 2);
    }
}

// ==========================================================================
// 2. 实验逻辑
// ==========================================================================
function startExperiment() {
    updateStatus("指令加载中...");
    subjectInfo = {
        id: document.getElementById('subject-id').value,
        name: document.getElementById('subject-name').value,
        label: document.getElementById('subject-label').value,
        gender: document.getElementById('subject-gender').value,
        timestamp: new Date().toISOString()
    };

    if (!subjectInfo.id || !subjectInfo.name) {
        alert("请填写完整信息");
        return;
    }

    registrationOverlay.style.display = 'none';

    // (Trials 已经在初始化时随机分配好了)

    currentCalibIndex = 0;
    calibData = [];
    currentState = State.CALIBRATION;
    requestAnimationFrame(loop);
}

// 绘制函数
function drawText(text, x, y, size = 30, color = TEXT_COLOR) {
    ctx.fillStyle = color;
    ctx.font = `${size}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
}

function drawFixation() {
    ctx.font = '80px Inter';
    drawText("+", canvas.width / 2, canvas.height / 2, 100);
}

// 等比填充绘制图片 (相当于 CSS object-fit: cover)，防止图片被拉伸变形
function drawImageCover(ctx, img, x, y, w, h) {
    const imgRatio = img.width / img.height;
    const boxRatio = w / h;
    let srcX = 0, srcY = 0, srcW = img.width, srcH = img.height;

    if (imgRatio > boxRatio) {
        // 图片比框宽，裁切左右
        srcW = img.height * boxRatio;
        srcX = (img.width - srcW) / 2;
    } else {
        // 图片比框高，裁切上下
        srcH = img.width / boxRatio;
        srcY = (img.height - srcH) / 2;
    }

    ctx.drawImage(img, srcX, srcY, srcW, srcH, x, y, w, h);
}

function drawDecision(trial, selectionIndex = -1) {
    const margin = 30; // 边距
    const spacing = 30; // 图片间距
    const topMargin = 80; // 留出状态栏高度

    const availableWidth = canvas.width - margin * 2;
    const availableHeight = canvas.height - topMargin - margin;

    // 上下排布：每张图片占据可用宽度的 80%，高度各占一半（减去间距）
    const imgW = Math.min(availableWidth * 0.8, 400); // 最大宽度 400px
    const imgH = (availableHeight - spacing) / 2;
    // 取较小值保持正方形（或接近正方形）
    const size = Math.min(imgW, imgH);

    // 水平居中
    const offsetX = (canvas.width - size) / 2;
    // 垂直居中排布两张图
    const totalH = size * 2 + spacing;
    const startY = topMargin + (availableHeight - totalH) / 2;

    const coords = [
        { x: offsetX, y: startY },                    // 上方图片
        { x: offsetX, y: startY + size + spacing }    // 下方图片
    ];

    for (let i = 0; i < 2; i++) {
        const id = trial.images[i];
        const img = loadedImages[id];

        ctx.strokeStyle = (selectionIndex === i ? SELECT_COLOR : '#ccc');
        ctx.lineWidth = selectionIndex === i ? 6 : 2;

        if (img) {
            drawImageCover(ctx, img, coords[i].x, coords[i].y, size, size);
            ctx.strokeRect(coords[i].x, coords[i].y, size, size);
        } else {
            ctx.fillStyle = '#eee';
            ctx.fillRect(coords[i].x, coords[i].y, size, size);
            ctx.strokeRect(coords[i].x, coords[i].y, size, size);
            drawText(`${id}.jpg`, coords[i].x + size / 2, coords[i].y + size / 2, 20);
        }
    }
}

// 触摸处理 (Decision 阶段)
canvas.addEventListener('touchstart', (e) => {
    if (currentState !== State.TRIAL_DECISION) return;

    const touchX = e.touches[0].clientX;
    const touchY = e.touches[0].clientY;

    const margin = 30, spacing = 30, topMargin = 80;
    const availableWidth = canvas.width - margin * 2;
    const availableHeight = canvas.height - topMargin - margin;
    const imgW = Math.min(availableWidth * 0.8, 400);
    const imgH = (availableHeight - spacing) / 2;
    const size = Math.min(imgW, imgH);
    const offsetX = (canvas.width - size) / 2;
    const totalH = size * 2 + spacing;
    const startY = topMargin + (availableHeight - totalH) / 2;

    let tappedIndex = -1;

    // 上方: 0, 下方: 1
    if (touchX >= offsetX && touchX <= offsetX + size &&
        touchY >= startY && touchY <= startY + size) {
        tappedIndex = 0;
    } else if (touchX >= offsetX && touchX <= offsetX + size &&
        touchY >= startY + size + spacing && touchY <= startY + size * 2 + spacing) {
        tappedIndex = 1;
    }

    if (tappedIndex !== -1) {
        handleDecision(tappedIndex);
    }
});

// 处理按钮点击 (Calibration 阶段)
canvas.addEventListener('pointerdown', (e) => {
    if (currentState === State.CALIBRATION) {
        if (lastGaze.valid) {
            calibData.push(lastGaze.raw_x);
            currentCalibIndex++;
            updateStatus(`校准点 ${currentCalibIndex}/9 已采集`);
            if (currentCalibIndex >= calibPoints.length) {
                finishCalibration();
            }
        } else {
            updateStatus("未检测到面部，请正对手机后再点击");
            // 简单震动提示（如果设备支持）
            if (navigator.vibrate) navigator.vibrate(50);
        }
    } else if (currentState === State.BREAK) {
        currentCalibIndex = 0;
        calibData = [];
        currentState = State.CALIBRATION;
        updateStatus("休息结束，开始校准");
    }
});

function finishCalibration() {
    const res = calibData;
    calibLimits.x_center = res[0]; // 第一个是中心点
    calibLimits.x_min = Math.min(...res) - (res[0] - Math.min(...res)) * 0.4;
    calibLimits.x_max = Math.max(...res) + (Math.max(...res) - res[0]) * 0.4;

    currentState = State.TRIAL_FIXATION;
    startTrial();
}

let trialStartTime = 0;
function startTrial() {
    const trial = trials[currentTrialIndex];
    trial.startTime = performance.now();
    currentState = State.TRIAL_FIXATION;

    setTimeout(() => {
        currentState = State.TRIAL_DECISION;
        trial.decisionStartTime = performance.now();
    }, 800 + Math.random() * 200);
}

function handleDecision(selectionIndex) {
    const trial = trials[currentTrialIndex];
    trial.selectionIndex = selectionIndex;
    trial.chosenImageId = trial.images[selectionIndex];
    trial.rt = performance.now() - trial.decisionStartTime;

    currentState = State.TRIAL_FEEDBACK;

    setTimeout(() => {
        // 记录行为数据
        behaviorLog.push({
            trial: currentTrialIndex + 1,
            top_img: trial.images[0],
            bottom_img: trial.images[1],
            chosen_position: selectionIndex === 0 ? 'top' : 'bottom', // 上 or 下
            chosen_img_id: trial.chosenImageId, // 实际图片的数字编号
            rt: trial.rt.toFixed(2),
            ...subjectInfo
        });

        nextTrial();
    }, 500);
}

function nextTrial() {
    currentTrialIndex++;
    if (currentTrialIndex >= trials.length) {
        currentState = State.FINISHED;
        exportData();
    } else if (currentTrialIndex > 0 && currentTrialIndex % 50 === 0) {
        currentState = State.BREAK;
    } else {
        startTrial();
    }
}

function recordGazeFrame() {
    const frame = {
        subject_id: subjectInfo.id || '',
        subject_name: subjectInfo.name || '',
        timestamp: performance.now().toFixed(2),
        trial: currentTrialIndex + 1,
        phase: currentState,
        x: lastGaze.x.toFixed(2),
        y: lastGaze.y.toFixed(2),
        raw_x: lastGaze.raw_x.toFixed(4),
        pupil_size: lastGaze.pupil_size.toFixed(5),
        valid: lastGaze.valid ? 1 : 0
    };

    // 添加核心 6 个点
    if (lastGaze.landmarks) {
        frame.lx_iris = lastGaze.landmarks.leftIris.x;
        frame.ly_iris = lastGaze.landmarks.leftIris.y;
        frame.rx_iris = lastGaze.landmarks.rightIris.x;
        frame.ry_iris = lastGaze.landmarks.rightIris.y;
        frame.lx_inner = lastGaze.landmarks.leftInner.x;
        frame.ly_inner = lastGaze.landmarks.leftInner.y;
        frame.lx_outer = lastGaze.landmarks.leftOuter.x;
        frame.ly_outer = lastGaze.landmarks.leftOuter.y;
        frame.rx_inner = lastGaze.landmarks.rightInner.x;
        frame.ry_inner = lastGaze.landmarks.rightInner.y;
        frame.rx_outer = lastGaze.landmarks.rightOuter.x;
        frame.ry_outer = lastGaze.landmarks.rightOuter.y;
    }

    // 468 点面部网格 (格式: x1:y1|x2:y2|...|x468:y468)
    // 分析时用 split('|') 即可还原为坐标数组
    frame.face_mesh = lastGaze.mesh;

    gazeLog.push(frame);
}

function loop() {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    switch (currentState) {
        case State.CALIBRATION:
            const cp = calibPoints[currentCalibIndex];
            ctx.fillStyle = 'red';
            ctx.beginPath();
            ctx.arc(cp.x * canvas.width, cp.y * canvas.height, 20, 0, Math.PI * 2);
            ctx.fill();
            drawText(`请注视红点并点击屏幕 (${currentCalibIndex + 1}/9)`, canvas.width / 2, canvas.height - 100, 20);

            // 新增面部检测状态反馈
            if (lastGaze.valid) {
                drawText("✅ 面部已锁定", canvas.width / 2, 50, 18, "#00ff00");
            } else {
                drawText("❌ 未检测到面部", canvas.width / 2, 50, 18, "#ff0000");
            }
            break;

        case State.TRIAL_FIXATION:
            drawFixation();
            break;

        case State.TRIAL_DECISION:
            drawDecision(trials[currentTrialIndex]);
            break;

        case State.TRIAL_FEEDBACK:
            drawDecision(trials[currentTrialIndex], trials[currentTrialIndex].selectionIndex);
            break;

        case State.BREAK:
            drawText("休息一下", canvas.width / 2, canvas.height / 2 - 50, 40);
            drawText("准备好后点击屏幕继续校准", canvas.width / 2, canvas.height / 2 + 50, 20);
            break;

        case State.FINISHED:
            drawText("实验完成！正在准备数据...", canvas.width / 2, canvas.height / 2, 30);
            break;
    }

    if (currentState !== State.FINISHED) {
        // 在状态栏实时更新检测信息
        if (lastGaze.valid) {
            updateStatus(`🟢 检测到面部 (比例: ${lastGaze.ratio.toFixed(2)})`);
        } else if (lastGaze.ratio !== undefined) {
            updateStatus(`🔴 未锁定: 比例 ${lastGaze.ratio.toFixed(2)} < 0.14`);
        } else {
            updateStatus("⚪️ 正在寻找面部...");
        }
        requestAnimationFrame(loop);
    }
}

async function exportData() {
    console.log("🏁 Experiment finished. Starting export...");
    try {
        updateStatus("实验完成，正在准备行为数据...");
        const behaviorCSV = jsonToCSV(behaviorLog);

        updateStatus("行为数据就绪，正在转换眼动网格 (468点，请稍候)...");
        await new Promise(r => setTimeout(r, 200)); // 给 UI 渲染时间

        const gazeCSV = jsonToCSV(gazeLog);
        updateStatus("所有数据准备就绪，正在启动下载...");

        // 1. 本地下载备份
        downloadCSV(behaviorCSV, `behavior_${subjectInfo.id}.csv`);
        await new Promise(r => setTimeout(r, 1000));
        downloadCSV(gazeCSV, `gaze_${subjectInfo.id}.csv`);

        // 2. 同步到 Google Sheets（依次发送，等待足够时间）
        updateStatus("正在上传行为数据到 Google Sheets...");
        await syncWithBackend('behavior_food2', behaviorLog);

        // 等待 5 秒确保行为数据表单已被 Google 接收处理
        updateStatus("行为数据已提交，等待确认...");
        await new Promise(r => setTimeout(r, 5000));

        updateStatus("正在上传眼动数据到 Google Sheets (数据量较大，请耐心等待)...");
        await syncWithBackend('gaze_food2', gazeLog);

        updateStatus("✅ 所有数据同步成功！任务完成。感谢参与！");
    } catch (e) {
        console.error("Export Error:", e);
        updateStatus("⚠️ 数据已下载到手机。云端同步遇到问题: " + e.message + "\n请将手机下载的 CSV 文件发送给主试。");
    }
}

function syncWithBackend(type, payload) {
    if (BACKEND_URL === "YOUR_GOOGLE_SCRIPT_URL_HERE") {
        console.warn("❗ Backend URL not configured, skipping sync.");
        return Promise.resolve();
    }
    console.log(`📡 Syncing ${type} data (${payload.length} rows) to Google Sheets...`);

    return new Promise((resolve, reject) => {
        try {
            // 使用隐藏 iframe + form 提交，彻底绕过 CORS 和重定向问题
            const iframeName = 'gs_target_' + Date.now();
            const iframe = document.createElement('iframe');
            iframe.name = iframeName;
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            const form = document.createElement('form');
            form.method = 'POST';
            form.action = BACKEND_URL;
            form.target = iframeName;

            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'data';
            input.value = JSON.stringify({
                type: type,
                subject_id: subjectInfo.id,
                payload: payload
            });

            form.appendChild(input);
            document.body.appendChild(form);
            form.submit();

            console.log(`✅ ${type} data submitted to Google Sheets`);

            // 等待几秒后清理 DOM
            setTimeout(() => {
                document.body.removeChild(form);
                document.body.removeChild(iframe);
                resolve();
            }, 3000);
        } catch (e) {
            console.error(`❌ Submit error for ${type}:`, e);
            reject(new Error(`无法提交到 Google Sheets: ${e.message}`));
        }
    });
}

function jsonToCSV(json) {
    if (json.length === 0) return "";
    const headers = Object.keys(json[0]);
    const rows = json.map(row => headers.map(h => row[h]).join(','));
    return [headers.join(','), ...rows].join('\n');
}

function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 绑定开始按钮
startBtn.addEventListener('click', startExperiment);

// 检查微信并启动
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
if (isWechat) wechatPrompt.style.display = 'block';

// 启动程序
initMediaPipe();
