(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ImagePilot = api; root.ImagePilotApp = api.createApp(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  function generateTargetGrid(measurement) {
    const {width,height,header,footer,canvas,visual} = measurement;
    if(![width,height].every(n=>finite(n)&&n>0))throw Error('invalid_viewport');
    const box=(value,fallback)=>value||fallback;
    const v=box(visual,{left:0,top:0,right:width,bottom:height});
    const c=box(canvas,{left:0,top:0,right:width,bottom:height});
    for(const r of [v,c,header,footer].filter(Boolean))if(!['left','top','right','bottom'].every(k=>finite(r[k]))||r.right<r.left||r.bottom<r.top)throw Error('invalid_viewport_measurement');
    // The outer ring reaches 18.5px from the center; an extra 8.5px
    // clearance keeps it outside fixed controls and Safari's visible edges.
    const clearance=27;
    const left=Math.max(0,v.left,c.left),right=Math.min(width,v.right,c.right);
    const top=Math.max(0,v.top,c.top,header?header.bottom:0),bottom=Math.min(height,v.bottom,c.bottom,footer?footer.top:height);
    const x0=Math.max(.08,(left+clearance)/width),x1=Math.min(.92,(right-clearance)/width);
    const y0=Math.max(.08,(top+clearance)/height),y1=Math.min(.92,(bottom-clearance)/height);
    if(x1-x0<.5+1e-7||y1-y0<.5+1e-7)throw Error('insufficient_visible_target_span');
    const map=(u,v)=>({targetX:x0+u*(x1-x0),targetY:y0+v*(y1-y0)});
    const calibration=[0,.5,1].flatMap((v,r)=>[0,.5,1].map((u,c)=>({targetId:'c'+(r*3+c+1),...map(u,v)})));
    const validation=[[.1,.1],[.5,.12],[.9,.1],[.12,.5],[.52,.52],[.88,.5],[.1,.9],[.5,.88],[.9,.9]]
      .map(([u,v],i)=>({targetId:'v'+(i+1),...map(u,v)}));
    return {calibration,validation,measurement:JSON.parse(JSON.stringify(measurement)),
      region:{left,top,right,bottom,clearance,xMin:x0,xMax:x1,yMin:y0,yMax:y1},
      constraints:{calibrationMinSpan:.5,validationMinSpan:.4,
        calibrationSpanX:x1-x0,calibrationSpanY:y1-y0,validationSpanX:.8*(x1-x0),validationSpanY:.8*(y1-y0)},
      definition:'Target centers are normalized to the full layout viewport; fixed-control and visual-viewport bounds only constrain placement. Validation locations are distinct from every calibration location. No accuracy threshold is changed.'};
  }
  function collectionDecision(p,capturedAt,completedAt,unchanged=true) {
    if(!p||![p.collectStart,p.collectEnd,capturedAt,completedAt].every(finite))return {attempt:false,accepted:false,reason:'outside_collection_window'};
    if(capturedAt<p.collectStart||capturedAt>=p.collectEnd)return {attempt:false,accepted:false,reason:'outside_collection_window'};
    if(completedAt<capturedAt)return {attempt:true,accepted:false,reason:'nonmonotonic_pipeline_timestamp'};
    if(completedAt>p.collectEnd)return {attempt:true,accepted:false,reason:'completed_after_collection_window'};
    if(!unchanged)return {attempt:true,accepted:false,reason:'presentation_changed_during_inference'};
    return {attempt:true,accepted:true,reason:null};
  }
  function createTaskScope(timers) {
    let cancelled=false;
    const tasks=new Set();
    function wait(promise,timeoutMs,reason,onLate=()=>{}) {
      return new Promise((resolve,reject)=>{
        let done=false,timer;
        const finish=(callback,value)=>{if(done)return;done=true;timers.clearTimeout(timer);tasks.delete(cancel);callback(value);};
        const cancel=()=>finish(reject,Error('run_cancelled'));
        tasks.add(cancel);
        timer=timers.setTimeout(()=>finish(reject,Error(reason)),timeoutMs);
        Promise.resolve(promise).then(value=>{if(done){try{onLate(value);}catch(_){}return;}finish(resolve,value);},error=>finish(reject,error));
        if(cancelled)cancel();
      });
    }
    return {wait,cancel(){cancelled=true;for(const cancel of [...tasks])cancel();},get pendingCount(){return tasks.size;}};
  }
  function samplingSummary(rows) {
    const count=predicate=>rows.filter(predicate).length;
    return {logged:rows.length,completed:count(r=>finite(r.completedAt)),pending:count(r=>r.state==='pending'),
      capturedInCollectionWindow:count(r=>r.capturedInCollectionWindow===true),
      capturedOutsideCollectionWindow:count(r=>r.capturedInCollectionWindow!==true),
      validInCollectionWindow:count(r=>r.capturedInCollectionWindow===true&&r.valid===true),
      lateCompletions:count(r=>r.windowReason==='completed_after_collection_window'),
      aborted:count(r=>r.state==='aborted'),
      invalidReasons:rows.filter(r=>!r.valid).reduce((a,r)=>{const key=r.reason||r.windowReason||r.state||'unspecified';a[key]=(a[key]||0)+1;return a;},{}),
      definition:'Every camera frame submitted to FaceMesh is logged. Collection attempts require capture in [collectStart, collectEnd). Late completions remain invalid in the denominator; settling and between-target frames remain outside the evaluated collection.'};
  }
  function validationCoverage(targets) {
    if(!Array.isArray(targets)||!targets.length||targets.some(t=>!finite(t.targetX)||!finite(t.targetY)))return null;
    return {minX:Math.min(...targets.map(t=>t.targetX)),maxX:Math.max(...targets.map(t=>t.targetX)),
      minY:Math.min(...targets.map(t=>t.targetY)),maxY:Math.max(...targets.map(t=>t.targetY))};
  }
  function failureText(code) {
    const meanings={missing_target:'该点没有采样记录',insufficient_valid_samples:'有效帧数不足',insufficient_coverage:'有效采样比例不足',
      missing_valid_timestamps:'没有有效的采样时间',invalid_attempt_timestamp:'存在无效采样时间',nonmonotonic_timestamps:'采样时间顺序异常',
      discontinuous_valid_samples:'有效采样间隔过长',insufficient_duration:'有效采样时段过短',
      point_mean_error:'二维平均误差超标',point_p95_error:'二维 P95 误差超标',point_x_mean_error:'X 平均绝对误差超标',
      point_y_mean_error:'Y 平均绝对误差超标',point_x_p95_error:'X P95 误差超标',point_y_p95_error:'Y P95 误差超标',
      no_valid_samples:'没有有效样本',insufficient_validation_targets:'验证位置不足',insufficient_validation_target_span:'验证范围不足',
      degenerate_validation_target_layout:'验证位置分布不合格',meanErrorNorm_exceeded:'整体二维平均误差超标',p95ErrorNorm_exceeded:'整体二维 P95 误差超标',
      meanAbsErrorX_exceeded:'整体 X 平均绝对误差超标',meanAbsErrorY_exceeded:'整体 Y 平均绝对误差超标',
      p95AbsErrorX_exceeded:'整体 X P95 误差超标',p95AbsErrorY_exceeded:'整体 Y P95 误差超标'};
    return meanings[code]||(code.startsWith('target_failed:')?'位置 '+code.slice(14)+' 未通过':code);
  }
  function createApp(root) {
  const {document,navigator,crypto,performance,ImageCalibration,GazeCore,MGazePreprocess,TrackingAdapter,Worker,URL,Blob}=root;
  const setTimeout=root.setTimeout.bind(root),clearTimeout=root.clearTimeout.bind(root),requestAnimationFrame=root.requestAnimationFrame.bind(root);
  const addEventListener=root.addEventListener.bind(root),location=root.location;
  const APP = 'image-pilot-0.1.0';
  const MODELS = Object.freeze({
    mobilenet_v4: { file: 'mobilenet_v4.mnn', label: '轻量图像模型', sha256: 'db04d6568a15b85bd9d007e7f8ca7021422e390c24035a54d5108ae949f536d8' },
    base: { file: 'base.mnn', label: '原始图像模型', sha256: '2f96b95275fe6d7b79e98df3237ebb96e15ef5522c96968f08167da7e1954a96' }
  });
  const CONFIG = Object.freeze({ settleMs: 800, collectMs: 2400, minSamples: 12,
    modelTimeoutMs: 120000, frameTimeoutMs: 10000, cameraPermissionTimeoutMs:60000,videoTimeoutMs:20000,
    validation: { minCoverage: .8, minSamplesPerPoint: 12, minTargetCount: 9,
      minTargetSpanX: .4, minTargetSpanY: .4, maxMeanErrorNorm: .12, maxP95ErrorNorm: .25,
      maxMeanAbsErrorX: .1, maxMeanAbsErrorY: .1, maxP95AbsErrorX: .2, maxP95AbsErrorY: .2,
      maxPointMeanErrorNorm: .18, maxPointP95ErrorNorm: .30, maxSampleGapMs: 500, requireTimestamps: true }
  });
  let CAL=[],VAL=[],grid=null,gridLocked=false,scope=null,inFlight=null;
  const LABELS = ['左上','中上','右上','左中','中心','右中','左下','中下','右下'];
  const $ = id => document.getElementById(id);
  const required={GazeCore:GazeCore&&['createTemporalQualityGate','extractFeatures','evaluateValidation'].every(k=>typeof GazeCore[k]==='function'),
    TrackingAdapter:typeof TrackingAdapter?.create==='function',
    MGazePreprocess:MGazePreprocess&&['prepareInputs','roisFromLandmarks'].every(k=>typeof MGazePreprocess[k]==='function'),
    ImageCalibration:ImageCalibration&&['fitCalibration','predict'].every(k=>typeof ImageCalibration[k]==='function')};
  const missing=Object.keys(required).filter(k=>!required[k]);
  if(missing.length){
    $('status').textContent=APP+' · 加载失败';$('panel').hidden=false;
    $('panel').textContent='必要模块加载失败：'+missing.join('、')+'。请检查网络并重新打开页面。';
    $('pause').hidden=true;$('save-status').textContent='尚未开始采集。';
    return {ready:false,missing};
  }
  const canvas = $('stage'), context = canvas.getContext('2d'), video = $('camera');
  const frame = document.createElement('canvas'), frameContext = frame.getContext('2d', { willReadFrequently: true });
  let token = 0, running = false, backup = null, current = null, mapping = null;
  let worker = null, adapter = null, stream = null, pending = new Map(), jobId = 0, loopPromise = null;
  let width = root.innerWidth, height = root.innerHeight;
  const temporal = GazeCore.createTemporalQualityGate();
  const mean = a => a.length ? a.reduce((s,n) => s+n,0)/a.length : null;
  const pct = n => Number.isFinite(n) ? (n*100).toFixed(1)+'%' : '—';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const shuffle = items => {
    const a = items.slice();
    for (let i=a.length-1;i>0;i--) { const n = new Uint32Array(1); crypto.getRandomValues(n); const j=n[0]%(i+1); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  };
  function event(name, detail={}) { if (backup) backup.events.push({ timestamp: performance.now(), event: name, detail }); }
  function status(text) { $('status').textContent = '图像 0.1.0 · '+text; }
  function resize() {
    width = root.innerWidth; height = root.innerHeight;
    const dpr = root.devicePixelRatio || 1;
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    context.setTransform(dpr,0,0,dpr,0,0);
  }
  function rect(element) {
    if(!element)return null;
    const r=element.getBoundingClientRect();
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
  }
  function measureViewport() {
    const v=root.visualViewport;
    return {width,height,dpr:root.devicePixelRatio||1,canvas:rect(canvas),
      header:rect(document.querySelector('header')),footer:rect(document.querySelector('footer')),
      visual:v?{left:v.offsetLeft,top:v.offsetTop,right:v.offsetLeft+v.width,bottom:v.offsetTop+v.height,scale:v.scale}:
        {left:0,top:0,right:width,bottom:height,scale:1}};
  }
  function lockControls() {
    // Text changes (including save feedback) must not grow fixed controls over
    // targets. Heights are measured after the pause button becomes visible.
    for(const element of [$('status'),$('save-status')])Object.assign(element.style,{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:'0',flex:'1'});
    for(const element of [document.querySelector('header'),document.querySelector('footer')]) {
      element.style.height='';element.style.height=element.getBoundingClientRect().height+'px';element.style.overflow='hidden';
    }
  }
  function clear() { context.clearRect(0,0,width,height); }
  function draw(point, progress=0) {
    clear(); if (!point) return;
    const x=point.targetX*width,y=point.targetY*height;
    context.fillStyle='#1b6652'; context.beginPath(); context.arc(x,y,9,0,Math.PI*2); context.fill();
    context.fillStyle='#fff'; context.beginPath(); context.arc(x,y,2,0,Math.PI*2); context.fill();
    context.strokeStyle='#b6cfc1'; context.lineWidth=2; context.beginPath(); context.arc(x,y,17,0,Math.PI*2); context.stroke();
    if (progress>0) { context.strokeStyle='#1b6652'; context.lineWidth=3; context.beginPath(); context.arc(x,y,17,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.min(1,progress)); context.stroke(); }
  }
  function check(t) { if (!running || t!==token) throw Error('run_cancelled'); }
  function waitTask(promise,ms,reason,t,onLate) {
    return scope.wait(promise,ms,reason,onLate).then(value=>{try{check(t);}catch(e){if(onLate)onLate(value);throw e;}return value;});
  }
  async function waitUntil(deadline,t,point=null) {
    while (performance.now()<deadline) { check(t); if(point) draw(point,Math.max(0,(performance.now()-point.collectStart)/CONFIG.collectMs)); await sleep(30); }
    check(t);
  }
  function rpc(type, args={}) {
    return new Promise((resolve,reject) => {
      const id=++jobId;
      const timeout=setTimeout(() => { pending.delete(id); reject(Error(type+'_timeout')); },type==='init'?CONFIG.modelTimeoutMs:CONFIG.frameTimeoutMs);
      pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
      try {if(!worker)throw Error('model_worker_unavailable');worker.postMessage({id,type,...args});}
      catch(error){const item=pending.get(id);pending.delete(id);item.reject(error);}
    });
  }
  function release() {
    current=null;
    gridLocked=false;if(scope)scope.cancel();
    if(stream) stream.getTracks().forEach(track=>track.stop()); stream=null;
    video.srcObject=null;
    if(worker) worker.terminate(); worker=null;
    for(const p of pending.values()) p.reject(Error('run_cancelled')); pending.clear();
    if(adapter) {const closing=adapter;adapter=null;Promise.resolve().then(()=>closing.close()).catch(()=>{});}
  }
  function panel(html) { $('panel').innerHTML=html; $('panel').hidden=false; }
  function restartButton() { $('restart').onclick=()=>location.reload(); }
  function pause(reason='user_pause') {
    if (!running) return;
    abortCurrent('aborted',reason);running=false; token++;
    if(backup) backup.session.phase='paused'; event('paused',{reason});
    release(); clear(); $('pause').hidden=true; status('已暂停');
    panel('<h1>已暂停</h1><p>可以先下载本次诊断。继续测试需要重新完整校准。</p><button id="restart" class="primary">重新开始</button>'); restartButton();
  }
  function fail(error,t) {
    if(t!==token) return;
    error=error instanceof Error?error:Error(String(error));abortCurrent('failed',error.message);
    running=false; token++; if(backup) backup.session.phase='failed'; event('error',{message:error.message});
    release(); clear(); $('pause').hidden=true; status('本次未完成');
    const readable = error.message.includes('insufficient_calibration_samples') ? '这个点没有收集到足够的有效图像结果。请检查脸部是否完整入镜、眼睛是否被反光遮挡；也可能是手机运行速度不足。' :
      error.name==='NotAllowedError' ? 'Safari 没有获得摄像头权限。请允许此网站使用摄像头后重新打开。' :
      error.message==='insufficient_visible_target_span' ? '当前可见区域不足以放下校准和验证目标。请收起浏览器工具栏、保持页面正常缩放，再重新开始。定位门槛没有降低。' :
      error.message.includes('timeout') ? '摄像头或模型等待超时。请检查网络后重新打开，保留下面的诊断原因。' : '本次采集无法继续。请下载诊断备份，保留具体原因。';
    panel('<h1>本次未完成</h1><p>'+readable+'</p><p class="error">'+esc(error.message)+'</p><button id="restart" class="primary">重新开始</button>'); restartButton();
  }
  function abortCurrent(state,reason) {
    const now=performance.now();
    const activeBlock=backup?.calibration.blocks.at(-1);
    const activePoint=current||inFlight?.presentation;
    if(activePoint?.status==='collecting'){activePoint.status=state;activePoint.ended=now;activePoint.failure=reason;}
    if(activeBlock?.status==='collecting'){activeBlock.status=state;activeBlock.ended=now;activeBlock.failure=reason;}
    if(inFlight?.row&&!inFlight.row.completedAt){Object.assign(inFlight.row,{valid:false,reason,state:'aborted',completedAt:now,pipelineMs:now-inFlight.row.capturedAt});}
  }
  async function cameraReady(cameraPromise,t) {
    const stop=s=>s.getTracks().forEach(track=>track.stop());
    stream=await waitTask(cameraPromise,CONFIG.cameraPermissionTimeoutMs,'camera_permission_timeout',t,stop);
    check(t); video.srcObject=stream;
    await waitTask(video.play(),CONFIG.videoTimeoutMs,'video_play_timeout',t);
    const deadline=performance.now()+CONFIG.videoTimeoutMs;
    while(video.readyState<2 || !video.videoWidth || !video.videoHeight) { check(t); if(performance.now()>deadline)throw Error('video_ready_timeout'); await sleep(40); }
    backup.session.cameraSettings=stream.getVideoTracks()[0].getSettings();
    frame.width=video.videoWidth; frame.height=video.videoHeight;
    backup.session.cameraImageSize={width:frame.width,height:frame.height};
  }
  async function sampling(t) {
    let lastMedia=-1, landmarks=null, consecutiveErrors=0, lastFrameAt=performance.now();
    const detector=adapter;
    detector.onResults(result=>{if(running&&t===token)landmarks=result.multiFaceLandmarks?.[0]||null;});
    while(running && t===token) {
      if(video.currentTime===lastMedia || video.readyState<2) {
        if(performance.now()-lastFrameAt>CONFIG.frameTimeoutMs)throw Error('camera_frame_timeout');
        await sleep(8); continue;
      }
      if(video.videoWidth!==frame.width||video.videoHeight!==frame.height)throw Error('camera_image_size_changed');
      lastMedia=video.currentTime; lastFrameAt=performance.now();
      const p=current, capturedAt=performance.now(), sampleId=backup.gaze.length+1,capturedMapping=mapping;
      const row={sampleId,capturedAt,timestamp:capturedAt,completedAt:null,mediaTime:lastMedia,phase:backup.session.phase,
        presentationId:p?.presentationId||null,roundIndex:p?.roundIndex??null,
        targetId:p?.targetId||null,targetX:p?.targetX??null,targetY:p?.targetY??null,
        valid:false,reason:null,output:null,x:null,y:null,state:'pending'};
      const capturedInWindow=collectionDecision(p,capturedAt,capturedAt).attempt;
      row.capturedInCollectionWindow=capturedInWindow;
      backup.gaze.push(row);
      // Preserve the denominator as soon as an observation is attempted. A slow
      // or failed inference remains an invalid attempt instead of disappearing.
      if(capturedInWindow)p.attempts.push(row);
      let resolveFinished;
      const job={presentation:p,row,promise:new Promise(resolve=>{resolveFinished=resolve;})};
      inFlight=job;
      let fatal=null;
      try {
        frameContext.drawImage(video,0,0,frame.width,frame.height);landmarks=null;
        await waitTask(detector.send({image:frame,timestamp:capturedAt}),CONFIG.frameTimeoutMs,'face_mesh_inference_timeout',t);
        row.faceFinishedAt=performance.now();
        const geometry=GazeCore.extractFeatures(landmarks,frame.width,frame.height);
        row.geometryFeatures=geometry.features; row.headProxy=geometry.diagnostics.headProxy; row.quality=geometry.quality;
        const gate=temporal.update(geometry.quality,capturedAt);
        if(!gate.valid) row.reason=gate.reason;
        else {
          const regions=MGazePreprocess.roisFromLandmarks(landmarks,frame.width,frame.height);
          if(!regions.ok) row.reason=regions.reason;
          else {
            const rgba=frameContext.getImageData(0,0,frame.width,frame.height).data;
            const input=MGazePreprocess.prepareInputs({rgba,width:frame.width,height:frame.height,...regions,sourceMirrored:false});
            row.regions={face:regions.face,leftEye:regions.leftEye,rightEye:regions.rightEye};
            const result=await rpc('infer',{inputs:{face:input.face.data,left:input.left.data,right:input.right.data,rect:input.rect.data}}); check(t);
            if(!Array.isArray(result.output)||result.output.length!==258||!result.output.every(finite))throw Error('invalid_network_output');
            row.output=result.output; row.networkInferenceMs=result.inferenceMs;row.valid=true;
            if(capturedMapping) {const q=ImageCalibration.predict(capturedMapping,row.output);row.x=q.x;row.y=q.y;if(!q.valid){row.valid=false;row.reason=q.reason;}}
            else if(row.phase==='validation'){row.valid=false;row.reason='validation_model_unavailable';}
          }
        }
        consecutiveErrors=0;
      } catch(e) {
        if(t!==token||!running)return;
        row.valid=false;row.reason=e.message;consecutiveErrors++;temporal.reset();
        if(e.message.includes('timeout')||detector.state==='failed'||consecutiveErrors>=3)fatal=e;
      } finally {
        if(row.state!=='aborted') {
          row.completedAt=performance.now();row.pipelineMs=row.completedAt-capturedAt;row.state='complete';
          const decision=collectionDecision(p,capturedAt,row.completedAt,current===p);
          row.windowReason=decision.reason;
          if(decision.attempt&&!decision.accepted){row.valid=false;row.reason=row.reason||decision.reason;}
          if(!decision.attempt&&p&&current!==p){row.valid=false;row.reason=row.reason||'presentation_changed_during_inference';}
        }
        if(inFlight===job)inFlight=null;resolveFinished();
      }
      if(fatal)throw fatal;
    }
  }
  async function present(target,kind,index,total,roundIndex,t) {
    check(t); temporal.reset();
    const p={...target,kind,roundIndex,presentationId:kind+'-'+(roundIndex||1)+'-'+target.targetId,
      attempts:[],status:'collecting',onset:null,collectStart:null,collectEnd:null};
    backup.calibration.blocks.at(-1).targets.push(p);
    await waitTask(new Promise(resolve=>requestAnimationFrame(()=>{if(running&&t===token){draw(p);p.onset=performance.now();}resolve();})),CONFIG.frameTimeoutMs,'target_render_timeout',t);
    p.collectStart=p.onset+CONFIG.settleMs; p.collectEnd=p.collectStart+CONFIG.collectMs;
    p.viewport={width,height,dpr:root.devicePixelRatio}; p.renderedTargetCss={x:p.targetX*width,y:p.targetY*height};
    p.targetRegion={...grid.region};
    current=p; event('target_onset',{kind,presentationId:p.presentationId,onset:p.onset,collectStart:p.collectStart,collectEnd:p.collectEnd});
    status((kind==='calibration'?'校准 第'+roundIndex+'轮':'独立验证')+' '+index+'/'+total+' · 注视圆点');
    await waitUntil(p.collectEnd,t,p); current=null;
    const finishing=inFlight;
    // Also drain a frame begun during preparation: a hung detector must report
    // its timeout instead of disguising the failure as an empty first target.
    if(finishing)await waitTask(finishing.promise,CONFIG.frameTimeoutMs+100,'collection_drain_timeout',t);
    check(t);p.ended=performance.now();
    p.samplingSummary={attempts:p.attempts.length,valid:p.attempts.filter(a=>a.valid).length,
      lateCompletions:p.attempts.filter(a=>a.completedAt>p.collectEnd).length,
      pending:p.attempts.filter(a=>a.state==='pending').length};
    if(kind==='calibration' && p.samplingSummary.valid<CONFIG.minSamples) {p.status='failed';p.failure='insufficient_calibration_samples';throw Error('insufficient_calibration_samples:'+p.targetId);}
    p.status='complete';
    return p;
  }
  async function protocol(t) {
    $('panel').hidden=true;
    root.scrollTo?.(0,0);lockControls();
    await waitTask(new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),CONFIG.frameTimeoutMs,'viewport_layout_timeout',t);
    resize();grid=generateTargetGrid(measureViewport());CAL=grid.calibration;VAL=grid.validation;gridLocked=true;
    backup.session.targetGrid=grid;backup.session.viewport={width,height,dpr:root.devicePixelRatio||1};
    backup.calibration.calibrationTargets=CAL;backup.calibration.validationTargets=VAL;
    backup.session.phase='preparation'; draw(CAL[4]); status('准备 · 注视中央圆点');
    await waitUntil(performance.now()+3000,t);
    const block={id:'calibration-1',kind:'calibration',started:performance.now(),targets:[],status:'collecting'};
    backup.calibration.blocks.push(block); backup.session.phase='calibration';
    for(const round of [1,2]) { const order=shuffle(CAL); for(let i=0;i<order.length;i++)await present(order[i],'calibration',i+1,9,round,t); }
    clear(); status('正在拟合个人映射');
    const fit=ImageCalibration.fitCalibration(block.targets,{minSamples:CONFIG.minSamples});
    block.fit=fit; block.ended=performance.now();
    if(!fit.ok) {block.status='failed';throw Error(fit.reason);}
    block.status='complete'; mapping=fit.model; backup.calibration.currentModel=JSON.parse(JSON.stringify(mapping));
    backup.calibration.currentModelId=block.id;
    event('model_fitted',{candidateId:fit.selectedCandidateId});
    await waitUntil(performance.now()+1000,t);
    const validation={id:'validation-1',kind:'validation',started:performance.now(),targets:[],status:'collecting',modelId:block.id,
      mappingFrozenBeforeValidation:JSON.parse(JSON.stringify(mapping))};
    backup.calibration.blocks.push(validation); backup.session.phase='validation';
    const order=shuffle(VAL);
    for(let i=0;i<order.length;i++)await present(order[i],'validation',i+1,9,null,t);
    const attempts=validation.targets.flatMap(p=>p.attempts);
    if(JSON.stringify(mapping)!==JSON.stringify(validation.mappingFrozenBeforeValidation))throw Error('validation_mapping_changed');
    validation.evaluation=GazeCore.evaluateValidation(attempts,{...CONFIG.validation,expectedTargets:VAL});
    validation.status=validation.evaluation.passed?'passed':'failed'; validation.ended=performance.now();
    backup.session.validationOK=validation.evaluation.passed; backup.session.phase='report';
    abortCurrent('aborted','validation_complete');
    backup.session.samplingSummary=samplingSummary(backup.gaze);
    running=false; release(); clear(); $('pause').hidden=true;
    event('validation_completed',{passed:validation.evaluation.passed}); showReport(validation.evaluation);
  }
  function showReport(e) {
    const points=e.pointSummaries, pass=points.filter(p=>p.passed).length;
    const rows=backup.gaze.filter(g=>g.phase==='validation'), valid=rows.filter(g=>g.valid);
    const latency=mean(valid.map(g=>g.pipelineMs));
    const coverage=validationCoverage(VAL);
    const failed=points.filter(p=>!p.passed);
    const reasons='<details'+(e.passed?'':' open')+'><summary>判定原因</summary><p>'+((e.failures||[]).length?e.failures.map(f=>esc(failureText(f))).join('；'):'全部固定门槛通过。')+'</p>'+failed.map(p=>'<p><strong>'+esc(LABELS[Number(p.targetId.slice(1))-1]||p.targetId)+'：</strong>'+p.failures.map(f=>esc(failureText(f))).join('；')+'。有效记录 '+p.validCount+'/'+p.attemptCount+'。</p>').join('')+'</details>';
    status(e.passed?'独立验证通过':'独立验证未通过');
    panel('<p class="eyebrow">'+esc(backup.session.model.label)+' · 定位质量</p><h1>'+(e.passed?'独立验证通过':'独立验证未通过')+'</h1>'+
      '<p>逐点通过 <strong>'+pass+'/9</strong>。判定使用原始个人映射，坐标保留屏外结果。</p>'+
      '<div class="metrics"><div class="metric">X 平均绝对误差／屏宽<strong>'+pct(e.meanAbsErrorX)+'</strong></div><div class="metric">Y 平均绝对误差／屏高<strong>'+pct(e.meanAbsErrorY)+'</strong></div></div>'+
      '<p>二维平均误差 '+(e.meanErrorNorm?.toFixed(3)||'—')+'；P95 '+(e.p95ErrorNorm?.toFixed(3)||'—')+'。有效记录 '+e.validCount+'/'+e.attemptCount+'；各点平均有效比例 '+pct(e.coverage)+'。</p>'+
      (coverage?'<p class="note">本次验证目标覆盖 X '+pct(coverage.minX)+'–'+pct(coverage.maxX)+' 屏宽、Y '+pct(coverage.minY)+'–'+pct(coverage.maxY)+' 屏高；结论限于这些位置。</p>':'')+
      '<p class="note">误差按屏宽、屏高归一化，不是视角度数。有效比例不是准确率。本次结果用于模型比较，不能保证正式实验精度。</p>'+
      reasons+
      '<details open><summary>各点结果</summary><table><thead><tr><th>位置</th><th>X 误差</th><th>Y 误差</th><th>结果</th></tr></thead><tbody>'+points.map(p=>'<tr><td>'+LABELS[Number(p.targetId.slice(1))-1]+'</td><td>'+pct(p.meanAbsErrorX)+'</td><td>'+pct(p.meanAbsErrorY)+'</td><td class="'+(p.passed?'pass':'fail')+'">'+(p.passed?'通过':'未通过')+'</td></tr>').join('')+'</tbody></table></details>'+
      '<details><summary>模型与运行信息</summary><p class="note">校准模型：'+esc(mapping?.candidateId||backup.calibration.currentModel?.candidateId)+'。每次先用校准轮次选择模型，再进入独立验证。平均处理一帧耗时 '+(latency?.toFixed(1)||'—')+' ms。</p><p class="note">X/Y 平均绝对误差门槛各为 10%，P95 各为 20%；二维整体平均门槛 0.12，P95 门槛 0.25，另检查每点误差及采样完整性。</p></details>'+
      '<button id="download-report" class="primary">下载完整诊断</button><button id="restart">重新完整测试</button>');
    $('download-report').onclick=save; restartButton();
  }
  async function start() {
    if(running)return;
    if(!root.isSecureContext || !navigator.mediaDevices?.getUserMedia) {panel('<h1>请通过 HTTPS 打开</h1><p>手机摄像头需要安全网址。请使用发布后的链接，在 Safari 中打开。</p>');return;}
    const modelId=$('model-choice').value, t=++token; running=true; mapping=null; resize();
    const model=MODELS[modelId];
    scope=createTaskScope({setTimeout,clearTimeout});CAL=[];VAL=[];grid=null;gridLocked=false;temporal.reset();
    if(!model){fail(Error('unknown_model'),t);return;}
    const runId=new Date().toISOString()+'-'+crypto.randomUUID();
    backup={schemaVersion:3,runId,session:{appVersion:APP,runId,startedAtUTC:new Date().toISOString(),phase:'initializing',
      model:{id:modelId,...model,sourceRevision:'7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa'},
      userAgent:navigator.userAgent,viewport:{width,height,dpr:root.devicePixelRatio||1},config:CONFIG,validationOK:false,
      preprocessing:JSON.parse(JSON.stringify(MGazePreprocess.contract||{})),
      timestamps:{clock:'performance.now() monotonic milliseconds, session-local',timestamp:'capturedAt; the time immediately before copying the video frame',
        capturedAt:'Capture begins before the FaceMesh and network pipeline; mediaTime is the source video presentation time in seconds.',
        completedAt:'Pipeline completion or explicit cancellation time; faceFinishedAt precedes network inference.',
        collection:'Capture must be in [collectStart, collectEnd), and completion must be at or before collectEnd. Late results stay as invalid attempts. Next presentation and fitting wait for pending work to settle.'},
      outputDefinition:'First two network outputs are uncalibrated camera-coordinate predictions; remaining 256 are learned features. Only personal mapping yields normalized viewport coordinates.',
      privacy:'Images processed on-device; only numeric observations exported; no automatic upload.',
      comparison:'Research prototype; changes network, feature representation and calibration. Not a controlled single-factor comparison with v2.3.0.'},
      calibration:{blocks:[],currentModel:null,calibrationTargets:CAL,validationTargets:VAL},gaze:[],events:[]};
    panel('<h1>正在准备</h1><p>请允许 Safari 使用摄像头。首次打开还需加载图像模型，完成后会自动显示中央圆点。</p>'); $('pause').hidden=false; status('加载摄像头和图像模型');
    try {
      // Begin permission in the click handler, and attach rejection/late-stream
      // cleanup before constructing anything else that can fail synchronously.
      const cameraPromise=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}}});
      const cameraTask=cameraReady(cameraPromise,t);cameraTask.catch(()=>{});
      worker=new Worker('./gaze-worker.mjs?v=0.1.0',{type:'module'});
      worker.onmessage=({data})=>{if(t!==token||!running)return;const p=pending.get(data.id);if(p){pending.delete(data.id);data.ok?p.resolve(data.result):p.reject(Error(data.error));}};
      const workerFailed=e=>{const error=Error(e.message||'model_worker_failed');for(const p of pending.values())p.reject(error);pending.clear();fail(error,t);};
      worker.onerror=workerFailed;worker.onmessageerror=()=>workerFailed({message:'model_worker_message_failed'});
      adapter=TrackingAdapter.create({engine:'legacy',assetBase:'../food2/mp/package/'});
      const initialized=await Promise.all([cameraTask,waitTask(adapter.initialize(),CONFIG.modelTimeoutMs,'face_mesh_initialization_timeout',t),rpc('init',{modelPath:'./mnn/'+model.file,sha256:model.sha256})]); check(t);
      backup.session.runtime=initialized[2];
      loopPromise=sampling(t).catch(e=>fail(e,t));
      await protocol(t);
    } catch(e) {fail(e,t);}
  }
  function save() {
    if(!backup) {$('save-status').textContent='开始测试后可下载诊断。';return;}
    const snapshot={...backup,session:{...backup.session,exportedAtUTC:new Date().toISOString(),counts:{gaze:backup.gaze.length,events:backup.events.length},samplingSummary:samplingSummary(backup.gaze)}};
    const blob=new Blob([JSON.stringify(snapshot)],{type:'application/json'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=backup.runId+'_image-gaze-backup.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    $('save-status').textContent='已发起下载，请保留完整 JSON。';
  }
  $('start').onclick=start; $('save').onclick=save; $('pause').onclick=()=>pause();
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause('page_hidden');});
  addEventListener('pagehide',()=>pause('page_hidden'));
  function viewportChanged() {
    const changed=root.innerWidth!==width||root.innerHeight!==height||
      (gridLocked&&(root.devicePixelRatio||1)!==grid.measurement.dpr)||
      (gridLocked&&['left','top','right','bottom','scale'].some(k=>Math.abs(measureViewport().visual[k]-grid.measurement.visual[k])>(k==='scale'?.0001:.5)));
    if(changed){if(running&&gridLocked)pause('viewport_changed');resize();}
  }
  addEventListener('resize',viewportChanged);
  root.visualViewport?.addEventListener('resize',viewportChanged);
  root.visualViewport?.addEventListener('scroll',viewportChanged);
  resize();
  return {ready:true,start,pause,save,getState:()=>({running,backup,current,mapping,grid,gridLocked,pendingTasks:scope?.pendingCount||0,pendingWorkerCalls:pending.size})};
  }
  return {generateTargetGrid,collectionDecision,createTaskScope,samplingSummary,validationCoverage,failureText,createApp};
});
