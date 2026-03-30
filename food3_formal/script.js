const videoElement = document.getElementById('input_video');
const canvas = document.getElementById('experiment-canvas');
const ctx = canvas.getContext('2d');
const statusElement = document.getElementById('status');
const loadingOverlay = document.getElementById('loading-overlay');
const registrationOverlay = document.getElementById('registration-overlay');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');

// 实验参数
const TRIAL_LIMIT = 150; // 正式实验试次数
const TOTAL_IMITS_COUNT = 200; // 正式实验图片总数
const IMAGES_PER_TRIAL = 2; // 二元选择（左右排布）
const BG_COLOR = '#ffffff';
const TEXT_COLOR = '#000000';
const SELECT_COLOR = '#ff0000';

let loadedImages = {}; // 存储预加载的图片对象

const State = {
    LOADING: 'LOADING',
    SUBJECT_INFO: 'SUBJECT_INFO',
    REGISTRATION: 'REGISTRATION',
    CALIBRATION: 'CALIBRATION',
    CALIBRATION_VERIFY: 'CALIBRATION_VERIFY',
    RATING_FIXATION: 'RATING_FIXATION',
    RATING_DECISION: 'RATING_DECISION',
    RATING_FEEDBACK: 'RATING_FEEDBACK',
    PHASE1_END: 'PHASE1_END',
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

let ratingImages = [];
let currentRatingIndex = 0;
let ratingLog = [];

let lastTouchFeedback = null; // 用于绘制点击反馈圆圈

let trials = [];
let currentTrialIndex = 0;
let behaviorLog = [];
let gazeLog = [];
let lastGaze = { x: 0, y: 0, valid: false, landmarks: null, mesh: null, pupil_size: 0, raw_x: 0.5 };
let trialStartTime = 0;

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
let calibPointShownTime = 0;
let verifyPoint = null;

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
            img.src = `../food3/images/${id}.jpg`;
        });
    }));
}

