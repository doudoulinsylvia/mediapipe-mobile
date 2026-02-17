const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const statusElement = document.getElementById('status');
const loadingElement = document.getElementById('loading');
const startBtn = document.getElementById('start-btn');
const wechatPrompt = document.getElementById('wechat-prompt');

// 检查是否在微信中
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
if (isWechat) {
    wechatPrompt.classList.add('show');
}

function updateStatus(msg) {
    console.log(msg);
    statusElement.innerText = msg;
}

updateStatus("正在连接服务器...");

function onResults(results) {
    // 第一次得到结果时隐藏加载层
    if (loadingElement.style.opacity !== '0') {
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
        updateStatus(`正在下载模型: ${file}`);
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
    }
});

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
