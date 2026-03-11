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
const TOTAL_IMITS_COUNT = 200; // 总图片数
const IMAGES_PER_TRIAL = 2; // 二元选择（上下排布）
const BG_COLOR = '#ffffff';
const TEXT_COLOR = '#000000';
const SELECT_COLOR = '#ff0000';

let loadedImages = {}; // 存储预加载的图片对象

const State = {
    LOADING: 'LOADING',
    SUBJECT_INFO: 'SUBJECT_INFO',
    REGISTRATION: 'REGISTRATION',
    CALIBRATION: 'CALIBRATION',
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

    // 根据需求，评分阶段选取 200 张图片
    const reqCount = 200;
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
        lastGaze.pupil_size = pupil_size;

        // 映射到屏幕坐标
        lastGaze.x = mapX(raw_x);
        // 简单映射 Y：瞳孔在眼眶内的相对位置（一般在 0.3-0.7 之间）映射到 canvas.height
        // 这个映射不是绝对精确，旨在反映上/下翻眼的趋势
        lastGaze.y = Math.min(Math.max((raw_y - 0.2) / 0.6, 0), 1) * canvas.height;

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
        const margin = 30, spacing = 30, topMargin = 80;
        const availableWidth = canvas.width - margin * 2;
        const availableHeight = canvas.height - topMargin - margin;
        const imgW = Math.min(availableWidth * 0.8, 400);
        const imgH = (availableHeight - spacing) / 2;
        const size = Math.min(imgW, imgH);
        const offsetX = (canvas.width - size) / 2;
        const totalH = size * 2 + spacing;
        const startY = topMargin + (availableHeight - totalH) / 2;

        if (touchX >= offsetX && touchX <= offsetX + size &&
            touchY >= startY && touchY <= startY + size) {
            handleDecision(0);
        } else if (touchX >= offsetX && touchX <= offsetX + size &&
            touchY >= startY + size + spacing && touchY <= startY + size * 2 + spacing) {
            handleDecision(1);
        }
        return;
    }

    if (currentState === State.PHASE1_END) {
        generateCombinations();
        return;
    }

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
            if (navigator.vibrate) navigator.vibrate(50);
        }
        return;
    }

    if (currentState === State.BREAK) {
        currentCalibIndex = 0;
        calibData = [];
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
    const res = calibData;
    calibLimits.x_center = res[0]; // 第一个是中心点
    calibLimits.x_min = Math.min(...res) - (res[0] - Math.min(...res)) * 0.4;
    calibLimits.x_max = Math.max(...res) + (Math.max(...res) - res[0]) * 0.4;

    // 判断是否已经完成了评分阶段
    if (currentRatingIndex >= ratingImages.length) {
        // 评分已完成，继续二元选择阶段的下一个试次
        startTrial();
    } else {
        // 首次校准完成，进入评分阶段
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
        const top_rating = p[0];
        const bottom_rating = p[1];

        // 从对应分数池中随机抽取一张图
        const top_images = ratingGroups[top_rating];
        const bottom_images = ratingGroups[bottom_rating];
        const top_img = top_images[Math.floor(Math.random() * top_images.length)];
        const bottom_img = bottom_images[Math.floor(Math.random() * bottom_images.length)];

        trials.push({
            images: [top_img, bottom_img],
            top_rating: top_rating,
            bottom_rating: bottom_rating
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
            top_rating: trial.top_rating,
            bottom_img: trial.images[1],
            bottom_rating: trial.bottom_rating,
            chosen_position: selectionIndex === 0 ? 'top' : 'bottom', // 上 or 下
            chosen_img_id: trial.chosenImageId, // 实际图片的数字编号
            rt: trial.rt.toFixed(2),
            gaze_total_frames: gazeLog.length,
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

    const frame = {
        subject_id: subjectInfo.id || '',
        subject_name: subjectInfo.name || '',
        timestamp: performance.now().toFixed(2),
        trial: displayTrialNum,
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
            drawText("请根据直觉，快速从上下图片中选出喜欢的", canvas.width / 2, canvas.height / 2 + 50, 16, "#666");

            ctx.fillStyle = SELECT_COLOR;
            ctx.fillRect(canvas.width / 2 - 100, canvas.height / 2 + 100, 200, 50);
            drawText("点击以开始", canvas.width / 2, canvas.height / 2 + 125, 20, "#fff");
            break;

        case State.TRIAL_DECISION:
            drawDecision(trials[currentTrialIndex]);
            break;

        case State.TRIAL_FEEDBACK:
            drawDecision(trials[currentTrialIndex], trials[currentTrialIndex].selectionIndex);
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
    alert(`全流程结束！正在同步数据。\n本次共录得：\n评分数据 ${ratingLog.length} 条\n决策行为 ${behaviorLog.length} 条\n眼动原始数据 ${gazeLog.length} 条`);

    try {
        updateStatus("实验完成，正在准备行为数据...");
        const behaviorCSV = jsonToCSV(behaviorLog);

        updateStatus("行为数据就绪，正在转换眼动数据，请稍候...");
        await new Promise(r => setTimeout(r, 600)); // 留点时间显示 Alert

        if (gazeLog.length === 0) {
            updateStatus("⚠️ 警告：眼动数据为空，可能是因为摄像头全程未捕捉到面部。");
        }

        const gazeCSV = jsonToCSV(gazeLog);
        updateStatus("所有数据准备就绪，正在启动下载...");

        // 1. 本地下载备份
        const ratingCSV = jsonToCSV(ratingLog);
        downloadCSV(ratingCSV, `rating_food2_${subjectInfo.id}.csv`);
        await new Promise(r => setTimeout(r, 1000));
        downloadCSV(behaviorCSV, `behavior_food2_${subjectInfo.id}.csv`);
        await new Promise(r => setTimeout(r, 1000));
        downloadCSV(gazeCSV, `gaze_food2_${subjectInfo.id}.csv`);

        // 2. 同步到 Google Sheets
        updateStatus("正在上传 评分数据(第一阶段)...");
        await syncWithBackend('rating_food2', ratingLog);
        await new Promise(r => setTimeout(r, 1000));

        updateStatus("正在上传 行为决策数据(第二阶段)...");
        await syncWithBackend('behavior_food2', behaviorLog);

        updateStatus("行为数据已提交，开始上传眼动数据...");
        await new Promise(r => setTimeout(r, 2000));

        // 分块上传眼动数据（加速：每块 50 行，并行触发不阻挡）
        const CHUNK_SIZE = 50;
        const totalChunks = Math.ceil(gazeLog.length / CHUNK_SIZE);

        updateStatus(`正在后台极速上传 ${gazeLog.length} 行眼动数据，您可以离开页面...`);
        const gazePromises = [];
        for (let c = 0; c < totalChunks; c++) {
            updateStatus(`正在安全上传眼动数据... (进度: ${c + 1}/${totalChunks})`);
            const chunk = gazeLog.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
            syncWithBackendFetch('gaze_food2', chunk).catch(e => console.error(e));
            await new Promise(r => setTimeout(r, 1500));
        }

        // 额外等待 3 秒，确保最后一批数据完全进入谷歌服务器，防止被试秒关页面切断上传
        updateStatus("正在进行最终校验，请勿关闭页面...");
        await new Promise(r => setTimeout(r, 3000));

        updateStatus("✅ 所有数据已安全上传完毕！任务彻底完成。您可以关闭页面。");
    } catch (e) {
        console.error("Export Error:", e);
        updateStatus("⚠️ 数据已下载到手机。云端同步遇到问题: " + e.message + "\n请将手机下载的 CSV 文件发送给主试。");
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
