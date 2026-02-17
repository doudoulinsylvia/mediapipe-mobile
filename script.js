const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const statusElement = document.getElementById('status');
const loadingElement = document.getElementById('loading');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');
const loadingStatus = document.getElementById('loading-status');

// 检查是否在微信中
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
if (isWechat) {
    wechatPrompt.classList.add('show');
}

function updateStatus(msg) {
    console.log(msg);
    if (statusElement) statusElement.innerText = msg;
    if (loadingStatus) loadingStatus.innerText = msg;
}

updateStatus("正在连接 MediaPipe 服务器...");

function onResults(results) {
    // 第一次得到结果时彻底移除加载层
    if (loadingElement && loadingElement.style.display !== 'none') {
        loadingElement.style.opacity = '0';
        setTimeout(() => {
            loadingElement.style.display = 'none';
            updateStatus("追踪运行中");
        }, 500);
    }

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // 绘制遮罩
    if (results.multiFaceLandmarks) {
        for (const landmarks of results.multiFaceLandmarks) {
            // 绘制面部网格 (简化版，为了性能)
            drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION,
                { color: '#C0C0C070', lineWidth: 1 });

            // 突出显示眼睛
            drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYE, { color: '#00f2fe' });
            drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYE, { color: '#00f2fe' });
            drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_IRIS, { color: '#00f2fe', lineWidth: 2 });
            drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_IRIS, { color: '#00f2fe', lineWidth: 2 });
        }
    }
    canvasCtx.restore();
}

const faceMesh = new FaceMesh({
    locateFile: (file) => {
        const url = `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        updateStatus(`正在下载: ${file}`);

        // 当第一个文件开始下载时，我们可以尝试稍微隐藏一点加载层或者确保按钮可见
        // 但最稳妥的是让用户能点到按钮
        return url;
    }
});

// 模拟初始化完成 (脚本加载后)
setTimeout(() => {
    if (loadingElement && loadingElement.style.opacity !== '0') {
        updateStatus("核心资源已就绪，请点击下方的“开启追踪”");
        // 将加载层透明度降低，并允许点击下方的按钮
        loadingElement.style.background = 'rgba(13, 17, 23, 0.7)';
        loadingElement.classList.add('interactive');
    }
}, 2500);

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true, // 启用虹膜追踪
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

faceMesh.onResults(onResults);

let camera = null;

startBtn.addEventListener('click', async () => {
    statusElement.innerText = "启动摄像头...";

    if (!camera) {
        camera = new Camera(videoElement, {
            onFrame: async () => {
                if (canvasElement.width !== videoElement.videoWidth) {
                    canvasElement.width = videoElement.videoWidth;
                    canvasElement.height = videoElement.videoHeight;
                    updateStatus("摄像头已就绪，识别中...");
                }
                await faceMesh.send({ image: videoElement });
            },
            width: 640,
            height: 480
        });
    }

    try {
        await camera.start();
        startBtn.style.display = 'none';
    } catch (error) {
        console.error("Camera error:", error);
        statusElement.innerText = "错误: 无法访问摄像头";
        alert("请确保使用 HTTPS 并授予摄像头权限。");
    }
});
