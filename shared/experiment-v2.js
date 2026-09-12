/* Mobile food gaze experiment. New schema; never submit to legacy services. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MobileExperimentV2 = api;
  if (root && root.document) root.addEventListener('DOMContentLoaded', () => {
    root.mobileExperiment = new api.Experiment(root.document.body.dataset.layout || 'horizontal');
  });
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const VERSION = '2.3.0';
  const SCHEMA = 2;
  const CALIBRATION_TARGETS = [0.08, 0.5, 0.92].flatMap((y, row) =>
    [0.08, 0.5, 0.92].map((x, col) => ({ targetId: `c${row * 3 + col + 1}`, targetX: x, targetY: y })));
  // Every coordinate pair differs from the fitting targets. No fitting on validation data.
  const VALIDATION_TARGETS = [[.16,.16],[.5,.18],[.84,.16],[.18,.5],[.52,.52],[.82,.5],[.16,.84],[.5,.82],[.84,.84]]
    .map(([x,y],i) => ({ targetId: `v${i+1}`, targetX:x, targetY:y }));
  const CONFIG = Object.freeze({
    schemaVersion: SCHEMA, layoutVersion: 'pixel-aligned-square-aoi-v2.0.2', settleMs: 600, collectMs: 1400, pointTimeoutMs: 6000,
    calibrationRounds:2, calibrationProtocol:'consistent_two_round_median_v3', calibrationAggregation:'presentation_median',
    calibrationConsistency:{maxNormalizedFeatureDelta:.25,maxMappedDeltaX:.15,maxMappedDeltaY:.15},
    maxCalibrationRepairCycles:1,
    kalman:{measurementStd:.04,accelerationStd:1.5,initialVelocityStd:.5,maxGapMs:150},
    calibrationPointTimeoutMs:12000, preparationCountdownMs:3000, preparationTimeoutMs:18000,
    calibrationStability:{windowMs:600,minFrames:12,maxGapMs:150,maxSpread:.06,maxDrift:.025,maxStep:.08},
    minValidFramesPerPoint: 12, validationEveryTrials: 50, fixationMinMs: 800, fixationMaxMs: 1000,
    maxDwellGapMs: 100, smoothTauMs: 65, smoothResetGapMs: 150,
    callbackGapWarningMs: 1000, callbackGapPauseMs: 5000, cameraStartupTimeoutMs: 20000,
    permissionTimeoutMs:60000, videoStartupTimeoutMs:20000, modelLoadTimeoutMs:120000,
    imageLoadTimeoutMs:30000, imageBatchTimeoutMs:180000,
    temporalQuality:{recoveryMs:100,minStableFrames:3,maxGapMs:500},
    validation: { minCoverage:.8, minSamplesPerPoint:12, minTargetCount:9,
      minTargetSpanX:.4, minTargetSpanY:.4, maxMeanErrorNorm:.12, maxP95ErrorNorm:.25,
      maxMeanAbsErrorX:.10, maxMeanAbsErrorY:.10, maxP95AbsErrorX:.20,
      maxP95AbsErrorY:.20, maxPointMeanErrorNorm:.18, maxPointP95ErrorNorm:.30,
      maxSampleGapMs:500, requireTimestamps:true },
    staticAssetBase: '../food2/mp/package/',
    assetIdentity: '@mediapipe/face_mesh@0.4.1633559619 (local package)',
    tasksAssetBase:'../shared/tasks-vision/0.10.32/',
    tasksAssetIdentity:'@mediapipe/tasks-vision@0.10.32; face_landmarker float16/1; GPU; VIDEO; numFaces=1',
    vendorManifest: '../shared/vendor-manifest.json (SHA-256 inventory of local MediaPipe assets)',
    onsetDefinition: 'performance.now inside requestAnimationFrame after canvas draw; software draw time, not measured physical photon onset',
    dwellRule: 'Raw predictions; an interval counts only when consecutive valid callbacks have the same rectangular AOI, within one trial and <= maxDwellGapMs. Everything else is UNKNOWN; no last-sample extrapolation.',
    coordinateDefinition: 'Normalized layout viewport: x / innerWidth, y / innerHeight. Unclipped. Not visual degrees or physical distance.'
  });
  const GAZE_HEADERS = [
    'schema_version','run_id','sample_id','result_timestamp','inference_start_timestamp','inference_end_timestamp',
    'phase','phase_id','trial_id','calibration_id','target_id','target_x','target_y','target_stage',
    'calibration_round','target_presentation_id','inference_calibration_round','inference_target_presentation_id',
    'inference_phase_id','inference_trial_id','phase_match','video_current_time','media_time','presented_frames',
    'video_width','video_height','screen_width','screen_height','device_pixel_ratio','viewport_id',
    'face_detected','eye_open','quality_valid','temporal_quality_valid','temporal_quality_reason',
    'temporal_recovering','temporal_stable_frames','temporal_ms_since_invalid','valid','valid_reason','left_ear','right_ear',
    'feature_lx','feature_ly','feature_rx','feature_ry','iris_ratio_left','iris_ratio_right','iris_ratio_mean',
    'head_center_x','head_center_y','head_scale','head_roll','model_id','model_hash',
    'gaze_x_raw','gaze_y_raw','gaze_x_smooth','gaze_y_smooth','gaze_x_kalman','gaze_y_kalman',
    'kalman_timestamp','kalman_reset','kalman_reason','kalman_variance_x','kalman_variance_y','offscreen','roi_raw','roi_smooth','roi_kalman',
    'horizontal_band','vertical_band','inference_trial_onset','current_trial_onset',
    'tracking_engine','tracking_diagnostics','preparation_stability','calibration_stability','calibration_window_id'
  ];
  const BEHAVIOR_HEADERS = ['schema_version','run_id','trial_id','trial_index','attempt','phase_id','layout','image_1','image_2',
    'rating_1','rating_2','position_1','position_2','onset_timestamp','response_timestamp','rt_ms','choice','chosen_image',
    'status','abort_reason','input_type','roi1_ms','roi2_ms','other_ms','unknown_ms','coverage','max_gap_ms','sample_count',
    'aoi_1','aoi_2','model_id','model_hash','validation_id','viewport_id'];
  const RATING_HEADERS = ['schema_version','run_id','rating_id','rating_index','image_id','rating','onset_timestamp',
    'response_timestamp','rt_ms','input_type','phase_id','model_id','validation_id','viewport_id'];
  const EVENT_HEADERS = ['schema_version','run_id','event_id','timestamp','event','phase','phase_id','trial_id','detail'];

  function csv(rows, headers) {
    const all = [...headers];
    for (const row of rows) for (const key of Object.keys(row)) if (!all.includes(key)) all.push(key);
    const field = value => {
      if (value === undefined || value === null) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return '\uFEFF' + [all.map(field).join(','), ...rows.map(row => all.map(key => field(row[key])).join(','))].join('\r\n') + '\r\n';
  }
  function shuffled(items, random = Math.random) {
    const a = items.slice();
    for (let i=a.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }
  function calibrationPlan(blockId, random = Math.random) {
    const first=shuffled(CALIBRATION_TARGETS,random),second=shuffled(CALIBRATION_TARGETS,random);
    // Avoid presenting an identical order twice, including deterministic test RNGs.
    if(first.every((target,i)=>target.targetId===second[i].targetId))second.push(second.shift());
    return [first,second].flatMap((targets,index)=>targets.map(target=>({...target,roundIndex:index+1,
      presentationId:`${blockId}-r${index+1}-${target.targetId}`})));
  }
  function generateCombinations(ratings, count, random = Math.random) {
    const groups = new Map();
    for (const row of ratings) {
      if (!groups.has(row.rating)) groups.set(row.rating, []);
      groups.get(row.rating).push(row.image_id);
    }
    const values = [...groups.keys()].sort((a,b)=>a-b);
    if (values.length < 2) return [];
    const pairs = values.flatMap(a => values.filter(b=>b!==a).map(b=>[a,b]));
    const pick = a => a[Math.floor(random()*a.length)];
    return Array.from({length:count}, () => {
      const [a,b]=pick(pairs);
      return {images:[pick(groups.get(a)),pick(groups.get(b))],rating_1:a,rating_2:b};
    });
  }
  function classify(x, y, valid, aois, width, height) {
    if (!valid || !Number.isFinite(x) || !Number.isFinite(y)) return {roi:'UNKNOWN',horizontal:'UNKNOWN',vertical:'UNKNOWN'};
    const px=x*width, py=y*height;
    const hit=(v,lo,hi)=>v>=lo&&v<hi;
    let roi='0',horizontal='0',vertical='0';
    for (let i=0;i<aois.length;i++) {
      const b=aois[i], label=String(i+1);
      if (hit(px,b.x,b.x+b.width) && hit(py,b.y,b.y+b.height)) roi=label;
      if (hit(px,b.x,b.x+b.width)) horizontal = horizontal==='0' ? label : 'OVERLAP';
      if (hit(py,b.y,b.y+b.height)) vertical = vertical==='0' ? label : 'OVERLAP';
    }
    return {roi,horizontal,vertical};
  }
  function dwell(samples, onset, response, maxGapMs=100) {
    const end=Math.max(onset,response), rt=end-onset;
    const times={roi1_ms:0,roi2_ms:0,other_ms:0,unknown_ms:rt};
    const rows=samples.filter(s=>Number.isFinite(s.result_timestamp)&&s.result_timestamp>=onset&&s.result_timestamp<=end);
    let maxGap=rows.length?Math.max(rows[0].result_timestamp-onset,end-rows[rows.length-1].result_timestamp):rt;
    // A corrupted/nonmonotonic series is not evidence of measured dwell.
    if(rows.some((r,i)=>i>0&&r.result_timestamp<=rows[i-1].result_timestamp))
      return {...times,coverage:0,max_gap_ms:rt,sample_count:rows.length};
    for(let i=1;i<rows.length;i++) {
      const a=rows[i-1],b=rows[i],dt=b.result_timestamp-a.result_timestamp;
      maxGap=Math.max(maxGap,dt);
      if(dt<=0||dt>maxGapMs||!a.valid||!b.valid||a.roi_raw!==b.roi_raw) continue;
      const key={'1':'roi1_ms','2':'roi2_ms','0':'other_ms'}[a.roi_raw];
      if(key) times[key]+=dt;
    }
    times.unknown_ms=Math.max(0,rt-times.roi1_ms-times.roi2_ms-times.other_ms);
    return {...times,coverage:rt>0?(rt-times.unknown_ms)/rt:0,max_gap_ms:maxGap,sample_count:rows.length};
  }
  function smooth(previous, point, timestamp, config=CONFIG) {
    if(!previous||timestamp-previous.timestamp>config.smoothResetGapMs||timestamp<=previous.timestamp)
      return {...point,timestamp};
    const a=1-Math.exp(-(timestamp-previous.timestamp)/config.smoothTauMs);
    return {x:previous.x+a*(point.x-previous.x),y:previous.y+a*(point.y-previous.y),timestamp};
  }
  function hashModel(value) {
    // Noncryptographic reproducibility checksum. Full exact model is retained in calibration.json.
    let h=2166136261;
    for(const c of JSON.stringify(value)) { h^=c.charCodeAt(0); h=Math.imul(h,16777619); }
    return `fnv1a32-${(h>>>0).toString(16).padStart(8,'0')}`;
  }

  class Experiment {
    constructor(layout) {
      this.layout=layout==='vertical'?'vertical':'horizontal';
      this.pilot=new URLSearchParams(location.search).get('pilot')==='1';
      this.engine=new URLSearchParams(location.search).get('engine')||document.body.dataset.engine||'legacy';
      this.config=JSON.parse(JSON.stringify(CONFIG));
      this.config.trackingEngine=this.engine;
      if(this.engine==='tasks') {
        this.config.assetIdentity=this.config.tasksAssetIdentity;
        this.config.vendorManifest='../shared/tasks-vision/0.10.32/manifest.json';
      }
      this.ratingCount=this.pilot?6:200; this.trialCount=this.pilot?6:150;
      this.runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)}`;
      this.phase='welcome'; this.phaseId='phase-0'; this.phaseSequence=0; this.token=0; this.timer=null;
      this.startedAt=Date.now(); this.startedPerf=performance.now(); this.sampleId=0; this.eventId=0;
      this.gaze=[]; this.behavior=[]; this.ratings=[]; this.events=[]; this.calibrations=[]; this.viewports=[];
      this.images=new Map(); this.ratingIds=[]; this.ratingIndex=0; this.trialIndex=0; this.trialAttempts={}; this.trials=[];
      this.model=null; this.modelId=null; this.modelHash=null; this.validationId=null; this.validationOK=false;
      this.calibrationSequence=0; this.validationSequence=0; this.target=null; this.targetRecord=null; this.block=null;
      this.trial=null; this.rating=null; this.aois=[]; this.smoothed=null; this.stream=null; this.mesh=null;
      this.kalman=window.GazeFilter?window.GazeFilter.createFilter(this.config.kalman):null;
      this.runningCamera=false; this.pending=false; this.lastVideoTime=-1; this.lastCallback=null; this.lastGapEvent=null;
      this.cameraFrameHandle=null; this.cameraFrameKind=null; this.watchdogHandle=null; this.inferenceMeta=null; this.resumeAction='rating';
      this.participantId=''; this.viewportId=0; this.cameraSettings={};
      this.startupStageInfo=null;this.initializingModel=null;this.imageLoadCancels=new Set();
      this.samplingGate=null;this.collectionGate=null;this.preparation=null;
      this.temporalQuality=window.GazeCore&&GazeCore.createTemporalQualityGate?GazeCore.createTemporalQualityGate(this.config.temporalQuality):null;
      this.canvas=document.getElementById('stage'); this.ctx=this.canvas.getContext('2d');
      this.panel=document.getElementById('panel'); this.status=document.getElementById('status');
      this.video=document.getElementById('camera'); this.ratingControls=document.getElementById('ratings');
      this.pauseButton=document.getElementById('pause');
      this.resizeCanvas('initial'); this.bind(); this.welcome();
      this.event('session_created',{layout:this.layout,pilot:this.pilot});
    }
    bind() {
      this.canvas.addEventListener('pointerdown', e=>{
        const t=performance.now();
        if(this.phase!=='choice'||!this.trial) return;
        const r=this.canvas.getBoundingClientRect(),x=(e.clientX-r.left)*this.width/r.width,y=(e.clientY-r.top)*this.height/r.height;
        const index=this.aois.findIndex(b=>x>=b.x&&x<b.x+b.width&&y>=b.y&&y<b.y+b.height);
        if(index>=0) {e.preventDefault();this.respond(index+1,t,e.pointerType||'pointer');}
      });
      document.addEventListener('keydown',e=>{
        if(this.phase==='choice'&&['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(e.key)) {
          e.preventDefault(); this.respond(['ArrowLeft','ArrowUp'].includes(e.key)?1:2,performance.now(),'keyboard');
        }
      });
      this.pauseButton.addEventListener('click',()=>this.pause('user_pause'));
      document.getElementById('save-backup').addEventListener('click',()=>this.download('backup'));
      window.addEventListener('resize',()=>this.viewportChanged('resize'));
      if(window.visualViewport) window.visualViewport.addEventListener('resize',()=>this.viewportChanged('visual_viewport_resize'));
      document.addEventListener('visibilitychange',()=>{
        this.event(document.hidden?'page_hidden':'page_visible',{});
        if(document.hidden&&this.runningCamera) this.pause('page_hidden');
      });
      window.addEventListener('pagehide',()=>{this.event('pagehide',{});
        if(!['welcome','paused','finished'].includes(this.phase))this.pause('page_hidden');else this.stopCamera();});
      window.addEventListener('beforeunload',e=>{
        if(this.gaze.length&&this.phase!=='finished') {e.preventDefault();e.returnValue='';}
      });
      for(let value=1;value<=10;value++) {
        const button=document.createElement('button'); button.textContent=value; button.setAttribute('aria-label',`喜好评分 ${value}`);
        button.addEventListener('pointerdown',e=>{ e.preventDefault();this.rate(value,performance.now(),e.pointerType||'pointer'); });
        button.addEventListener('click',e=>{if(e.detail===0)this.rate(value,performance.now(),'keyboard');});
        this.ratingControls.append(button);
      }
    }
    event(name, detail, timestamp=performance.now()) {
      this.events.push({schema_version:SCHEMA,run_id:this.runId,event_id:++this.eventId,timestamp,event:name,
        phase:this.phase,phase_id:this.phaseId,trial_id:this.trial?this.trial.id:null,detail});
    }
    enter(phase,detail={}) {
      this.event('phase_exit',{next:phase});
      if(this.timer!==null) clearTimeout(this.timer);
      this.timer=null; this.token++; this.smoothed=null; this.phase=phase; this.phaseId=`phase-${++this.phaseSequence}`;
      if(this.kalman)this.kalman.reset();
      this.ratingControls.hidden=true; this.panel.hidden=true;
      this.pauseButton.hidden=['welcome','starting','paused','finished','failure'].includes(phase);
      this.event('phase_enter',detail); return this.token;
    }
    later(ms, callback) {
      if(this.timer!==null) clearTimeout(this.timer);
      const token=this.token;
      this.timer=setTimeout(()=>{this.timer=null;if(token===this.token)callback();},ms);
    }
    drawOnFrame(draw,done) {
      const token=this.token;
      requestAnimationFrame(()=>{
        if(token!==this.token)return;
        draw(); const onset=performance.now(); if(done)done(onset);
      });
    }
    clear() { this.ctx.fillStyle='#f6f5f1';this.ctx.fillRect(0,0,this.width,this.height); }
    text(lines) {
      this.clear(); this.ctx.fillStyle='#263b37';this.ctx.textAlign='center';this.ctx.font='20px system-ui';
      lines.forEach((line,i)=>this.ctx.fillText(line,this.width/2,this.height/2+i*34));
    }
    showPanel(title,paragraphs,buttons) {
      this.panel.replaceChildren();
      const heading=document.createElement('h1');heading.textContent=title;this.panel.append(heading);
      for(const text of paragraphs){const p=document.createElement('p');p.textContent=text;this.panel.append(p);}
      for(const [label,handler,secondary] of buttons||[]) {
        const b=document.createElement('button');b.textContent=label;if(secondary)b.className='secondary';
        b.addEventListener('click',handler);this.panel.append(b);
      }
      this.panel.hidden=false;
    }
    welcome() {
      if(!['legacy','tasks'].includes(this.engine)||this.engine==='tasks'&&!this.pilot) {
        this.showPanel('请使用预实验入口',['新版检测器目前只用于预实验对照。请打开带 pilot=1 的对应入口；本次没有启动相机或自动切换检测器。'],[]);return;
      }
      this.status.textContent=`v${VERSION} · ${this.pilot?'预实验模式 · 6评分 / 6选择':'手机眼动实验 · 改进版'}`;
      this.showPanel(this.pilot?'预实验模式':'手机食物选择实验',[
        `本次 ${this.ratingCount} 张图片评分、${this.trialCount} 次${this.layout==='vertical'?'上下':'左右'}选择。请固定手机，保持光照和观看距离稳定。`,
        '需要前置摄像头。图像只在本设备处理，不保存照片或视频，不自动上传数据。请在 Safari / Chrome 的 HTTPS 页面打开。',
        '先做中央圆点练习，再进行两轮九点校准，通常约1–2分钟。圆点周围进度环填满后再看下一个点；不稳定时会重新采样。随后进行独立验证。',
        '两轮同一点差异过大时，会提示成对补采一次。戴眼镜时请先调整光线，避免镜片亮斑遮住眼睛；保持能看清目标的视力矫正。',
        this.engine==='tasks'?'本入口为新版检测器对照预实验，尚未证实比原版更准确。':'本入口使用原检测器，测试稳定采样与稳健拟合的改进。',
        '结束后请下载完整备份。关闭或刷新页面会丢失尚未下载的数据。'
      ],[['开启摄像头并准备',()=>this.start()]]);
      const label=document.createElement('label');label.textContent='参与者编号（可选，不填写姓名）';
      const input=document.createElement('input');input.id='participant-id';input.maxLength=60;input.placeholder='例如 P001';
      label.append(input);this.panel.insertBefore(label,this.panel.lastChild);
    }
    async start() {
      if(this.phase!=='welcome'&&this.phase!=='failure'&&this.phase!=='paused')return;
      const input=document.getElementById('participant-id');if(input)this.participantId=input.value.trim();
      const token=this.enter('starting');
      this.startupStageInfo=null;
      this.prepareStage('permission','1 / 5 · 等待相机授权','请在 Safari / Chrome 的提示中允许使用前置摄像头。',
        this.config.permissionTimeoutMs,'等待相机授权超时。请检查此网站的相机权限后重试。');
      try {
        if(!window.isSecureContext)throw new Error('需要 HTTPS 或 localhost 安全页面');
        if(!window.CalibrationConsistency||!this.kalman)throw new Error('新版校准或滤波文件未加载，请刷新页面后重试');
        if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('此浏览器不支持摄像头访问');
        if(!['legacy','tasks'].includes(this.engine)||this.engine==='tasks'&&!this.pilot)throw new Error('新版检测器仅限预实验入口');
        if(!(this.engine==='tasks'?window.TrackingAdapter:window.FaceMesh)||!window.CalibrationStability||!window.GazeCore||!GazeCore.createRepeatedCalibration||!this.temporalQuality||!window.ValidationReport||!window.CalibrationReport)throw new Error('实验脚本未完整载入。请保存备份后用新版链接重新打开。');
        if(!this.ratingIds.length)this.ratingIds=shuffled(Array.from({length:200},(_,i)=>i+1)).slice(0,this.ratingCount);
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:60}}});
        if(token!==this.token){stream.getTracks().forEach(t=>t.stop());return;}
        this.prepareStage('video','2 / 5 · 开启相机画面','相机权限已获得，正在启动视频。请保持 Safari 在前台。',
          this.config.videoStartupTimeoutMs,'相机已获授权，但视频播放超时。请关闭其他占用相机的页面后重试。');
        this.stream=stream;this.video.muted=true;this.video.autoplay=true;this.video.playsInline=true;
        this.video.setAttribute('playsinline','');this.video.setAttribute('webkit-playsinline','');
        this.video.srcObject=stream;await this.video.play();
        if(token!==this.token){stream.getTracks().forEach(t=>t.stop());return;}
        this.cameraSettings=stream.getVideoTracks()[0].getSettings();
        this.event('camera_started',{settings:this.cameraSettings});
        stream.getVideoTracks()[0].addEventListener('ended',()=>{
          if(this.stream===stream&&(this.runningCamera||this.phase==='starting'))this.pause('camera_track_ended');
        });
        this.prepareStage('model','3 / 5 · 加载眼动模型','相机已开启。首次需要下载模型并初始化，较慢网络最多等待 2 分钟；请保持页面在前台。',
          this.config.modelLoadTimeoutMs,'眼动模型加载超时，相机授权已成功。请换稳定网络后重试；若仍停在此步骤，请先下载备份，再刷新 Safari 页面。');
        // The pinned MediaPipe loader writes global factories. Never run two
        // initializations concurrently, including a canceled earlier attempt.
        if(this.initializingModel) {
          await this.initializingModel.promise.catch(()=>{});
          if(token!==this.token)return;
        }
        if(!this.mesh) {
          this.mesh=this.engine==='tasks'?window.TrackingAdapter.create({engine:'tasks',assetBase:new URL(this.config.tasksAssetBase,location.href).href}):
            new FaceMesh({locateFile:file=>new URL(this.config.staticAssetBase+file,location.href).href});
          if(this.engine==='legacy')this.mesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6,selfieMode:false});
          const instance=this.mesh;
          instance.onResults((results,captured)=>this.onResults(results,captured||instance.captureMeta||{},instance));
        }
        const instance=this.mesh;
        const record={instance,promise:null};
        this.initializingModel=record;
        // Some errors in this legacy loader are thrown by XHR handlers rather
        // than rejecting initialize(). Preserve the resource failure in diagnostics.
        const resourceError=e=>{
          if(token!==this.token||this.startupStageInfo?.name!=='model')return;
          const assetUrl=new URL(this.engine==='tasks'?this.config.tasksAssetBase:this.config.staticAssetBase,location.href).href;
          if(typeof e.filename==='string'&&e.filename.startsWith(assetUrl)) {
            this.event('startup_resource_error',{filename:e.filename,message:e.message});
            this.fail('model_resource_error','眼动模型资源加载失败。请检查网络；保存备份后刷新页面可重新加载模型。');
          }
        };
        window.addEventListener('error',resourceError);
        record.promise=Promise.resolve().then(()=>typeof instance.initialize==='function'?instance.initialize():undefined)
          .finally(()=>{
            window.removeEventListener('error',resourceError);
            if(this.initializingModel===record)this.initializingModel=null;
            if(this.mesh!==instance)this.closeModel(instance);
          });
        await record.promise;
        if(token!==this.token)return;
        this.trackingIdentity=instance.identity||{engine:'legacy',packageVersion:'0.4.1633559619',
          options:{maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6,selfieMode:false}};
        this.event('tracking_engine_ready',this.trackingIdentity);
        this.prepareStage('images','4 / 5 · 加载实验图片',`正在准备 ${this.ratingIds.length} 张图片，已完成的图片会保留供重试。`,
          this.config.imageBatchTimeoutMs,'实验图片加载超时。相机与模型已成功启动，请检查网络后重试；已加载的图片会保留。');
        await this.preloadImages(token);
        if(token!==this.token)return;
        // Initialization and the first callback each have bounded, cancelable waits.
        this.awaitingFirstResultToken=token;
        this.prepareStage('first_result','5 / 5 · 等待相机结果','模型与图片已准备好，正在读取第一帧。请让整张脸进入前置摄像头。',
          this.config.cameraStartupTimeoutMs,'模型和图片已载入，但尚未收到摄像头推理结果。请保持 Safari 在前台后重试。','first_callback_timeout');
        this.runningCamera=true; this.lastVideoTime=-1;this.lastCallback=null;this.cameraStartedPerf=performance.now();this.scheduleCamera();this.watchCamera();
      } catch(error) {
        if(token!==this.token)return;
        this.fail(error.code||`${this.startupStageInfo?.name||'camera_start'}_error`,`启动失败：${error.message}`);
      }
    }
    prepareStage(name,title,message,timeoutMs,timeoutMessage,code=`${name}_timeout`) {
      if(this.startupStageInfo)this.event('startup_stage_complete',{...this.startupStageInfo,elapsed_ms:performance.now()-this.startupStageInfo.startedAt});
      this.startupStageInfo={name,startedAt:performance.now()};
      this.event('startup_stage_start',{name,timeout_ms:timeoutMs});
      this.status.textContent=`v${VERSION} · ${title}`;
      this.showPanel(title,[message],[['取消',()=>this.pause('startup_cancel'),true]]);
      this.later(timeoutMs,()=>this.fail(code,timeoutMessage));
    }
    async preloadImages(token=this.token) {
      const base=this.layout==='vertical'?'../food2/images/':'../food3/images/';
      const ids=this.ratingIds.filter(id=>!this.images.has(id));let cursor=0,stopped=false;
      const cancels=new Set();
      const progress=()=>{if(token===this.token&&this.phase==='starting')this.status.textContent=`v${VERSION} · 4 / 5 · 图片 ${this.ratingIds.filter(id=>this.images.has(id)).length} / ${this.ratingIds.length}`;};
      progress();
      const worker=async()=>{while(!stopped&&token===this.token&&cursor<ids.length){
        const id=ids[cursor++],image=new Image();
        await new Promise((resolve,reject)=>{
          let done=false,timer=null;
          const finish=(error)=>{
            if(done)return;done=true;clearTimeout(timer);image.onload=null;image.onerror=null;
            cancels.delete(cancel);this.imageLoadCancels.delete(cancel);
            if(error){if(typeof image.removeAttribute==='function')image.removeAttribute('src');else image.src='';reject(error);}else resolve();
          };
          const cancel=()=>{const error=new Error('图片加载已取消');error.name='AbortError';finish(error);};
          cancels.add(cancel);this.imageLoadCancels.add(cancel);
          image.onload=()=>{if(done)return;if(image.naturalWidth)finish();else image.onerror();};
          image.onerror=()=>{const error=new Error(`图片 ${id} 载入失败，请检查网络后重试。`);error.code='image_load_error';finish(error);};
          timer=setTimeout(()=>{const error=new Error(`图片 ${id} 载入超时，请检查网络后重试。`);error.code='image_load_timeout';finish(error);},this.config.imageLoadTimeoutMs);
          image.src=base+id+'.jpg';
          if(image.complete&&image.naturalWidth)finish();
        });
        if(stopped||token!==this.token)return;
        this.images.set(id,image);progress();
        this.event('image_loaded',{image_id:id,loaded:this.images.size,total:this.ratingIds.length});
      }};
      try{await Promise.all(Array.from({length:Math.min(4,ids.length)},worker));}
      catch(error){stopped=true;for(const cancel of [...cancels])cancel();throw error;}
    }
    closeModel(instance) {
      if(instance&&typeof instance.close==='function') {
        try{Promise.resolve(instance.close()).catch(()=>{});}catch(_){/* Retired model cannot affect a retry. */}
      }
    }
    scheduleCamera() {
      if(!this.runningCamera||this.cameraFrameHandle!==null)return;
      if(typeof this.video.requestVideoFrameCallback==='function') {
        this.cameraFrameKind='video';
        this.cameraFrameHandle=this.video.requestVideoFrameCallback((_,meta)=>this.cameraFrame(meta));
      } else {this.cameraFrameKind='raf';this.cameraFrameHandle=requestAnimationFrame(()=>this.cameraFrame(null));}
    }
    async cameraFrame(metadata) {
      this.cameraFrameHandle=null;
      if(!this.runningCamera)return;
      const now=performance.now();
      const currentTime=this.video.currentTime;
      if(this.pending||this.video.readyState<2||currentTime===this.lastVideoTime){this.scheduleCamera();return;}
      this.lastVideoTime=currentTime;this.pending=true;
      const meta={start:now,phaseId:this.phaseId,phase:this.phase,trialId:this.trial?this.trial.id:null,
        onset:this.trial?this.trial.onset:null,videoTime:currentTime,mediaTime:metadata?metadata.mediaTime:null,
        presentedFrames:metadata?metadata.presentedFrames:null,target:this.target?{...this.target}:null,viewportId:this.viewportId};
      const instance=this.mesh;this.inferenceMeta=meta;instance.captureMeta=meta;
      try{await instance.send({image:this.video,timestamp:now});}
      catch(error){this.event('inference_error',{message:error.message,inference_start:now});if(instance===this.mesh)this.pause('inference_error');}
      finally {
        if(instance===this.mesh){this.pending=false;this.inferenceMeta=null;this.scheduleCamera();}
        else if(typeof instance.close==='function'){try{await instance.close();}catch(_){/* Retired camera cannot mutate the active session. */}}
      }
    }
    watchCamera() {
      if(!this.runningCamera||this.watchdogHandle!==null)return;
      this.watchdogHandle=requestAnimationFrame(()=>{
        this.watchdogHandle=null;
        if(!this.runningCamera)return;
        const now=performance.now(),elapsed=now-(this.lastCallback||this.cameraStartedPerf);
        if(elapsed>this.config.callbackGapWarningMs&&(!this.lastGapEvent||now-this.lastGapEvent>this.config.callbackGapWarningMs)) {
          this.lastGapEvent=now;this.smoothed=null;
          this.event('callback_gap',{elapsed_ms:elapsed,source:'animation_frame_watchdog'});
        }
        // This is a gap event, never a fabricated gaze sample.
        if(elapsed>this.config.callbackGapPauseMs&&this.lastCallback!==null) {
          this.pause('camera_callback_gap');return;
        }
        this.watchCamera();
      });
    }
    stopCamera() {
      this.runningCamera=false;
      if(this.kalman)this.kalman.reset();
      if(this.temporalQuality)this.temporalQuality.reset();
      for(const cancel of [...this.imageLoadCancels])cancel();
      if(this.watchdogHandle!==null){cancelAnimationFrame(this.watchdogHandle);this.watchdogHandle=null;}
      if(this.cameraFrameHandle!==null) {
        if(this.cameraFrameKind==='video')this.video.cancelVideoFrameCallback(this.cameraFrameHandle);else cancelAnimationFrame(this.cameraFrameHandle);
        this.cameraFrameHandle=null;
      }
      if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null;}
      this.video.srcObject=null;
      this.awaitingFirstResultToken=null;
      const instance=this.mesh,wasPending=this.pending;
      this.mesh=null;this.pending=false;this.inferenceMeta=null;
      if(instance&&!wasPending&&this.initializingModel?.instance!==instance)this.closeModel(instance);
    }
    onResults(results,sourceMeta,sourceInstance) {
      const now=performance.now(),meta=sourceMeta||this.inferenceMeta||{};
      if(meta.phaseId===this.phaseId)this.lastCallback=now;
      const landmarks=results.multiFaceLandmarks&&results.multiFaceLandmarks[0];
      const extracted=GazeCore.extractFeatures(landmarks,this.video.videoWidth,this.video.videoHeight);
      const q=extracted.quality||{},f=extracted.features||[],iris=extracted.iris||{},diag=(extracted.diagnostics||{}).headProxy||{};
      // A retired camera must not change the active stream's recovery history.
      // Same-stream frames remain useful to this causal gate across target boundaries.
      const currentCamera=this.runningCamera&&(!sourceInstance||sourceInstance===this.mesh);
      const temporal=currentCamera&&this.temporalQuality?this.temporalQuality.update(q,meta.start):
        {valid:false,reason:'stale_camera',recovering:false,stableFrames:0,msSinceInvalid:null};
      const phaseMatch=meta.phaseId===this.phaseId&&meta.viewportId===this.viewportId;
      const target=this.target;
      const targetMatch=!target||Boolean(meta.target&&meta.target.targetId===target.targetId&&
        meta.target.presentationId===target.presentationId&&meta.target.roundIndex===target.roundIndex);
      const predicted=this.model&&q.valid?GazeCore.predict(this.model,f):{x:null,y:null,ok:false,reason:'uncalibrated'};
      const preStimulus=this.phase==='choice'&&this.trial&&(this.trial.onset===null||meta.onset==null||meta.start<this.trial.onset);
      const valid=Boolean(q.valid&&temporal.valid&&predicted.ok&&phaseMatch&&targetMatch&&!preStimulus);
      const reason=!phaseMatch?'stale_phase':!targetMatch?'stale_target_presentation':preStimulus?'pre_stimulus':!q.valid?(q.reason||'invalid_features'):
        !temporal.valid?temporal.reason:!predicted.ok?(predicted.reason||'prediction_invalid'):'ok';
      if(valid)this.smoothed=smooth(this.smoothed,{x:predicted.x,y:predicted.y},now,this.config);else this.smoothed=null;
      const filtered=currentCamera&&this.kalman?this.kalman.update({x:predicted.x,y:predicted.y,timestamp:meta.start,valid}):
        {x:null,y:null,timestamp:null,valid:false,reset:false,reason:'filter_unavailable'};
      const raw=classify(predicted.x,predicted.y,valid,this.aois,this.width,this.height);
      const sm=classify(this.smoothed&&this.smoothed.x,this.smoothed&&this.smoothed.y,valid,this.aois,this.width,this.height);
      const kf=classify(filtered.x,filtered.y,valid&&filtered.valid,this.aois,this.width,this.height);
      const row={schema_version:SCHEMA,run_id:this.runId,sample_id:++this.sampleId,result_timestamp:now,
        inference_start_timestamp:meta.start,inference_end_timestamp:now,phase:this.phase,phase_id:this.phaseId,
        trial_id:this.trial?this.trial.id:null,calibration_id:this.block?this.block.id:null,
        target_id:target?target.targetId:null,target_x:target?target.targetX:null,target_y:target?target.targetY:null,
        calibration_round:target?target.roundIndex||null:null,target_presentation_id:target?target.presentationId||null:null,
        inference_calibration_round:meta.target?meta.target.roundIndex||null:null,
        inference_target_presentation_id:meta.target?meta.target.presentationId||null:null,
        target_stage:target?(this.block?.kind==='calibration'?this.targetRecord.samplingStage:now<this.targetRecord.collectStart?'settle':'collect'):null,
        inference_phase_id:meta.phaseId,inference_trial_id:meta.trialId,phase_match:phaseMatch,
        video_current_time:meta.videoTime,media_time:meta.mediaTime,presented_frames:meta.presentedFrames,
        video_width:this.video.videoWidth,video_height:this.video.videoHeight,screen_width:this.width,screen_height:this.height,
        device_pixel_ratio:devicePixelRatio,viewport_id:this.viewportId,face_detected:Boolean(q.faceDetected),eye_open:Boolean(q.eyeOpen),
        quality_valid:Boolean(q.valid),valid,valid_reason:reason,left_ear:q.leftEAR,right_ear:q.rightEAR,
        temporal_quality_valid:temporal.valid,temporal_quality_reason:temporal.reason,
        temporal_recovering:temporal.recovering,temporal_stable_frames:temporal.stableFrames,
        temporal_ms_since_invalid:temporal.msSinceInvalid,
        feature_lx:f[0],feature_ly:f[1],feature_rx:f[2],feature_ry:f[3],iris_ratio_left:iris.leftRatio,
        iris_ratio_right:iris.rightRatio,iris_ratio_mean:iris.meanRatio,
        head_center_x:diag.centerX,head_center_y:diag.centerY,head_scale:diag.eyeSeparationNorm,head_roll:diag.rollRadians,
        model_id:this.modelId,model_hash:this.modelHash,gaze_x_raw:predicted.x,gaze_y_raw:predicted.y,
        gaze_x_smooth:this.smoothed?this.smoothed.x:null,gaze_y_smooth:this.smoothed?this.smoothed.y:null,
        gaze_x_kalman:filtered.x,gaze_y_kalman:filtered.y,kalman_timestamp:filtered.timestamp,
        kalman_reset:filtered.reset,kalman_reason:filtered.reason,kalman_variance_x:filtered.varianceX??null,kalman_variance_y:filtered.varianceY??null,
        offscreen:predicted.ok?(predicted.x<0||predicted.x>1||predicted.y<0||predicted.y>1):null,
        roi_raw:raw.roi,roi_smooth:sm.roi,roi_kalman:kf.roi,horizontal_band:raw.horizontal,vertical_band:raw.vertical,
        inference_trial_onset:meta.onset,current_trial_onset:this.trial?this.trial.onset:null,
        tracking_engine:this.engine,tracking_diagnostics:currentCamera?results.diagnostics||null:null,
        preparation_stability:null,calibration_stability:null,calibration_window_id:null};
      this.gaze.push(row);
      if(this.phase==='choice'&&this.trial&&this.trial.onset!==null) this.trial.samples.push(row);
      if(phaseMatch&&this.phase==='starting'&&this.awaitingFirstResultToken===this.token) {
        if(this.startupStageInfo)this.event('startup_stage_complete',{...this.startupStageInfo,elapsed_ms:now-this.startupStageInfo.startedAt});
        this.startupStageInfo=null;
        this.awaitingFirstResultToken=null;this.ready(this.model?'请重新验证':'准备校准');
      }
      if(phaseMatch&&this.phase==='ready') {
        this.status.textContent=`${this.pilot?'预实验 · ':''}${q.valid?(temporal.valid?'已检测到脸与睁眼，请保持位置稳定':'正在等待眨眼或追踪中断后恢复稳定'):q.faceDetected?'请睁眼并调整距离或光照':'请让整张脸进入前置摄像头'}`;
      }
      if(currentCamera&&phaseMatch&&this.phase==='preparation'&&this.preparation&&meta.start>=this.preparation.gateStart) {
        this.preparation.state=this.samplingGate.update({timestamp:meta.start,valid:Boolean(q.valid&&temporal.valid),features:f});
        this.preparation.lastSample=meta.start;
        row.preparation_stability=this.preparation.state;
      }
      if(currentCamera&&phaseMatch&&targetMatch&&this.phase==='calibration'&&target&&this.targetRecord) {
        this.calibrationSample(row,meta,f,Boolean(q.valid&&temporal.valid),!q.valid?q.reason:temporal.reason);
      }
      // Independent validation retains its original fixed window and raw quality rules.
      if(this.phase==='validation'&&target&&this.targetRecord&&currentCamera&&phaseMatch&&meta.start>=this.targetRecord.collectStart&&
          meta.target&&meta.target.targetId===target.targetId&&meta.target.presentationId===target.presentationId&&
          meta.target.roundIndex===target.roundIndex) {
        this.targetRecord.attempts.push({sampleId:row.sample_id,targetId:target.targetId,targetX:target.targetX,targetY:target.targetY,
          roundIndex:target.roundIndex||null,presentationId:target.presentationId,
          timestamp:now,features:f.slice(),valid:this.block.kind==='calibration'?Boolean(q.valid&&temporal.valid):valid,
          reason:this.block.kind==='calibration'?(!q.valid?q.reason:!temporal.valid?temporal.reason:null):reason,x:predicted.x,y:predicted.y,
          xSmooth:this.smoothed?.x??null,ySmooth:this.smoothed?.y??null,
          xKalman:filtered.x,yKalman:filtered.y,kalmanValid:filtered.valid,kalmanTimestamp:filtered.timestamp});
      }
    }
    ready(title) {
      this.enter('ready');this.target=null;this.block=null;this.aois=[];this.clear();
      this.status.textContent=this.pilot?'预实验模式 · 请保持手机与头部稳定':'请保持手机与头部稳定';
      this.showPanel(title,['请注视随后出现的圆点，不要点击圆点。先做中央圆点练习，再自动开始两轮九点校准；进度环填满后再看下一个点。可以自然眨眼，不稳定时会重新采样。',
        '独立验证检查 X、Y 和二维误差及覆盖率。初始门槛：两轴平均绝对误差各≤屏幕对应边长10%，二维平均归一化误差≤0.12，覆盖率≥80%；还检查P95与每个点。'],
        [[this.model?'开始独立验证':'准备好了，开始练习',()=>this.model?this.startBlock('validation'):this.prepareCalibration()],
         ...(this.model?[['重新完整校准',()=>this.prepareCalibration(),true]]:[]),['暂停',()=>this.pause('user_pause'),true]]);
    }
    drawTarget(target,progress=0,color='#176b61',label='') {
      this.clear();const x=target.targetX*this.width,y=target.targetY*this.height;
      this.ctx.beginPath();this.ctx.arc(x,y,17,0,2*Math.PI);this.ctx.fillStyle='#fff';this.ctx.fill();
      this.ctx.lineWidth=3;this.ctx.strokeStyle=color;this.ctx.stroke();
      this.ctx.beginPath();this.ctx.arc(x,y,23,-Math.PI/2,-Math.PI/2+Math.max(0,Math.min(1,progress))*2*Math.PI);
      this.ctx.lineWidth=4;this.ctx.strokeStyle=color;this.ctx.stroke();
      this.ctx.beginPath();this.ctx.arc(x,y,4,0,2*Math.PI);this.ctx.fillStyle='#172d29';this.ctx.fill();
      if(label){this.ctx.font='18px system-ui';this.ctx.textAlign='center';this.ctx.fillText(label,x,y-40);}
    }
    prepareCalibration() {
      if(!this.runningCamera||!['ready','calibration_report','validation_report','failure'].includes(this.phase))return;
      this.validationOK=false;this.validationId=null;this.model=null;this.modelId=null;this.modelHash=null;
      this.enter('preparation');this.block=null;this.target=null;this.targetRecord=null;this.aois=[];
      this.samplingGate=window.CalibrationStability.createGate(this.config.calibrationStability);
      this.collectionGate=null;
      this.preparation={onset:null,gateStart:Infinity,state:null,lastSample:null};
      this.status.textContent=`v${VERSION} · 注视中央圆点，倒计时后自动开始`;
      this.drawOnFrame(()=>this.drawTarget({targetX:.5,targetY:.5},0,'#176b61','3'),onset=>{
        this.preparation.onset=onset;this.preparation.gateStart=onset+this.config.preparationCountdownMs;
        this.event('preparation_onset',{countdown_ms:this.config.preparationCountdownMs,stability:this.config.calibrationStability},onset);
        this.later(100,()=>this.checkPreparation());
      });
    }
    checkPreparation() {
      const p=this.preparation,now=performance.now();if(this.phase!=='preparation'||!p)return;
      if(now-p.onset>=this.config.preparationTimeoutMs) {
        this.event('preparation_failed',{reason:'stability_timeout',elapsed_ms:now-p.onset,last_state:p.state});
        this.enter('failure');this.clear();
        this.showPanel('暂未获得稳定采样',['请让整张脸进入画面，保持手机、光照和观看距离稳定。准备阶段的诊断已保留。'],
          [['重新练习',()=>this.prepareCalibration()],['下载诊断备份',()=>this.download('backup'),true],['暂停',()=>this.pause('preparation_failed'),true]]);return;
      }
      if(now>=p.gateStart&&p.state?.stable&&now-p.lastSample<=this.config.calibrationStability.maxGapMs) {
        this.event('preparation_complete',{elapsed_ms:now-p.onset,stability:p.state});
        this.preparation=null;this.samplingGate.reset();this.enter('ready');this.startBlock('calibration');return;
      }
      const left=Math.max(0,Math.ceil((p.gateStart-now)/1000));
      this.drawTarget({targetX:.5,targetY:.5},left?0:Math.min(1,(p.state?.durationMs||0)/this.config.calibrationStability.windowMs),
        '#176b61',left?String(left):'继续注视');
      this.later(100,()=>this.checkPreparation());
    }
    calibrationSample(row,meta,features,valid,reason) {
      const record=this.targetRecord;
      if(!Number.isFinite(record.onset)||meta.start<record.settleEnd||meta.start>record.deadline)return;
      const state=this.samplingGate.update({timestamp:meta.start,valid,features});
      record.lastStability=state;record.lastSampleTimestamp=meta.start;
      row.calibration_stability=state;
      if(record.samplingStage==='settle')record.samplingStage='waiting';
      const attempt={sampleId:row.sample_id,targetId:record.targetId,targetX:record.targetX,targetY:record.targetY,
        roundIndex:record.roundIndex,presentationId:record.presentationId,timestamp:row.result_timestamp,
        inferenceTimestamp:meta.start,features:features.slice(),valid,reason:valid?null:reason,
        x:row.gaze_x_raw,y:row.gaze_y_raw,fitEligible:false,samplingStage:record.samplingStage,windowId:null};
      // Retain waiting, interrupted and successful attempts; never select by target error.
      record.attempts.push(attempt);
      if(record.samplingStage==='collect'&&meta.start>=record.collectStart) {
        attempt.windowId=record.activeWindow.id;
        if(!state.stable){this.interruptCalibrationWindow(state.reason,meta.start);}
        else {
          record.activeWindow.sampleIds.push(attempt.sampleId);
          record.activeWindow.lastSampleTimestamp=meta.start;
          const whole=this.collectionGate.update({timestamp:meta.start,valid,features});
          record.activeWindow.wholeWindowStability=whole;
          // Each complete collection must also be stable over its entire duration.
          if(whole.durationMs>=this.config.collectMs&&!whole.stable)this.interruptCalibrationWindow('whole_window_unstable',meta.start);
          else if(whole.stable) {
            row.target_stage=attempt.samplingStage;row.calibration_window_id=attempt.windowId;
            // Complete on the first qualifying frame, before the rolling gate can
            // discard any early collection samples while waiting for a UI timer.
            this.checkCalibrationTarget();return;
          }
        }
      }
      if(record.samplingStage==='waiting'&&state.stable&&record.lastStability?.stable) {
        record.samplingStage='pending_collect';
        this.drawOnFrame(()=>this.drawTarget(this.target,0,'#218d78'),onset=>{
          if(record!==this.targetRecord||record.samplingStage!=='pending_collect')return;
          if(!record.lastStability?.stable||onset-record.lastSampleTimestamp>this.config.calibrationStability.maxGapMs){record.samplingStage='waiting';return;}
          record.collectStart=onset;record.samplingStage='collect';
          const samplingWindow={id:`${record.presentationId}-w${record.samplingWindows.length+1}`,start:onset,end:null,status:'collecting',sampleIds:[]};
          record.samplingWindows.push(samplingWindow);record.activeWindow=samplingWindow;
          this.collectionGate=window.CalibrationStability.createGate({...this.config.calibrationStability,windowMs:this.config.collectMs});
          this.event('calibration_collection_start',{presentation_id:record.presentationId,window_id:samplingWindow.id,collect_start:onset});
        });
      } else if(record.samplingStage==='pending_collect'&&!state.stable)record.samplingStage='waiting';
      row.target_stage=attempt.samplingStage;row.calibration_window_id=attempt.windowId;
    }
    interruptCalibrationWindow(reason,timestamp) {
      const r=this.targetRecord,w=r.activeWindow;if(!w)return;
      w.end=timestamp;w.status='interrupted';w.reason=reason;r.activeWindow=null;r.collectStart=Infinity;r.samplingStage='waiting';r.lastStability=null;
      this.samplingGate.reset();if(this.collectionGate)this.collectionGate.reset();
      this.event('calibration_collection_interrupted',{presentation_id:r.presentationId,window_id:w.id,reason,sample_count:w.sampleIds.length},timestamp);
    }
    startBlock(kind) {
      if(!this.runningCamera||!['ready','calibration_report','validation_report','failure'].includes(this.phase))return;
      if(!['calibration','validation'].includes(kind)||kind==='validation'&&!this.model)return;
      this.validationOK=false;this.validationId=null;
      if(kind==='calibration') {this.model=null;this.modelId=null;this.modelHash=null;}
      this.block={id:kind==='calibration'?`calibration-${++this.calibrationSequence}`:`validation-${++this.validationSequence}`,
        kind,started:performance.now(),viewportId:this.viewportId,modelId:this.modelId,modelHash:this.modelHash,
        targets:[],status:'running',configuration:JSON.parse(JSON.stringify(this.config))};
      this.calibrations.push(this.block);
      this.blockTargets=kind==='calibration'?calibrationPlan(this.block.id):shuffled(VALIDATION_TARGETS)
        .map(target=>({...target,presentationId:`${this.block.id}-${target.targetId}`}));
      this.block.presentationPlan=this.blockTargets.map(target=>({...target}));
      if(kind==='calibration') {
        this.block.activePresentationIds=this.blockTargets.map(target=>target.presentationId);
        this.block.repairCycles=[];this.block.consistencyHistory=[];
      }
      this.targetIndex=0;this.nextTarget();
    }
    calibrationProgress() {
      const r=this.targetRecord,round=this.blockTargets.filter(t=>t.roundIndex===r.roundIndex);
      const index=round.findIndex(t=>t.presentationId===r.presentationId)+1;
      return `${r.repairCycle?`补采 ${r.repairCycle} · `:''}校准 第${r.roundIndex}/2轮 · ${index}/${round.length}`;
    }
    nextTarget() {
      if(this.targetIndex>=this.blockTargets.length){this.finishBlock();return;}
      const block=this.block,target=this.blockTargets[this.targetIndex];
      this.enter(block.kind,{block_id:block.id,target_id:target.targetId,round_index:target.roundIndex||null,
        presentation_id:target.presentationId});this.aois=[];this.target={...target};
      this.targetRecord={...target,attempts:[],onset:null,collectStart:Infinity,collectEnd:null,status:'running',
        samplingStage:'settle',settleEnd:Infinity,deadline:Infinity,samplingWindows:[],activeWindow:null};
      this.samplingGate=block.kind==='calibration'?window.CalibrationStability.createGate(this.config.calibrationStability):null;
      this.collectionGate=null;
      block.targets.push(this.targetRecord);
      this.status.textContent=`${this.pilot?'预实验 · ':''}${block.kind==='calibration'?this.calibrationProgress():`独立验证 ${this.targetIndex+1}/9`} · 注视圆点`;
      this.drawOnFrame(()=>this.drawTarget(target),onset=>{
        this.targetRecord.onset=onset;this.targetRecord.settleEnd=onset+this.config.settleMs;
        this.targetRecord.collectStart=block.kind==='validation'?this.targetRecord.settleEnd:Infinity;
        this.targetRecord.deadline=onset+(block.kind==='calibration'?this.config.calibrationPointTimeoutMs:this.config.pointTimeoutMs);
        const canvasRect=this.canvasRect();
        this.targetRecord.canvasRect=canvasRect;
        this.targetRecord.renderedTargetCss={x:canvasRect.left+target.targetX*canvasRect.width,y:canvasRect.top+target.targetY*canvasRect.height};
        this.event('target_onset',{...target,block_id:block.id,collect_start:block.kind==='validation'?this.targetRecord.collectStart:null,
          settle_end:this.targetRecord.settleEnd,deadline:this.targetRecord.deadline,
          canvas_rect:canvasRect,rendered_target_css:this.targetRecord.renderedTargetCss,onset_definition:this.config.onsetDefinition},onset);
        this.later(block.kind==='calibration'?100:this.config.settleMs+this.config.collectMs,()=>this.checkTarget());
      });
    }
    checkTarget() {
      if(this.block?.kind==='calibration'){this.checkCalibrationTarget();return;}
      const record=this.targetRecord,now=performance.now();
      const validCount=record.attempts.filter(a=>a.valid).length;
      if(validCount>=this.config.minValidFramesPerPoint) {
        record.collectEnd=now;record.status='complete';this.event('target_end',{target_id:record.targetId,
          round_index:record.roundIndex||null,presentation_id:record.presentationId,attempts:record.attempts.length,valid_count:validCount});
        this.targetIndex++;this.nextTarget();
      } else if(now-record.onset>=this.config.pointTimeoutMs) {
        record.collectEnd=now;record.status='failed';this.block.status='failed';this.block.ended=now;
        this.block.failure='insufficient_valid_frames';this.target=null;
        this.validationOK=false;
        this.enter('failure');this.showPanel('此点采集不足',[
          `${record.targetId} 在 ${(this.config.pointTimeoutMs/1000).toFixed(0)} 秒内只有 ${validCount} 个有效结果。请检查光照、距离、眼镜反光与是否完整露脸。`,
          '请保持手机位置稳定后重试。当前诊断数据已保留。'
        ],[['重新完整校准',()=>this.prepareCalibration()],['下载完整诊断备份',()=>this.download('backup'),true],['暂停',()=>this.pause('calibration_failed'),true]]);
      } else {this.status.textContent='有效结果不足，继续注视圆点…';this.later(200,()=>this.checkTarget());}
    }
    checkCalibrationTarget() {
      const r=this.targetRecord,now=performance.now();if(this.phase!=='calibration'||!r)return;
      let w=r.activeWindow;
      if(w&&now-(w.lastSampleTimestamp??w.start)>this.config.calibrationStability.maxGapMs) {
        this.interruptCalibrationWindow('sample_gap',now);w=null;
      }
      if(w&&w.wholeWindowStability?.stable&&w.sampleIds.length>=this.config.minValidFramesPerPoint&&now<=r.deadline) {
        w.end=now;w.status='complete';r.collectEnd=now;r.status='complete';r.acceptedWindowId=w.id;
        const selected=new Set(w.sampleIds);
        for(const attempt of r.attempts)attempt.fitEligible=attempt.valid&&selected.has(attempt.sampleId);
        r.samplingSummary={durationMs:now-r.onset,attempts:r.attempts.length,fitEligible:r.attempts.filter(a=>a.fitEligible).length,
          interruptedWindows:r.samplingWindows.filter(s=>s.status==='interrupted').length,stability:w.wholeWindowStability};
        this.event('target_end',{target_id:r.targetId,round_index:r.roundIndex,presentation_id:r.presentationId,
          attempts:r.attempts.length,valid_count:r.samplingSummary.fitEligible,sampling_summary:r.samplingSummary});
        r.activeWindow=null;this.targetIndex++;this.nextTarget();return;
      }
      if(now>=r.deadline) {
        if(w)this.interruptCalibrationWindow('point_deadline',now);
        r.collectEnd=now;r.status='failed';this.block.status='failed';this.block.ended=now;this.block.failure='stable_collection_timeout';
        const repair=this.block.repairCycles?.at(-1);
        if(repair?.status==='running'){repair.status='failed';repair.ended=now;repair.reason='stable_collection_timeout';}
        this.event('calibration_point_failed',{target_id:r.targetId,presentation_id:r.presentationId,
          attempts:r.attempts.length,windows:r.samplingWindows.length,last_stability:r.lastStability});
        this.target=null;this.validationOK=false;this.enter('failure');this.clear();
        this.showPanel('此点未获得连续稳定采样',[
          `${r.targetId} 在 ${this.config.calibrationPointTimeoutMs/1000} 秒内未完成采样。请检查光照、眼镜反光和面部是否完整进入画面。`,
          '等待、异常和重采记录均已保留。请保存备份后重新练习和校准。'
        ],[['重新练习并完整校准',()=>this.prepareCalibration()],['下载诊断备份',()=>this.download('backup'),true],['暂停',()=>this.pause('calibration_failed'),true]]);return;
      }
      const progress=w?Math.min(1,(w.wholeWindowStability?.durationMs||0)/this.config.collectMs):0;
      const color=w?'#218d78':'#176b61';this.drawTarget(this.target,progress,color);
      this.status.textContent=`v${VERSION} · ${this.calibrationProgress()} · ${w?'保持注视，正在采样':'继续注视，等待稳定'}`;
      this.later(Math.min(100,r.deadline-now),()=>this.checkTarget());
    }
    repairCalibration(block) {
      if(this.phase!=='calibration_report'||this.block!==block||!this.runningCamera||block.viewportId!==this.viewportId||
        block.status!=='needs_recollection'||block.repairCycles.length>=this.config.maxCalibrationRepairCycles)return;
      const ids=block.consistency.failedTargetIds;
      if(block.consistency.reason!=='calibration_consistency_failed'||!ids.length)return;
      const cycle=block.repairCycles.length+1;
      const replacements=calibrationPlan(`${block.id}-repair${cycle}`).filter(t=>ids.includes(t.targetId))
        .map(t=>({...t,repairCycle:cycle}));
      const oldIds=block.activePresentationIds.filter(id=>block.targets.some(t=>t.presentationId===id&&ids.includes(t.targetId)));
      // Replace BOTH members of every failed pair. Never choose the closest two
      // observations among old and new presentations, or select by validation error.
      for(const record of block.targets)if(oldIds.includes(record.presentationId)) {
        record.superseded=true;
        record.supersededBy=replacements.find(t=>t.targetId===record.targetId&&t.roundIndex===record.roundIndex).presentationId;
      }
      block.activePresentationIds=block.activePresentationIds.filter(id=>!oldIds.includes(id)).concat(replacements.map(t=>t.presentationId));
      block.repairCycles.push({cycle,started:performance.now(),ended:null,status:'running',targetIds:ids.slice(),
        originalPresentationIds:oldIds,replacementPresentationIds:replacements.map(t=>t.presentationId)});
      block.presentationPlan.push(...replacements.map(t=>({...t})));
      block.status='running';block.ended=null;this.model=null;this.modelId=null;this.modelHash=null;this.validationOK=false;
      this.blockTargets=replacements;this.targetIndex=0;
      this.event('calibration_pair_recollection_started',{block_id:block.id,cycle,target_ids:ids.slice(),
        original_presentation_ids:oldIds,replacement_presentation_ids:replacements.map(t=>t.presentationId)});
      this.nextTarget();
    }
    showConsistencyReport(block,check) {
      const retry=check.reason==='calibration_consistency_failed'&&check.failedTargetIds.length>0&&
        block.repairCycles.length<this.config.maxCalibrationRepairCycles;
      block.status=retry?'needs_recollection':'failed';block.failure=check.reason;
      this.model=null;this.modelId=null;this.modelHash=null;
      this.enter('calibration_report');this.clear();this.aois=[];
      this.status.textContent=`v${VERSION} · 两轮校准不一致 · ${check.failedTargetIds.length}/9 个位置需检查`;
      this.showPanel('两轮校准需要检查',[
        '同一个位置在两轮中得到的眼部特征或映射位置差异过大，暂不启用这个模型。请保持观看距离，检查光照、眼镜反光，并持续注视圆点中心。',
        '检查标准：单个眼部特征的两轮差异不超过本次特征跨度的25%；映射后的X/Y差异分别不超过屏宽/屏高的15%。这是校准重复性检查，通过后仍须独立验证。',
        retry?`将对 ${check.failedTargetIds.length} 个位置各重新采两次。旧记录全部保留；本轮最多补采一次。`:
          '本轮无法继续补采。请保存诊断，调整条件后重新完整校准。'
      ],[...(retry?[[`补采这 ${check.failedTargetIds.length} 个位置（各2次）`,()=>this.repairCalibration(block)]]:[]),
        ['下载诊断备份',()=>this.download('backup'),true],['重新完整校准',()=>this.prepareCalibration(),true],['暂停',()=>this.pause('consistency_failed'),true]]);
      const pct=n=>Number.isFinite(n)?`${(n*100).toFixed(1)}%`:'无法计算';
      const labels=['左上','中上','右上','左中','中心','右中','左下','中下','右下'];
      this.appendPointReport(check.pointSummaries.map(p=>({label:`${labels[CALIBRATION_TARGETS.findIndex(t=>t.targetId===p.targetId)]||'校准点'}（${p.targetId}）`,
        passed:p.passed,summary:p.passed?'两轮一致性通过，尚未独立验证。':'两轮差异超出检查标准，当前模型未启用。',
        details:[`两轮映射位置差：X ${pct(Math.abs(p.mappedDelta?.x))} 屏宽；Y ${pct(Math.abs(p.mappedDelta?.y))} 屏高。`,
          `四个眼部特征中，最大相对差异：${pct(Math.max(...(p.normalizedFeatureDelta||[]).map(Math.abs)))}。`] })),
        '查看各位置的两轮差异');
    }
    finishBlock() {
      const block=this.block;block.ended=performance.now();this.target=null;this.targetRecord=null;
      const all=block.targets.flatMap(t=>t.attempts);
      if(block.kind==='calibration') {
        const selected=new Set(block.activePresentationIds);
        const active=block.targets.filter(t=>selected.has(t.presentationId));
        const fitting=active.flatMap(t=>t.attempts).filter(a=>a.fitEligible);
        block.samplingSummary={attempts:all.length,fitEligible:fitting.length,
          allStableFrames:all.filter(a=>a.fitEligible).length,activePresentationCount:active.length,
          interruptedWindows:block.targets.reduce((sum,t)=>sum+t.samplingWindows.filter(w=>w.status==='interrupted').length,0),
          durationMs:block.ended-block.started,stabilityCriteria:this.config.calibrationStability};
        const repair=block.repairCycles.at(-1);if(repair?.status==='running'){repair.status='complete';repair.ended=block.ended;}
        const fit=GazeCore.createRepeatedCalibration(fitting,{expectedTargets:CALIBRATION_TARGETS,
          minSamplesPerPresentation:this.config.minValidFramesPerPoint,aggregation:this.config.calibrationAggregation});
        block.fit=fit;block.status=fit.ok?'complete':'failed';
        const report=window.CalibrationReport.summarizeCalibration(fit);
        if(!fit.ok) {
          this.enter('failure');this.clear();this.status.textContent=`v${VERSION} · 校准暂未生成模型 · 请查看报告`;
          this.showPanel(report.headline,report.lines,
            [['重新完整校准',()=>this.prepareCalibration()],['下载诊断备份',()=>this.download('backup'),true],['暂停',()=>this.pause('fit_failed'),true]]);
          this.appendPointReport(report.points,'查看逐点校准诊断');return;
        }
        const check=window.CalibrationConsistency.evaluate(fit,active,{...this.config.calibrationConsistency,expectedTargets:CALIBRATION_TARGETS});
        block.consistency=check;
        block.consistencyHistory.push({attemptIndex:block.repairCycles.length,completedAt:block.ended,
          activePresentationIds:block.activePresentationIds.slice(),fit,evaluation:check});
        this.event('calibration_consistency_result',{block_id:block.id,passed:check.passed,failed_target_ids:check.failedTargetIds,
          reason:check.reason,repair_cycle:block.repairCycles.length});
        if(!check.passed){this.showConsistencyReport(block,check);return;}
        block.failure=null;
        this.model=fit.model;this.modelId=block.id;this.modelHash=hashModel(fit.model);block.modelHash=this.modelHash;
        this.event('model_created',{model_id:this.modelId,model_hash:this.modelHash,
          calibration_protocol:this.config.calibrationProtocol,selected_candidate_id:fit.diagnostics.selectedCandidateId,
          selection_rule:fit.diagnostics.selectionRule});
        this.enter('calibration_report');this.clear();this.aois=[];
        this.status.textContent=`v${VERSION} · 两轮一致性已通过 · 尚未独立验证`;
        this.showPanel(report.headline,['九个位置的两轮一致性均通过。还需独立验证确认定位误差。',...report.lines,
          `采样共 ${(block.samplingSummary.durationMs/1000).toFixed(1)} 秒；拟合使用 ${block.samplingSummary.fitEligible}/${block.samplingSummary.attempts} 条采样尝试；中断重采 ${block.samplingSummary.interruptedWindows} 次。稳定不代表注视位置正确，请继续独立验证。`],[['开始独立验证',()=>this.startBlock('validation')],
          ['查看并保存诊断备份',()=>this.download('backup'),true],['重新完整校准',()=>this.prepareCalibration(),true],
          ['暂停',()=>this.pause('calibration_report_pause'),true]]);
        this.appendPointReport(report.points,'查看9个位置的拟合、波动与两轮差异');
      } else {
        const evaluation=GazeCore.evaluateValidation(all,{...this.config.validation,expectedTargets:VALIDATION_TARGETS});
        block.evaluation=evaluation;block.status=evaluation.passed?'passed':'failed';
        const filterEvaluation=(x,y,extraValid=()=>true)=>GazeCore.evaluateValidation(all.map(a=>({...a,x:a[x],y:a[y],
          valid:a.valid&&extraValid(a)&&Number.isFinite(a[x])&&Number.isFinite(a[y])})),{...this.config.validation,expectedTargets:VALIDATION_TARGETS});
        block.filterComparison={definition:'Identical logged attempts, fixed parameters. Raw output alone determines admission. No target-informed filtering.',
          settings:{emaTauMs:this.config.smoothTauMs,kalman:this.config.kalman},
          raw:evaluation,ema:filterEvaluation('xSmooth','ySmooth'),kalman:filterEvaluation('xKalman','yKalman',a=>a.kalmanValid===true)};
        this.validationOK=evaluation.passed;this.validationId=block.id;
        this.event('validation_result',{validation_id:block.id,passed:evaluation.passed,failures:evaluation.failures});
        this.enter('validation_report');this.clear();
        const report=window.ValidationReport.summarizeValidation(evaluation);
        this.status.textContent=`v${VERSION} · 独立验证${evaluation.passed?'通过':'未通过'} · 请查看报告`;
        this.showPanel(report.headline,report.lines,
          [...(evaluation.passed?[['继续任务',()=>this.continueAfterValidation()]]:[]),
            ['重新完整校准',()=>this.prepareCalibration(),true],
            ['下载诊断备份',()=>this.download('backup'),true],['暂停',()=>this.pause('validation_pause'),true]]);
        this.appendPointReport(report.points,`查看各点结果与原因（${report.points.filter(p=>!p.passed).length} 个点未通过）`);
        this.appendFilterReport(block.filterComparison);
      }
    }
    appendFilterReport(comparison) {
      const details=document.createElement('details');details.className='validation-points';
      const heading=document.createElement('summary');heading.textContent='查看滤波对照（不用于通过判定）';details.append(heading);
      const pct=n=>Number.isFinite(n)?`${(n*100).toFixed(1)}%`:'未记录';
      for(const [key,label] of [['raw','原始映射'],['ema','指数平滑'],['kalman','卡尔曼滤波']]) {
        const e=comparison[key],p=document.createElement('p');
        p.textContent=`${label}：X/Y平均误差 ${pct(e.meanAbsErrorX)} 屏宽 / ${pct(e.meanAbsErrorY)} 屏高；X/Y点内标准差均值 ${pct(e.sdX)} / ${pct(e.sdY)}；有效 ${e.validCount}/${e.attemptCount}。`;
        details.append(p);
      }
      const note=document.createElement('p');note.textContent='平滑可能降低波动，也可能延迟位置变化。仅原始映射用于独立验证门槛和正式停留时间；缺失帧不会由预测补为有效记录。';details.append(note);
      this.panel.insertBefore(details,Array.from(this.panel.children).find(el=>el.tagName==='BUTTON'));
    }
    appendPointReport(points,title) {
        if(!points.length)return;
        const details=document.createElement('details');details.className='validation-points';
        const summary=document.createElement('summary');summary.textContent=title;details.append(summary);
        for(const point of points) {
          const card=document.createElement('article');card.className=point.passed===true?'point-pass':point.passed===false?'point-fail':'point-diagnostic';
          const heading=document.createElement('h2');heading.textContent=point.label;card.append(heading);
          const overview=document.createElement('p');overview.textContent=point.summary;card.append(overview);
          let destination=card;
          if(point.passed===undefined) {
            destination=document.createElement('details');destination.className='point-metrics';
            const toggle=document.createElement('summary');toggle.textContent='展开此位置的两轮诊断';destination.append(toggle);card.append(destination);
          }
          for(const line of point.details){const p=document.createElement('p');p.textContent=line;destination.append(p);}
          details.append(card);
        }
        this.panel.insertBefore(details,Array.from(this.panel.children).find(el=>el.tagName==='BUTTON'));
    }
    continueAfterValidation() {
      if(this.phase!=='validation_report'||!this.validationOK)return;
      this.block=null;this.target=null;
      if(this.resumeAction==='choice')this.startChoice();else this.startRating();
    }
    fixation(next) {
      this.enter('fixation');this.aois=[];
      this.drawOnFrame(()=>this.text(['+']),onset=>{
        this.event('fixation_onset',{},onset);
        this.later(this.config.fixationMinMs+Math.random()*(this.config.fixationMaxMs-this.config.fixationMinMs),next);
      });
    }
    startRating() {
      if(!this.validationOK){this.ready('请先完成独立验证');return;}
      this.resumeAction='rating';
      if(this.ratingIndex>=this.ratingIds.length) {
        this.trials=generateCombinations(this.ratings,this.trialCount);
        if(!this.trials.length){this.finish('所有图片评分相同，不能生成不同价值的配对。已保留评分与眼动数据。');return;}
        this.event('choice_plan_created',{sampling:'uniform ordered unequal rating pairs; image uniform within rating; sampling with replacement',trials:this.trials});
        this.resumeAction='choice';this.validationOK=false;this.ready('评分完成，请重新验证');return;
      }
      this.fixation(()=>{
        this.enter('rating');this.rating={id:`rating-${this.ratingIndex+1}`,onset:null,image:this.ratingIds[this.ratingIndex],phaseId:this.phaseId};
        this.status.textContent=`${this.pilot?'预实验 · ':''}图片评分 ${this.ratingIndex+1}/${this.ratingCount}`;
        this.drawOnFrame(()=>{
          this.clear();const size=Math.min(this.width*.7,this.height*.42);
          this.drawImage(this.rating.image,{x:(this.width-size)/2,y:this.height*.37-size/2,width:size,height:size});
          this.ctx.fillStyle='#263b37';this.ctx.font='16px system-ui';this.ctx.textAlign='center';
          this.ctx.fillText('喜欢程度：1 最不喜欢 · 10 最喜欢',this.width/2,this.height*.65);
          this.ratingControls.hidden=false;
        },onset=>{this.rating.onset=onset;this.event('rating_onset',{rating_id:this.rating.id,image_id:this.rating.image},onset);});
      });
    }
    rate(value,timestamp,inputType) {
      if(this.phase!=='rating'||!this.rating||this.rating.onset===null)return;
      const current=this.rating;const phaseId=this.phaseId;
      this.enter('rating_feedback'); // Synchronous admission lock precedes logs and scheduling.
      this.ratings.push({schema_version:SCHEMA,run_id:this.runId,rating_id:current.id,rating_index:this.ratingIndex+1,
        image_id:current.image,rating:value,onset_timestamp:current.onset,response_timestamp:timestamp,rt_ms:timestamp-current.onset,
        input_type:inputType,phase_id:phaseId,model_id:this.modelId,validation_id:this.validationId,viewport_id:this.viewportId});
      this.event('rating_response',{rating_id:current.id,value,original_phase_id:phaseId},timestamp);
      this.rating=null;this.ratingIndex++;this.text([`已评分 ${value}`]);this.later(250,()=>this.startRating());
    }
    drawImage(id,rect) {
      const image=this.images.get(id);
      this.ctx.drawImage(image,rect.x,rect.y,rect.width,rect.height);
      this.ctx.strokeStyle='#d9dfd9';this.ctx.lineWidth=1;this.ctx.strokeRect(rect.x,rect.y,rect.width,rect.height);
    }
    choiceRectangles() {
      if(this.layout==='horizontal') {
        const s=Math.min(this.width*.42,this.height*.42),y=this.height*.47-s/2;
        return [{x:this.width*.26-s/2,y,width:s,height:s},{x:this.width*.74-s/2,y,width:s,height:s}];
      }
      const s=Math.min(this.width*.65,this.height*.29),x=(this.width-s)/2;
      return [{x,y:this.height*.30-s/2,width:s,height:s},{x,y:this.height*.69-s/2,width:s,height:s}];
    }
    startChoice() {
      if(!this.validationOK){this.ready('请先完成独立验证');return;}
      this.resumeAction='choice';
      if(this.trialIndex>=this.trials.length){this.finish('所有试次已完成。');return;}
      this.fixation(()=>{
        this.enter('choice');
        const attempt=(this.trialAttempts[this.trialIndex]||0)+1;this.trialAttempts[this.trialIndex]=attempt;
        this.trial={id:`choice-${this.trialIndex+1}-attempt-${attempt}`,index:this.trialIndex,attempt,onset:null,
          phaseId:this.phaseId,samples:[],modelId:this.modelId,modelHash:this.modelHash,validationId:this.validationId,
          viewportId:this.viewportId,plan:this.trials[this.trialIndex],aois:this.choiceRectangles()};
        this.aois=this.trial.aois;
        this.status.textContent=`${this.pilot?'预实验 · ':''}选择 ${this.trialIndex+1}/${this.trialCount} · 点击更喜欢的图片`;
        this.drawOnFrame(()=>{this.clear();this.aois.forEach((a,i)=>this.drawImage(this.trial.plan.images[i],a));},onset=>{
          this.trial.onset=onset;this.event('stimulus_onset',{trial_id:this.trial.id,aois:this.aois,images:this.trial.plan.images,onset_definition:this.config.onsetDefinition},onset);
        });
      });
    }
    trialRow(trial,timestamp) {
      return {schema_version:SCHEMA,run_id:this.runId,trial_id:trial.id,trial_index:trial.index+1,attempt:trial.attempt,phase_id:trial.phaseId,
        layout:this.layout,image_1:trial.plan.images[0],image_2:trial.plan.images[1],rating_1:trial.plan.rating_1,rating_2:trial.plan.rating_2,
        position_1:this.layout==='horizontal'?'left':'top',position_2:this.layout==='horizontal'?'right':'bottom',
        onset_timestamp:trial.onset,response_timestamp:timestamp,rt_ms:trial.onset===null?null:timestamp-trial.onset,
        ...(trial.onset===null?{}:dwell(trial.samples,trial.onset,timestamp,this.config.maxDwellGapMs)),
        aoi_1:trial.aois[0],aoi_2:trial.aois[1],model_id:trial.modelId,model_hash:trial.modelHash,
        validation_id:trial.validationId,viewport_id:trial.viewportId};
    }
    respond(choice,timestamp,inputType) {
      if(this.phase!=='choice'||!this.trial||this.trial.onset===null)return;
      const current=this.trial;this.enter('choice_feedback');
      this.behavior.push({...this.trialRow(current,timestamp),choice,chosen_image:current.plan.images[choice-1],status:'complete',input_type:inputType});
      this.event('choice_response',{trial_id:current.id,choice,original_phase_id:current.phaseId},timestamp);
      this.trial=null;this.aois=[];this.trialIndex++;this.text(['已记录']);
      this.later(250,()=>{
        if(this.trialIndex>=this.trials.length)this.finish('所有试次已完成。');
        else if(this.trialIndex%this.config.validationEveryTrials===0){this.validationOK=false;this.ready(`已完成 ${this.trialIndex} 次，请重新验证`);}
        else this.startChoice();
      });
    }
    pause(reason) {
      if(['welcome','paused','finished'].includes(this.phase))return;
      const now=performance.now();
      if(this.trial) {
        this.behavior.push({...this.trialRow(this.trial,now),status:'aborted',abort_reason:reason,choice:null});
        this.event('trial_aborted',{reason,trial_id:this.trial.id},now);this.trial=null;
      }
      if(this.rating){this.event('rating_aborted',{rating_id:this.rating.id,image_id:this.rating.image,reason},now);this.rating=null;}
      if(this.block&&this.block.status==='running'){this.block.status='aborted';this.block.ended=now;this.block.failure=reason;}
      const repair=this.block?.repairCycles?.at(-1);if(repair?.status==='running'){repair.status='aborted';repair.ended=now;repair.reason=reason;}
      if(this.targetRecord?.activeWindow)this.interruptCalibrationWindow(reason,now);
      if(this.targetRecord?.status==='running'){this.targetRecord.status='aborted';this.targetRecord.collectEnd=now;}
      if(this.preparation){this.event('preparation_aborted',{reason,last_state:this.preparation.state});this.preparation=null;}
      if(this.samplingGate)this.samplingGate.reset();if(this.collectionGate)this.collectionGate.reset();
      this.target=null;this.targetRecord=null;this.block=null;this.aois=[];this.validationOK=false;
      this.event('pause',{reason});this.enter('paused');this.stopCamera();this.clear();
      this.showPanel('实验已暂停',[`原因：${({page_hidden:'页面曾离开前台',resize:'窗口尺寸改变',visual_viewport_resize:'可视区域改变',user_pause:'主动暂停'})[reason]||reason}。`,
        '继续时会重新开启摄像头，并重新校准或独立验证。当前未完成试次会标为中止，之后从该题重新开始。请保持手机固定。'],
        [['继续并重新验证',()=>this.start()],['下载完整备份',()=>this.download('backup'),true]]);
    }
    fail(code,message) {
      this.event('failure',{code,message,startup_stage:this.startupStageInfo?.name,stage_elapsed_ms:this.startupStageInfo?performance.now()-this.startupStageInfo.startedAt:null});this.stopCamera();this.validationOK=false;this.enter('failure');
      this.showPanel('暂时无法继续',[message,'已有数据保留在本页，可先下载诊断备份。'],
        [['重新启动摄像头',()=>this.start()],['下载完整备份',()=>this.download('backup'),true]]);
    }
    viewportChanged(reason) {
      const visual=window.visualViewport;
      const signature=[innerWidth,innerHeight,devicePixelRatio,visual?visual.width:null,visual?visual.height:null,visual?visual.scale:null].join('|');
      if(signature===this.viewportSignature)return;
      const priorPhase=this.phase;
      if(this.runningCamera)this.pause(reason);
      this.resizeCanvas(reason);this.event('viewport_changed',{viewport_id:this.viewportId,reason,prior_phase:priorPhase});
    }
    resizeCanvas(reason) {
      this.width=innerWidth;this.height=innerHeight;
      const dpr=window.devicePixelRatio||1,v=window.visualViewport;
      this.viewportSignature=[innerWidth,innerHeight,dpr,v?v.width:null,v?v.height:null,v?v.scale:null].join('|');
      this.canvas.width=Math.round(this.width*dpr);this.canvas.height=Math.round(this.height*dpr);
      // Use the exact same CSS pixel dimensions for targets, AOIs and rendering.
      // 100vh can differ from the browser's current innerHeight on mobile.
      this.canvas.style.width=this.width+'px';this.canvas.style.height=this.height+'px';
      this.ctx.setTransform(dpr,0,0,dpr,0,0);this.viewportId++;
      this.viewports.push({id:this.viewportId,timestamp:performance.now(),reason,width:this.width,height:this.height,dpr,
        canvasRect:this.canvasRect(),visualWidth:v?v.width:null,visualHeight:v?v.height:null,
        visualOffsetLeft:v?v.offsetLeft:null,visualOffsetTop:v?v.offsetTop:null,
        visualScale:v?v.scale:null,orientation:screen.orientation?screen.orientation.type:null});
      this.clear();
    }
    canvasRect() {
      const r=this.canvas.getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height};
    }
    finish(message) {
      this.enter('finished');this.trial=null;this.target=null;this.block=null;this.aois=[];this.stopCamera();
      this.event('session_finished',{message});this.status.textContent=this.pilot?'预实验已结束':'实验已结束';this.clear();
      this.showPanel('请保存实验数据',[message,`已记录评分 ${this.ratings.length} 条、完成选择 ${this.behavior.filter(r=>r.status==='complete').length} 条、摄像头结果 ${this.gaze.length} 条。`,
        '先下载完整 JSON 备份；也可分别下载 CSV 和校准信息。没有任何数据自动发送到服务器。新版 schemaVersion=2，旧分析脚本需适配。'],
        [['下载完整 JSON 备份',()=>this.download('backup')],['下载 gaze.csv',()=>this.download('gaze'),true],
          ['下载 behavior.csv',()=>this.download('behavior'),true],['下载 rating.csv',()=>this.download('rating'),true],
          ['下载 events.csv',()=>this.download('events'),true],['下载 calibration.json',()=>this.download('calibration'),true],
          ['下载 session.json',()=>this.download('session'),true],['分享完整备份（可选）',()=>this.download('backup',true),true]]);
    }
    session() {
      return {schemaVersion:SCHEMA,runId:this.runId,appVersion:VERSION,coreVersion:window.GazeCore?GazeCore.version:null,
        trackingEngine:this.engine,trackingIdentity:this.trackingIdentity||null,
        diagnosticsUse:'Face blendshapes and face transformation matrices are logged only; they do not alter gaze predictions or validity.',
        filterUse:'EMA and Kalman are parallel diagnostic outputs. Raw predictions alone determine validation and dwell. Kalman variance is internal state uncertainty, not measured accuracy.',
        participantId:this.participantId,pilot:this.pilot,layout:this.layout,layoutVersion:this.config.layoutVersion,ratingCount:this.ratingCount,trialCount:this.trialCount,
        startedAtUTC:new Date(this.startedAt).toISOString(),performanceTimeOrigin:performance.timeOrigin,
        exportedAtUTC:new Date().toISOString(),phase:this.phase,config:this.config,
        userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,
        qualityThresholds:window.GazeCore?GazeCore.qualityThresholds:null,
        viewportHistory:this.viewports,cameraSettings:this.cameraSettings,modelId:this.modelId,modelHash:this.modelHash,
        validationId:this.validationId,validationOK:this.validationOK,ratingOrder:this.ratingIds,trialPlan:this.trials,
        counts:{gaze:this.gaze.length,ratings:this.ratings.length,behavior:this.behavior.length,events:this.events.length},
        privacy:'Frames processed locally; no stored images/video and no automatic uploads.',
        warnings:['Callback logging rate is not independently measured camera FPS.','iris_ratio is iris width / eye width, not pupil dilation.',
          'Model checksum is noncryptographic; complete exact model retained.','Actual spatial accuracy must be measured per session on held-out targets.']};
    }
    async download(kind,share=false) {
      this.event('export_requested',{kind,share});
      let content,mime,extension;
      const rows={gaze:this.gaze,behavior:this.behavior,rating:this.ratings,events:this.events};
      const headers={gaze:GAZE_HEADERS,behavior:BEHAVIOR_HEADERS,rating:RATING_HEADERS,events:EVENT_HEADERS};
      if(rows[kind]){content=csv(rows[kind],headers[kind]);mime='text/csv;charset=utf-8';extension='csv';}
      else {
        const session=this.session(),calibration={schemaVersion:SCHEMA,runId:this.runId,blocks:this.calibrations,
          currentModel:this.model,currentModelId:this.modelId,currentModelHash:this.modelHash,calibrationTargets:CALIBRATION_TARGETS,validationTargets:VALIDATION_TARGETS};
        content=JSON.stringify(kind==='session'?session:kind==='calibration'?calibration:
          {schemaVersion:SCHEMA,runId:this.runId,session,calibration,gaze:this.gaze,behavior:this.behavior,rating:this.ratings,events:this.events});
        mime='application/json';extension='json';
      }
      const filename=`${this.runId}_${kind}.${extension}`,blob=new Blob([content],{type:mime});
      if(share&&navigator.share&&typeof File!=='undefined') {
        const file=new File([blob],filename,{type:mime});
        if(navigator.canShare&&navigator.canShare({files:[file]})) {
          try{await navigator.share({files:[file],title:'手机眼动实验备份'});return;}
          catch(error){if(error.name==='AbortError')return;this.event('share_failed',{message:error.message});}
        }
      }
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.textContent=`保存 ${filename}`;
      document.body.append(a);a.click();a.remove();
      // Keep the object URL until the next explicit download, so iOS can finish opening its save sheet.
      if(this.lastExportUrl)URL.revokeObjectURL(this.lastExportUrl);this.lastExportUrl=url;
      document.getElementById('save-notice').textContent='已请求保存。请确认文件出现在“下载”或“文件”中；也可使用完成页的分享按钮。';
    }
  }
  return {VERSION,SCHEMA,CONFIG,CALIBRATION_TARGETS,VALIDATION_TARGETS,GAZE_HEADERS,BEHAVIOR_HEADERS,RATING_HEADERS,EVENT_HEADERS,
    csv,shuffled,calibrationPlan,generateCombinations,classify,dwell,smooth,hashModel,Experiment};
});
