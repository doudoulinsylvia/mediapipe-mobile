const videoElement = document.getElementById('input_video');
const canvas = document.getElementById('experiment-canvas');
const ctx = canvas.getContext('2d');
const statusElement = document.getElementById('status');
const loadingOverlay = document.getElementById('loading-overlay');
const registrationOverlay = document.getElementById('registration-overlay');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');

// 实验参数
const TRIAL_LIMIT = 147;
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

let currentState = State.LOADING;
let subjectInfo = {};
let trials = [];
let currentTrialIndex = 0;
let behaviorLog = [];
let gazeLog = [];
let lastGaze = { x: 0, y: 0, valid: false };

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
        const lms = results.multiFaceLandmarks[0];

        // 计算眼动特征 (对应 Python 中的逻辑)
        // 简化版：使用虹膜中心作为特征
        const leftIris = lms[468];
        const rightIris = lms[473];
        const leftInner = lms[133];
        const leftOuter = lms[33];
        const rightInner = lms[362];
        const rightOuter = lms[263];

        const h_dist_l = Math.hypot(leftInner.x - leftOuter.x, leftInner.y - leftOuter.y);
        const h_dist_r = Math.hypot(rightInner.x - rightOuter.x, rightInner.y - rightOuter.y);

        const raw_lx = Math.hypot(leftIris.x - leftOuter.x, leftIris.y - leftOuter.y) / h_dist_l;
        const raw_rx = Math.hypot(rightIris.x - rightInner.x, rightIris.y - rightInner.y) / h_dist_r;

        const raw_x = (raw_lx + raw_rx) / 2.0;

        // 记录 gaze
        lastGaze.raw_x = raw_x;
        lastGaze.valid = true;

        // 映射到屏幕坐标
        lastGaze.x = mapX(raw_x);
        lastGaze.y = canvas.height / 2; // 这里简化，主要追踪左右注视

        if (currentState === State.TRIAL_DECISION || currentState === State.TRIAL_FIXATION || currentState === State.TRIAL_FEEDBACK) {
            recordGazeFrame();
        }
    } else {
        lastGaze.valid = false;
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
canvas.addEventListener('click', () => {
    if (currentState === State.CALIBRATION) {
        // 收集当前视角数据
        let samples = [];
        // 这里只是示意，实际应该在 onResults 里收集一段时间的均值
        // 为了演示，直接取当前值
        if (lastGaze.valid) {
            calibData.push(lastGaze.raw_x);
            currentCalibIndex++;
            if (currentCalibIndex >= calibPoints.length) {
                finishCalibration();
            }
        }
    } else if (currentState === State.BREAK) {
        currentCalibIndex = 0;
        calibData = [];
        currentState = State.CALIBRATION;
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
    gazeLog.push({
        timestamp: performance.now(),
        trial: currentTrialIndex + 1,
        phase: currentState,
        x: lastGaze.x.toFixed(2),
        y: lastGaze.y.toFixed(2),
        valid: lastGaze.valid ? 1 : 0
    });
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

function exportData() {
    const behaviorCSV = jsonToCSV(behaviorLog);
    downloadCSV(behaviorCSV, `behavior_${subjectInfo.id}.csv`);

    // Gaze 数据可能很大，可以分块或提示
    const gazeCSV = jsonToCSV(gazeLog);
    downloadCSV(gazeCSV, `gaze_${subjectInfo.id}.csv`);

    updateStatus("数据已导出");
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