async function initMediaPipe() {
    updateStatus("正在载入实验环境与图片资源，请稍候...");

    // 根据需求，评分阶段选取 200 张图片
    const reqCount = 200; // 正式实验评分图片数
    const allIds = Array.from({ length: TOTAL_IMITS_COUNT }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const selectedIds = allIds.slice(0, reqCount);

    const loaderWatchdog = setTimeout(() => {
        if (currentState === State.LOADING) {
            updateStatus("⚠️ 网络加载较慢，正在尝试备用线路，请保持页面开启...");
        }
    }, 20000);

    try {
        await preloadImages(selectedIds);
        ratingImages = selectedIds;
        trials = []; // 将在评分阶段结束后自动生成

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
        let errorMsg = "❌ 启动失败: ";
        if (!window.isSecureContext) {
            errorMsg += "必须使用 HTTPS 安全链接访问摄像头。";
        } else if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            errorMsg += "摄像头权限被拒绝，请在浏览器设置中开启。";
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
            errorMsg += "未查找到摄像头硬件。";
        } else {
            errorMsg += `错误码: ${e.name || 'Unknown'}. 请确保没有其他应用占用摄像头。`;
        }
        updateStatus(errorMsg);
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
        
        lastGaze.pupil_L = (l_iris_size / (h_dist + 1e-6)).toFixed(5);
        lastGaze.pupil_R = (r_iris_size / (h_dist + 1e-6)).toFixed(5);
        lastGaze.pupil_avg = ((Number(lastGaze.pupil_L) + Number(lastGaze.pupil_R)) / 2.0).toFixed(5);

        // 4. 垂直 Y 映射计算 (粗略估计眼球上下运动)
        // 使用眼眶上下边界中点作为参考参考
        const leftEyeH = Math.hypot(lms[159].x - lms[145].x, lms[159].y - lms[145].y);
        const rightEyeH = Math.hypot(lms[386].x - lms[374].x, lms[386].y - lms[374].y);

        // 眼睛中心 Y 到 瞳孔 Y 的比例
        const l_y_ratio = (lms[468].y - lms[159].y) / (leftEyeH + 1e-6);
        const r_y_ratio = (lms[473].y - lms[386].y) / (rightEyeH + 1e-6);
        const raw_y = (l_y_ratio + r_y_ratio) / 2.0;

        // 记录状态
        lastGaze.raw_x = raw_x;
        lastGaze.raw_y = raw_y;
        lastGaze.valid = !!valid;
        lastGaze.ratio = ratio; // 新增：保存比例用于调试

        // 映射到屏幕坐标（X 和 Y 轴均经过9点个人校准）
        lastGaze.x = mapX(raw_x);
        lastGaze.y = mapY(raw_y);

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

        if (currentState === State.TRIAL_DECISION || currentState === State.TRIAL_FIXATION || currentState === State.TRIAL_FEEDBACK ||
            currentState === State.RATING_DECISION || currentState === State.RATING_FIXATION || currentState === State.RATING_FEEDBACK ||
            currentState === State.PHASE1_END) {
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
        let norm = (rx - x_min) / (x_center - x_min + 1e-6);
        return Math.max(0, norm) * (canvas.width / 2);
    } else {
        let norm = (rx - x_center) / (x_max - x_center + 1e-6);
        return (canvas.width / 2) + Math.min(1, norm) * (canvas.width / 2);
    }
}

function mapY(ry) {
    const { y_min, y_max, y_center } = calibLimits;
    if (!y_center) {
        // 未校准时使用保守默认值，防止崩溃
        return Math.min(Math.max((ry - 0.2) / 0.6, 0), 1) * canvas.height;
    }
    if (ry < y_center) {
        let norm = (ry - y_min) / (y_center - y_min + 1e-6);
        return Math.max(0, norm) * (canvas.height / 2);
    } else {
        let norm = (ry - y_center) / (y_max - y_center + 1e-6);
        return (canvas.height / 2) + Math.min(1, norm) * (canvas.height / 2);
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
        timestamp: new Date().toISOString(),
        screen_width: window.innerWidth,
        screen_height: window.innerHeight
    };

    if (!subjectInfo.id || !subjectInfo.name) {
        alert("请填写完整信息");
        return;
    }

    registrationOverlay.style.display = 'none';

    // (Trials 已经在初始化时随机分配好了)

    currentCalibIndex = 0;
    calibData = [];
    calibPointShownTime = Date.now();
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
    const margin = 20;       // 左右边距
    const spacing = 50;      // 图片间距（足够大以避免 ROI 误分）
    const topMargin = 80;    // 留出状态栏高度

    const availableWidth  = canvas.width  - margin * 2;
    const availableHeight = canvas.height - topMargin - margin;

    // 左右排布：每张图片各占一半宽度（2:1 宽短长方形）
    const imgW = (availableWidth - spacing) / 2;
    const imgH = Math.min(availableHeight * 0.85, imgW * 1.5); // 2:3 竖向瘠长

    // 垂直居中，水平从 margin 开始
    const offsetY = topMargin + (availableHeight - imgH) / 2;
    const startX  = margin;

    const coords = [
        { x: startX,               y: offsetY, w: imgW, h: imgH }, // 左图
        { x: startX + imgW + spacing, y: offsetY, w: imgW, h: imgH }  // 右图
    ];

    for (let i = 0; i < 2; i++) {
        const id  = trial.images[i];
        const img = loadedImages[id];
        const c   = coords[i];

        ctx.strokeStyle = (selectionIndex === i ? SELECT_COLOR : '#ccc');
        ctx.lineWidth   = selectionIndex === i ? 6 : 2;

        if (img) {
            drawImageCover(ctx, img, c.x, c.y, c.w, c.h);
            ctx.strokeRect(c.x, c.y, c.w, c.h);
        } else {
            ctx.fillStyle = '#eee';
            ctx.fillRect(c.x, c.y, c.w, c.h);
            ctx.strokeRect(c.x, c.y, c.w, c.h);
            drawText(`${id}.jpg`, c.x + c.w / 2, c.y + c.h / 2, 20);
        }
    }
}

function getRatingBtnCoords() {
    const topMargin = 80;
    const size = Math.min(canvas.width * 0.8, (canvas.height - 300) * 0.8);
    const startY = topMargin + size + 70;

    const maxCols = 5;
    const spacing = 12;
    // 自动计算按钮宽度，确保不超出屏幕
    const btnW = (canvas.width - spacing * (maxCols + 1)) / maxCols;
    const btnH = 65; // 稍微加高一点

    const rects = [];
    for (let i = 1; i <= 10; i++) {
        let r = Math.floor((i - 1) / maxCols);
        let c = (i - 1) % maxCols;
        rects.push({
            x: spacing + c * (btnW + spacing),
            y: startY + r * (btnH + spacing),
            w: btnW,
            h: btnH,
            val: i
        });
    }
    return rects;
}

function drawRating(id, selectedRating = -1) {
    const img = loadedImages[id];
    const topMargin = 80;

    const size = Math.min(canvas.width * 0.8, (canvas.height - 300) * 0.8);
    const offsetX = (canvas.width - size) / 2;
    const offsetY = topMargin;

    if (img) {
        drawImageCover(ctx, img, offsetX, offsetY, size, size);
        ctx.strokeRect(offsetX, offsetY, size, size);
    } else {
        ctx.fillStyle = '#eee';
        ctx.fillRect(offsetX, offsetY, size, size);
        drawText(`${id}.jpg`, offsetX + size / 2, offsetY + size / 2, 20);
    }

    drawText("请对该食物从 1 (不喜欢) 到 10 (极其喜欢) 进行打分", canvas.width / 2, offsetY + size + 20, 16);

    const rects = getRatingBtnCoords();
    for (let rect of rects) {
        ctx.fillStyle = selectedRating === rect.val ? SELECT_COLOR : '#eee';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

        ctx.fillStyle = selectedRating === rect.val ? '#fff' : TEXT_COLOR;
        ctx.font = `20px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rect.val.toString(), rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
}

// 统一的高鲁棒性触摸/点击处理逻辑
function handleScreenTap(clientX, clientY) {
    // 关键修正：将屏幕物理坐标转换为 Canvas 内部坐标
    const rect = canvas.getBoundingClientRect();
    const touchX = (clientX - rect.left) * (canvas.width / rect.width);
    const touchY = (clientY - rect.top) * (canvas.height / rect.height);

    // 设置点击反馈点，显示一瞬间
    lastTouchFeedback = { x: touchX, y: touchY, time: Date.now() };

    if (currentState === State.RATING_DECISION) {
        const btnRects = getRatingBtnCoords();
        let selected = -1;
        for (let btn of btnRects) {
            // 严格像素判断，不再膨胀热区导致上下重叠，按钮本身已经足够大
            if (touchX >= btn.x && touchX <= btn.x + btn.w &&
                touchY >= btn.y && touchY <= btn.y + btn.h) {
                selected = btn.val;
                break;
            }
        }
        if (selected !== -1) handleRating(selected);
        return;
    }

    if (currentState === State.TRIAL_DECISION) {
        const margin = 20, spacing = 50, topMargin = 80;
        const availableWidth  = canvas.width  - margin * 2;
        const availableHeight = canvas.height - topMargin - margin;
        const imgW = (availableWidth - spacing) / 2;
        const imgH = Math.min(availableHeight * 0.85, imgW * 1.5);
        const offsetY = topMargin + (availableHeight - imgH) / 2;
        const startX  = margin;

        if (touchX >= startX && touchX <= startX + imgW &&
            touchY >= offsetY && touchY <= offsetY + imgH) {
            handleDecision(0); // 左图
        } else if (touchX >= startX + imgW + spacing && touchX <= startX + imgW * 2 + spacing &&
            touchY >= offsetY && touchY <= offsetY + imgH) {
            handleDecision(1); // 右图
        }
        return;
    }

    if (currentState === State.PHASE1_END) {
        generateCombinations();
        return;
    }

    if (currentState === State.CALIBRATION) {
        if (Date.now() - calibPointShownTime < 800) {
            updateStatus("⏳ 请先注视红点再点击");
            if (navigator.vibrate) navigator.vibrate(50);
            return;
        }
        if (lastGaze.valid) {
            calibData.push({ x: lastGaze.raw_x, y: lastGaze.raw_y });
            currentCalibIndex++;
            calibPointShownTime = Date.now();
            updateStatus(`校准点 ${currentCalibIndex}/9 已采集`);
            if (currentCalibIndex >= calibPoints.length) {
                finishCalibration();
            }
        } else {
            updateStatus("未检测到面部，请正对手机后再点击");
            if (navigator.vibrate) navigator.vibrate(50);
        }
        return;
    }

    if (currentState === State.CALIBRATION_VERIFY) {
        if (!lastGaze.valid) {
            updateStatus("未检测到面部，请正对手机后再点击");
            if (navigator.vibrate) navigator.vibrate(50);
            return;
        }
        const vx = verifyPoint.x * canvas.width;
        const distX = Math.abs(lastGaze.x - vx);
        const threshold = canvas.width * 0.25;

        if (distX < threshold) {
            updateStatus("✅ 校准验证通过！");
            setTimeout(() => afterCalibrationVerified(), 800);
        } else {
            updateStatus("❌ 校准偏差过大，请重新校准");
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            setTimeout(() => {
                currentCalibIndex = 0;
                calibData = [];
                calibPointShownTime = Date.now();
                currentState = State.CALIBRATION;
            }, 1500);
        }
        return;
    }

    if (currentState === State.BREAK) {
        currentCalibIndex = 0;
        calibData = [];
        calibPointShownTime = Date.now();
        currentState = State.CALIBRATION;
        updateStatus("休息结束，开始校准");
        return;
    }
}

// 统一监听 pointerdown
canvas.addEventListener('pointerdown', (e) => {
    handleScreenTap(e.clientX, e.clientY);
});

function finishCalibration() {
    const resX = calibData.map(d => d.x);
    const resY = calibData.map(d => d.y);

    // X 轴校准
    calibLimits.x_center = resX[0];
    calibLimits.x_min = Math.min(...resX) - (resX[0] - Math.min(...resX)) * 0.4;
    calibLimits.x_max = Math.max(...resX) + (Math.max(...resX) - resX[0]) * 0.4;

    // Y 轴校准
    calibLimits.y_center = resY[0];
    calibLimits.y_min = Math.min(...resY) - (resY[0] - Math.min(...resY)) * 0.4;
    calibLimits.y_max = Math.max(...resY) + (Math.max(...resY) - resY[0]) * 0.4;

    // 进入校准验证环节
    verifyPoint = { x: 0.5, y: 0.5 };
    currentState = State.CALIBRATION_VERIFY;
    updateStatus("校准完成，请注视绿点验证");
}

function afterCalibrationVerified() {
    if (currentRatingIndex >= ratingImages.length) {
        startTrial();
    } else {
        currentState = State.RATING_FIXATION;
        currentRatingIndex = 0;
        startRatingTrial();
    }
}

function startRatingTrial() {
    trialStartTime = performance.now();
    currentState = State.RATING_FIXATION;
    // 类似 psychoPy 逻辑，先出注视点
    setTimeout(() => {
        currentState = State.RATING_DECISION;
        trialStartTime = performance.now(); // 记录正式做决定的时间
    }, 800 + Math.random() * 200);
}

function handleRating(rating) {
    const id = ratingImages[currentRatingIndex];
    const rt = performance.now() - trialStartTime;

    ratingLog.push({
        subject_id: subjectInfo.id,
        image_id: id,
        rating: rating,
        rt: rt.toFixed(2)
    });

    currentState = State.RATING_FEEDBACK;
    // 重绘时会显示被选中的按钮颜色，停顿 0.5s 后进入下一张
    setTimeout(() => {
        nextRatingTrial();
    }, 500);
}

function nextRatingTrial() {
    currentRatingIndex++;
    if (currentRatingIndex >= ratingImages.length) {
        // 第一阶段结束，进入过渡提示状态
        currentState = State.PHASE1_END;
    } else {
        startRatingTrial();
    }
}

function generateCombinations() {
    // 按评分分组归类图片
    const ratingGroups = {};
    for (let item of ratingLog) {
        if (!ratingGroups[item.rating]) ratingGroups[item.rating] = [];
        ratingGroups[item.rating].push(item.image_id);
    }

    // 找出所有填过的不同评分分数
    const uniqueRatings = Object.keys(ratingGroups).map(Number);

    // 如果所有的图都被打了完全一样的分，无法产生差异组合
    if (uniqueRatings.length < 2) {
        alert("由于您的评分全部相同，无法进入对比阶段，数据将直接上传。");
        currentState = State.FINISHED;
        exportData();
        return;
    }

    // 生成不重复的所有两两排列组合，如打分了 3,5,8 -> (3,5) (3,8) (5,3) (5,8) (8,3) (8,5)
    const perms = [];
    for (let i = 0; i < uniqueRatings.length; i++) {
        for (let j = 0; j < uniqueRatings.length; j++) {
            if (i !== j) {
                perms.push([uniqueRatings[i], uniqueRatings[j]]);
            }
        }
    }

    // 随机打乱配对顺序
    perms.sort(() => Math.random() - 0.5);

    trials = [];
    // 按照需要的 TRIAL_LIMIT 数量生成试次
    for (let k = 0; k < TRIAL_LIMIT; k++) {
        // 从候选的评分组合池中随机抽取一对
        const p = perms[Math.floor(Math.random() * perms.length)];
        const left_rating = p[0];
        const right_rating = p[1];

        // 从对应分数池中随机抽取一张图
        const left_images  = ratingGroups[left_rating];
        const right_images = ratingGroups[right_rating];
        const left_img  = left_images[Math.floor(Math.random() * left_images.length)];
        const right_img = right_images[Math.floor(Math.random() * right_images.length)];

        trials.push({
            images: [left_img, right_img],
            left_rating:  left_rating,
            right_rating: right_rating
        });
    }

    currentTrialIndex = 0;
    startTrial();
}

function startTrial() {
    const trial = trials[currentTrialIndex];
    trial.startTime = performance.now();
    currentState = State.TRIAL_FIXATION;

    setTimeout(() => {
        currentState = State.TRIAL_DECISION;
        trial.decisionStartTime = performance.now();
    }, 800 + Math.random() * 200);
}

let lastFeedbackTrialIndex = 0; // 用于渲染反馈时安全引用的试次索引

function handleDecision(selectionIndex) {
    const trial = trials[currentTrialIndex];
    trial.selectionIndex = selectionIndex;
    trial.chosenImageId = trial.images[selectionIndex];
    trial.rt = performance.now() - trial.decisionStartTime;

    lastFeedbackTrialIndex = currentTrialIndex; // 保存当前索引，防止渲染越界
    currentState = State.TRIAL_FEEDBACK;

    setTimeout(() => {
        // 记录行为数据
        behaviorLog.push({
            trial: currentTrialIndex + 1,
            left_img:     trial.images[0],
            left_rating:  trial.left_rating,
            right_img:    trial.images[1],
            right_rating: trial.right_rating,
            chosen_position: selectionIndex === 0 ? 'left' : 'right',
            chosen_img_id: trial.chosenImageId,
            rt: trial.rt.toFixed(2),
            gaze_total_frames: gazeLog.length,
            screen_width: canvas.width,
            screen_height: canvas.height,
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
    const isRatingPhase = currentState.startsWith('RATING');
    const displayTrialNum = isRatingPhase
        ? (currentRatingIndex + 1)
        : (currentState === State.PHASE1_END ? 'transition' : (currentTrialIndex + 1));

    // 计算 ROI (二元选择阶段: 1=左图, 2=右图; 评分阶段: 1=在图片内, 0=图片外)
    let roi = 0;
    if (currentState === State.TRIAL_DECISION || currentState === State.TRIAL_FEEDBACK) {
        const margin = 20, spacing = 50, topMargin = 80;
        const availableWidth  = canvas.width  - margin * 2;
        const availableHeight = canvas.height - topMargin - margin;
        const imgW = (availableWidth - spacing) / 2;
        const imgH = Math.min(availableHeight * 0.85, imgW * 1.5);
        const offsetY = topMargin + (availableHeight - imgH) / 2;
        const startX  = margin;

        const gx = lastGaze.x;
        const gy = lastGaze.y;

        // 左右排布：只检查 X 轴，放宽 Y 轴边界（移动端 Y 精度低）
        if (gx >= startX && gx <= startX + imgW) {
            roi = 1; // 左图
        } else if (gx >= startX + imgW + spacing && gx <= startX + imgW * 2 + spacing) {
            roi = 2; // 右图
        }
    } else if (currentState === State.RATING_DECISION || currentState === State.RATING_FEEDBACK ||
               currentState === State.RATING_FIXATION) {
        // 评分阶段：判断注视是否落在单张图片范围内（与 drawRating 坐标完全一致）
        const topMargin = 80;
        const size = Math.min(canvas.width * 0.8, (canvas.height - 300) * 0.8);
        const offsetX = (canvas.width - size) / 2;
        const offsetY = topMargin;

        const gx = lastGaze.x;
        const gy = lastGaze.y;

        if (gx >= offsetX && gx <= offsetX + size &&
            gy >= offsetY && gy <= offsetY + size) {
            roi = 1; // 注视落在图片内
        }
        // roi = 0 表示落在图片外（按钮区、边距等）
    }

    const frame = {
        subject_id: subjectInfo.id || '',
        subject_name: subjectInfo.name || '',
        timestamp: performance.now().toFixed(2),
        trial: displayTrialNum,
        phase: currentState,
        screen_x: lastGaze.x.toFixed(2),
        screen_y: lastGaze.y.toFixed(2),
        gazeX: (lastGaze.x / (canvas.width || 1)).toFixed(4), // 归一化 X
        gazeY: (lastGaze.y / (canvas.height || 1)).toFixed(4), // 归一化 Y
        roi: roi,
        valid: lastGaze.valid ? 1 : 0,
        sw: canvas.width,
        sh: canvas.height,
        pupil_L: lastGaze.pupil_L,
        pupil_R: lastGaze.pupil_R,
        pupil_avg: lastGaze.pupil_avg
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

    // 468 点面部网格 — 仅保存到本地 CSV，不上传云端（数据量太大）
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

        case State.CALIBRATION_VERIFY:
            const vp = verifyPoint;
            ctx.fillStyle = '#00cc00';
            ctx.beginPath();
            ctx.arc(vp.x * canvas.width, vp.y * canvas.height, 20, 0, Math.PI * 2);
            ctx.fill();
            drawText("请注视绿点并点击屏幕验证", canvas.width / 2, canvas.height - 100, 20);
            if (lastGaze.valid) {
                drawText("✅ 面部已锁定", canvas.width / 2, 50, 18, "#00ff00");
            } else {
                drawText("❌ 未检测到面部", canvas.width / 2, 50, 18, "#ff0000");
            }
            break;

        case State.RATING_FIXATION:
        case State.TRIAL_FIXATION:
            drawFixation();
            break;

        case State.RATING_DECISION:
            drawRating(ratingImages[currentRatingIndex], -1);
            break;

        case State.RATING_FEEDBACK:
            // 反馈阶段通过从 ratingLog 取出当前分数渲染颜色
            const currentRec = ratingLog[ratingLog.length - 1];
            drawRating(ratingImages[currentRatingIndex], currentRec.rating);
            break;

        case State.PHASE1_END:
            drawText("👏", canvas.width / 2, canvas.height / 2 - 120, 60);
            drawText("第一阶段（食物打分）已结束", canvas.width / 2, canvas.height / 2 - 30, 24, "#333");
            drawText("即将进入 第二阶段：二元选择", canvas.width / 2, canvas.height / 2 + 15, 20, "#666");
            drawText("请根据直觉，快速从左右图片中选出喜欢的", canvas.width / 2, canvas.height / 2 + 50, 16, "#666");

            ctx.fillStyle = SELECT_COLOR;
            ctx.fillRect(canvas.width / 2 - 100, canvas.height / 2 + 100, 200, 50);
            drawText("点击以开始", canvas.width / 2, canvas.height / 2 + 125, 20, "#fff");
            break;

        case State.TRIAL_DECISION:
            drawDecision(trials[currentTrialIndex]);
            break;

        case State.TRIAL_FEEDBACK:
            // 使用保存的安全索引，防止 currentTrialIndex 越界
            if (trials[lastFeedbackTrialIndex]) {
                drawDecision(trials[lastFeedbackTrialIndex], trials[lastFeedbackTrialIndex].selectionIndex);
            }
            break;

        case State.BREAK:
            drawText("休息一下", canvas.width / 2, canvas.height / 2 - 50, 40);
            drawText("准备好后点击屏幕继续", canvas.width / 2, canvas.height / 2 + 50, 20);
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

    // 绘制点击反馈（调试用：一个小蓝圈）
    if (lastTouchFeedback && Date.now() - lastTouchFeedback.time < 300) {
        ctx.strokeStyle = 'blue';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(lastTouchFeedback.x, lastTouchFeedback.y, 25, 0, Math.PI * 2);
        ctx.stroke();
    }
}

async function exportData() {
    console.log("🏁 Experiment finished. Starting export...");
    updateStatus("✅ 实验完成！请在弹出面板中下载数据。");

    // 先显示面板（不做任何 CSV 处理，防止崩溃）
    const downloadOverlay = document.getElementById('download-overlay');
    const dlSummary = document.getElementById('download-summary');
    dlSummary.textContent = `评分 ${ratingLog.length} 条 | 行为 ${behaviorLog.length} 条 | 眼动 ${gazeLog.length} 条`;

    const dlRating = document.getElementById('dl-rating');
    const dlBehavior = document.getElementById('dl-behavior');
    const dlGaze = document.getElementById('dl-gaze');

    dlRating.style.display = 'block';
    dlBehavior.style.display = 'block';
    if (gazeLog.length > 0) dlGaze.style.display = 'block';

    downloadOverlay.style.display = 'flex';

    // 按钮点击时才生成 CSV（延迟生成，防止内存爆炸）
    dlRating.onclick = async () => {
        dlRating.textContent = '⏳ 正在生成...';
        await new Promise(r => setTimeout(r, 100));
        try {
            const csv = jsonToCSV(ratingLog);
            await shareOrDownload(csv, `rating_food3_${subjectInfo.id}.csv`, dlRating, '📊 下载评分数据');
        } catch(e) { alert('评分数据导出失败: ' + e.message); dlRating.textContent = '❌ 失败，点击重试'; }
    };

    dlBehavior.onclick = async () => {
        dlBehavior.textContent = '⏳ 正在生成...';
        await new Promise(r => setTimeout(r, 100));
        try {
            const csv = jsonToCSV(behaviorLog);
            await shareOrDownload(csv, `behavior_food3_${subjectInfo.id}.csv`, dlBehavior, '🧠 下载行为数据');
        } catch(e) { alert('行为数据导出失败: ' + e.message); dlBehavior.textContent = '❌ 失败，点击重试'; }
    };

    dlGaze.onclick = async () => {
        dlGaze.textContent = '⏳ 正在生成眼动数据(可能需要几秒)...';
        await new Promise(r => setTimeout(r, 200));
        try {
            // 眼动数据去掉 face_mesh 字段用于分享（太大了）
            const gazeLogLight = gazeLog.map(({ face_mesh, ...rest }) => rest);
            const csv = jsonToCSV(gazeLogLight);
            await shareOrDownload(csv, `gaze_food3_${subjectInfo.id}.csv`, dlGaze, '👁 下载眼动数据');
        } catch(e) { alert('眼动数据导出失败: ' + e.message); dlGaze.textContent = '❌ 失败，点击重试'; }
    };
    // 抽奖按钮逻辑
    const lotteryBtn = document.getElementById('lottery-btn');
    lotteryBtn.onclick = () => {
        if (behaviorLog.length === 0) {
            alert('暂无行为数据，无法抽奖。');
            return;
        }
        // 随机抽取一轮
        const winIdx = Math.floor(Math.random() * behaviorLog.length);
        const winTrial = behaviorLog[winIdx];

        // 显示抽奖结果弹窗
        const lotteryOverlay = document.getElementById('lottery-overlay');
        const lotteryCanvas = document.getElementById('lottery-canvas');
        const ctx2 = lotteryCanvas.getContext('2d');
        lotteryCanvas.width = 440;
        lotteryCanvas.height = 440;

        document.getElementById('lottery-trial').textContent =
            `第 ${winTrial.trial} 轮（共 ${behaviorLog.length} 轮）`;
        document.getElementById('lottery-imgname').textContent =
            `图片编号: ${winTrial.chosen_img_id}.jpg`;

        // 在画布上绘制获奖食物图片
        const winImg = loadedImages[winTrial.chosen_img_id];
        ctx2.fillStyle = '#f5f5f5';
        ctx2.fillRect(0, 0, 440, 440);
        if (winImg) {
            drawImageCover(ctx2, winImg, 0, 0, 440, 440);
        } else {
            ctx2.fillStyle = '#ddd';
            ctx2.fillRect(0, 0, 440, 440);
            ctx2.fillStyle = '#888';
            ctx2.font = '20px Inter, sans-serif';
            ctx2.textAlign = 'center';
            ctx2.fillText(`图片 ${winTrial.chosen_img_id}`, 220, 220);
        }

        lotteryOverlay.style.display = 'flex';
    };
}

// iOS 兼容的文件分享/下载（用户手势触发）
async function shareOrDownload(csvContent, filename, btnElement, originalLabel) {
    // 方法1: Web Share API (iOS Safari 原生分享弹窗)
    try {
        const file = new File([csvContent], filename, { type: 'text/csv' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: filename });
            btnElement.textContent = '✅ ' + originalLabel.slice(2) + ' (已保存)';
            btnElement.classList.add('done');
            return;
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            btnElement.textContent = originalLabel;
            return; // 用户取消，恢复按钮
        }
        console.warn('Web Share failed:', e);
    }

    // 方法2: Blob URL (桌面浏览器)
    try {
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        btnElement.textContent = '✅ ' + originalLabel.slice(2) + ' (已下载)';
        btnElement.classList.add('done');
    } catch (e) {
        console.warn('Blob failed:', e);
        // 方法3: 新窗口打开
        const w = window.open('', '_blank');
        if (w) {
            w.document.write('<pre>' + csvContent.substring(0, 500000).replace(/</g, '&lt;') + '</pre>');
            w.document.title = filename;
            w.document.close();
            btnElement.textContent = '📄 已在新窗口打开';
            btnElement.classList.add('done');
        } else {
            alert('下载失败，请联系主试');
            btnElement.textContent = originalLabel;
        }
    }
}

// 极速静默上传 (替代 Fetch，绕过复杂的跨域拦截)
function syncWithBackendFetch(type, payload) {
    if (BACKEND_URL === "YOUR_GOOGLE_SCRIPT_URL_HERE") return Promise.resolve();

    return new Promise((resolve) => {
        const iframeName = 'fast_gs_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
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

        // 立马返回，不阻塞主流程
        resolve();

        // 20秒后自动回收占用的 DOM 内存
        setTimeout(() => {
            try { document.body.removeChild(form); } catch (e) { }
            try { document.body.removeChild(iframe); } catch (e) { }
        }, 20000);
    });
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
            const iframeName = 'gs_target_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
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

            console.log(`✅ ${type} data submitted (${payload.length} rows)`);

            // 表单提交后立即 resolve，不阻塞后续操作
            setTimeout(() => resolve(), 500);

            // iframe 和 form 延迟清理（给浏览器足够时间完成请求）
            setTimeout(() => {
                try { document.body.removeChild(form); } catch (x) { }
                try { document.body.removeChild(iframe); } catch (x) { }
            }, 15000);
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
    try {
        // 方法1: 使用 data URI（iOS Safari 兼容）
        const encodedCSV = encodeURIComponent(csv);
        const dataUri = 'data:text/csv;charset=utf-8,' + encodedCSV;

        const link = document.createElement("a");
        link.setAttribute("href", dataUri);
        link.setAttribute("download", filename);
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log(`📥 Downloaded: ${filename}`);
    } catch (e) {
        console.warn(`方法1失败 (${e.message})，尝试新窗口打开...`);
        try {
            // 方法2: 在新窗口中打开 CSV 内容，让用户手动保存
            const newWindow = window.open('', '_blank');
            if (newWindow) {
                newWindow.document.write('<pre>' + csv.replace(/</g, '&lt;') + '</pre>');
                newWindow.document.title = filename;
                newWindow.document.close();
            }
        } catch (e2) {
            console.error(`所有下载方法均失败: ${e2.message}`);
        }
    }
}

// 绑定开始按钮
startBtn.addEventListener('click', startExperiment);

// 检查微信并启动
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
if (isWechat) wechatPrompt.style.display = 'block';

// 启动程序
initMediaPipe();
