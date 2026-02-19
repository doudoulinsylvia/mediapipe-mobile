const videoElement = document.getElementById('input_video');
const canvas = document.getElementById('experiment-canvas');
const ctx = canvas.getContext('2d');
const statusElement = document.getElementById('status');
const loadingOverlay = document.getElementById('loading-overlay');
const registrationOverlay = document.getElementById('registration-overlay');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');

// 实验参数
const TRIAL_LIMIT = 3;
const PROBS = [5, 10, 25, 50, 75, 90, 95];
const CERTAINS = Array.from({ length: 21 }, (_, i) => i * 2); // 0, 2, ..., 40
const BG_COLOR = '#9b9b9b';
const TEXT_COLOR = '#000000';
const SELECT_COLOR = '#ff0000';

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

const BACKEND_URL = "http://192.168.2.25:5000/upload"; // 请替换为您电脑的局域网 IP

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
    statusElement.innerText = msg;
    console.log(msg);
}

// ==========================================================================
// 1. 初始化 MediaPipe
// ==========================================================================
async function initMediaPipe() {
    faceMesh = new FaceMesh({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
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

    try {
        await camera.start();
        updateStatus("摄像头已启动");
        loadingOverlay.style.display = 'none';
        currentState = State.REGISTRATION;
    } catch (e) {
        alert("无法访问摄像头，请确保使用 HTTPS 并授予权限。");
        updateStatus("错误: 摄像头不可用");
    }
}

function onResults(results) {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
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
        const valid = (v_dist / (h_dist + 1e-6)) > 0.14 ? 1 : 0;

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

    // 生成 Trial 序列
    let allTrials = [];
    PROBS.forEach(p => {
        CERTAINS.forEach(c => {
            allTrials.push({ prob: p, certain: c });
        });
    });
    // 洗牌
    allTrials.sort(() => Math.random() - 0.5);
    trials = allTrials.slice(0, TRIAL_LIMIT);

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

function drawDecision(trial, selection = null) {
    const boxW = canvas.width * 0.4;
    const boxH = canvas.height * 0.3;
    const centerY = canvas.height * 0.5;

    const leftX = canvas.width * 0.25;
    const rightX = canvas.width * 0.75;

    // 绘制两个框
    ctx.strokeStyle = (selection === 'left' ? SELECT_COLOR : TEXT_COLOR);
    ctx.lineWidth = 5;
    ctx.strokeRect(leftX - boxW / 2, centerY - boxH / 2, boxW, boxH);

    ctx.strokeStyle = (selection === 'right' ? SELECT_COLOR : TEXT_COLOR);
    ctx.strokeRect(rightX - boxW / 2, centerY - boxH / 2, boxW, boxH);

    // 随机左右座位
    const local = trial.local; // 0: Gamble-Left, 1: Sure-Left
    const gap = 40;

    if (local === 0) {
        // Left: Gamble
        drawText(`${trial.prob}%  40`, leftX, centerY - gap);
        drawText(`${100 - trial.prob}%  0`, leftX, centerY + gap);
        // Right: Sure
        drawText(`100%  ${trial.certain}`, rightX, centerY);
    } else {
        // Left: Sure
        drawText(`100%  ${trial.certain}`, leftX, centerY);
        // Right: Gamble
        drawText(`${trial.prob}%  40`, rightX, centerY - gap);
        drawText(`${100 - trial.prob}%  0`, rightX, centerY + gap);
    }
}

// 触摸处理 (Decision 阶段)
canvas.addEventListener('touchstart', (e) => {
    if (currentState !== State.TRIAL_DECISION) return;

    const touchX = e.touches[0].clientX;
    const trial = trials[currentTrialIndex];
    let key = '';

    if (touchX < canvas.width / 2) {
        key = 'left';
    } else {
        key = 'right';
    }

    // 处理决策逻辑
    handleDecision(key);
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
    trial.local = Math.random() < 0.5 ? 0 : 1; // 0: Gamble-Left
    trial.startTime = performance.now();
    currentState = State.TRIAL_FIXATION;

    setTimeout(() => {
        currentState = State.TRIAL_DECISION;
        trial.decisionStartTime = performance.now();
    }, 800 + Math.random() * 200);
}

function handleDecision(selection) {
    const trial = trials[currentTrialIndex];
    trial.selection = selection;
    trial.rt = performance.now() - trial.decisionStartTime;

    // 判定选择的是 gambling 还是 sure
    if (trial.local === 0) {
        trial.choice = (selection === 'left' ? 'gamble' : 'sure');
    } else {
        trial.choice = (selection === 'right' ? 'gamble' : 'sure');
    }

    currentState = State.TRIAL_FEEDBACK;

    setTimeout(() => {
        // 试验结果计算
        const probRand = Math.random() * 100;
        const gambleOutcome = (probRand < trial.prob ? 40 : 0);
        trial.payoff = (trial.choice === 'gamble' ? gambleOutcome : trial.certain);

        // 记录行为数据
        behaviorLog.push({
            trial: currentTrialIndex + 1,
            prob: trial.prob,
            certain: trial.certain,
            choice: trial.choice,
            rt: trial.rt.toFixed(2),
            payoff: trial.payoff,
            ...subjectInfo
        });

        nextTrial();
    }, 800);
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

    // 记录全量面部网格 (468点)
    // 注意：这将大幅增加 JSON 和 CSV 的体积
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
            drawDecision(trials[currentTrialIndex], trials[currentTrialIndex].selection);
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
        requestAnimationFrame(loop);
    }
}

async function exportData() {
    const behaviorCSV = jsonToCSV(behaviorLog);
    const gazeCSV = jsonToCSV(gazeLog);

    // 1. 本地下载备份 (防止网络问题)
    downloadCSV(behaviorCSV, `behavior_${subjectInfo.id}.csv`);
    setTimeout(() => {
        downloadCSV(gazeCSV, `gaze_${subjectInfo.id}.csv`);
    }, 1000);

    // 2. 同步到后台服务器
    updateStatus("正在同步到后台服务器...");

    try {
        await syncWithBackend('behavior', behaviorLog);
        await syncWithBackend('gaze', gazeLog);
        updateStatus("数据同步成功！");
    } catch (e) {
        console.error("Sync failed:", e);
        updateStatus("同步失败，请手动下载。内容: " + e.message);
    }
}

async function syncWithBackend(type, payload) {
    if (!BACKEND_URL.includes("YOUR_COMPUTER_IP")) {
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: type,
                subject_id: subjectInfo.id,
                payload: payload
            })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } else {
        console.warn("Backend URL not configured, skipping sync.");
    }
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
