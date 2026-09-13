/* Research implementation, CC BY-NC-SA 4.0; model provenance is in NOTICE.md.
 * This page exercises the production Worker. No camera, participants, or gaze truth. */
const VERSION = 'worker-selftest-0.1.0';
const LENGTHS = { face:224*224*3, left:112*112*3, right:112*112*3, rect:12 };
const $ = id => document.getElementById(id);
const portraitSource = Object.freeze({
  url:'https://storage.googleapis.com/mediapipe-assets/portrait.jpg',
  bytes:176561, sha256:'a6f11efaa834706db23f275b6115058fa87fc7f14362681e6abe14e82749de3e',
  use:'Optional remote official test asset; no gaze truth and no local redistribution.'
});
let report = { version:VERSION, status:'idle', purpose:'runtime_numeric_selftest_not_gaze_accuracy' };
let busy = false;
function render(message) {
  document.body.dataset.selftestStatus = report.status;
  $('selftest-report').textContent = JSON.stringify(report, null, 2);
  if (message) $('selftest-state').textContent = message;
}
function line(message) { const li=document.createElement('li');li.textContent=message;$('selftest-results').append(li); }
function requireValue(condition, message) { if(!condition) throw Error(message); }
function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise,new Promise((_, reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}
async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function fixture(name) {
  return Object.fromEntries(Object.entries(LENGTHS).map(([key,count],index)=>{
    const values=key==='rect'?new Float32Array([.6,.8,.2,.1,.12,.12,.32,.32,.12,.12,.56,.32]):new Float32Array(count);
    if(key!=='rect')for(let i=0;i<count;i++)values[i]=name==='flat'?.5:((i*17+index*31)%251)/250;
    return [key,values];
  }));
}
function workerClient() {
  const worker=new Worker(new URL('./gaze-worker.mjs?v=0.1.0',import.meta.url),{type:'module'});
  let id=0,closed=false;
  const pending=new Map();
  const rejectAll=message=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(message));}pending.clear();};
  worker.onmessage=({data})=>{
    const p=pending.get(data?.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(data.id);
    if(data.ok)p.resolve(data.result);else p.reject(Error(data.error||'worker_reported_error'));
  };
  worker.onerror=e=>rejectAll(e.message||'worker_loading_error');
  worker.onmessageerror=()=>rejectAll('worker_message_decode_error');
  return {
    request(type,args={}) {
      if(closed)return Promise.reject(Error('selftest_worker_closed'));
      return new Promise((resolve,reject)=>{
        const requestId=++id;
        const timer=setTimeout(()=>{pending.delete(requestId);reject(Error(type+'_timeout'));},type==='init'?120000:30000);
        pending.set(requestId,{resolve,reject,timer});
        try{worker.postMessage({id:requestId,type,...args});}catch(error){clearTimeout(timer);pending.delete(requestId);reject(error);}
      });
    },
    close(){closed=true;worker.terminate();rejectAll('selftest_worker_closed');}
  };
}
function compare(result,reference,tolerance) {
  requireValue(Array.isArray(result.output)&&result.output.length===258,'expected_258_outputs');
  requireValue(result.output.every(Number.isFinite),'nonfinite_output');
  requireValue(reference.length===258&&reference.every(Number.isFinite),'invalid_python_reference');
  let maxAbsoluteDifference=0,maxToleranceRatio=0;
  result.output.forEach((value,i)=>{
    const difference=Math.abs(value-reference[i]);
    maxAbsoluteDifference=Math.max(maxAbsoluteDifference,difference);
    maxToleranceRatio=Math.max(maxToleranceRatio,difference/(tolerance.absolute+tolerance.relative*Math.abs(reference[i])));
  });
  requireValue(maxToleranceRatio<=1,'python_parity_exceeded:'+maxToleranceRatio);
  return {status:'passed',outputCount:258,allFinite:true,maxAbsoluteDifference,maxToleranceRatio,
    inferenceMs:result.inferenceMs,firstTwoUncalibratedOutputs:result.output.slice(0,2)};
}
async function expectRejection(client,inputs,pattern) {
  let error=null;
  try{await client.request('infer',{inputs});}catch(e){error=e;}
  requireValue(error&&pattern.test(error.message),'expected_input_rejection:'+pattern);
  return {status:'passed',receivedError:error.message};
}
const scripts=new Map();
function loadScript(path, globalName) {
  if(globalThis[globalName])return Promise.resolve();
  if(scripts.has(path))return scripts.get(path);
  const promise=timeout(new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL(path,import.meta.url).href;
    script.onload=()=>globalThis[globalName]?resolve():reject(Error('missing_global:'+globalName));
    script.onerror=()=>reject(Error('script_load_failed:'+path));document.head.append(script);
  }),60000,'script_timeout:'+path);
  scripts.set(path,promise);return promise;
}
async function portraitInputs() {
  report.portrait.status='loading';render('正在检查官方示例人像调用链…');
  await Promise.all([
    loadScript('../food2/mp/package/face_mesh.js','FaceMesh'),
    loadScript('../shared/tracking-adapter.js?v=2.3.0','TrackingAdapter'),
    loadScript('../shared/gaze-core.js?v=2.3.0','GazeCore'),
    loadScript('./preprocess.js?v=0.1.0','MGazePreprocess')
  ]);
  const controller=new AbortController();
  let bytes;
  try{
    bytes=await timeout((async()=>{
      const response=await fetch(portraitSource.url,{mode:'cors',signal:controller.signal});
      requireValue(response.ok,'portrait_http_'+response.status);return new Uint8Array(await response.arrayBuffer());
    })(),45000,'portrait_download_timeout');
  }finally{controller.abort();}
  requireValue(bytes.length===portraitSource.bytes,'portrait_length_mismatch');
  const actualHash=await sha256(bytes);requireValue(actualHash===portraitSource.sha256,'portrait_checksum_mismatch');
  const img=new Image();img.crossOrigin='anonymous';
  const blobUrl=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
  let adapter=null;
  try{
    img.src=blobUrl;await timeout(img.decode(),15000,'portrait_decode_timeout');
    const canvas=$('portrait-preview');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true});requireValue(context,'canvas_2d_unavailable');
    context.drawImage(img,0,0);
    adapter=TrackingAdapter.create({engine:'legacy',assetBase:'../food2/mp/package/'});
    let landmarks=null;
    adapter.onResults(result=>{landmarks=result.multiFaceLandmarks?.[0]||null;});
    await timeout(adapter.initialize(),90000,'facemesh_initialize_timeout');
    const began=performance.now();
    await timeout(adapter.send({image:canvas,timestamp:began}),45000,'facemesh_inference_timeout');
    requireValue(Array.isArray(landmarks)&&landmarks.length===478,'expected_478_detected_landmarks');
    const regions=MGazePreprocess.roisFromLandmarks(landmarks,canvas.width,canvas.height);
    requireValue(regions.ok,'portrait_roi_failed:'+regions.reason);
    const prepared=MGazePreprocess.prepareInputs({rgba:context.getImageData(0,0,canvas.width,canvas.height).data,
      width:canvas.width,height:canvas.height,...regions,sourceMirrored:false});
    const geometry=GazeCore.extractFeatures(landmarks,canvas.width,canvas.height);
    const inputs={face:prepared.face.data,left:prepared.left.data,right:prepared.right.data,rect:prepared.rect.data};
    report.portrait={...report.portrait,status:'prepared',sha256:actualHash,
      sourceDimensions:{width:canvas.width,height:canvas.height},landmarkCount:landmarks.length,
      regions:{face:regions.face,leftEye:regions.leftEye,rightEye:regions.rightEye},
      inputLengths:Object.fromEntries(Object.entries(inputs).map(([key,values])=>[key,values.length])),
      inputContract:prepared.metadata.contractId,adapterIdentity:adapter.identity,
      geometryQuality:geometry.quality,geometryGateRequiredForThisSoftwareSelftest:false,
      faceAndPreprocessingMs:performance.now()-began};
    context.lineWidth=3;
    for(const [key,color]of [['face','#1db56e'],['leftEye','#f3bc3d'],['rightEye','#19bad5']]){
      const r=regions[key];context.strokeStyle=color;context.strokeRect(r.x,r.y,r.width,r.height);
    }
    $('portrait-panel').hidden=false;render();return inputs;
  }finally{
    URL.revokeObjectURL(blobUrl);
    if(adapter)await timeout(adapter.close(),10000,'facemesh_close_timeout');
  }
}
async function run() {
  if(busy)return;busy=true;$('run-selftest').disabled=true;$('include-portrait').disabled=true;
  $('download-selftest').disabled=true;$('selftest-results').replaceChildren();$('portrait-panel').hidden=true;
  const includePortrait=$('include-portrait').checked;
  report={version:VERSION,status:'running',purpose:'runtime_numeric_selftest_not_gaze_accuracy',
    startedAtUTC:new Date().toISOString(),environment:{userAgent:navigator.userAgent,secureContext:isSecureContext,
      crossOriginIsolated,workerAvailable:typeof Worker==='function'},
    cameraRequested:false,participantDataCollected:false,numericStatus:'running',
    portrait:{requested:includePortrait,status:includePortrait?'pending':'not_requested',source:portraitSource},models:{}};
  render('正在加载数值参考与模型…');
  try{
    requireValue(typeof Worker==='function','web_worker_unavailable');
    requireValue(crypto?.subtle,'secure_context_sha256_unavailable_use_https_or_localhost');
    const response=await timeout(fetch(new URL('./selftest-fixture.json',import.meta.url)),30000,'reference_download_timeout');
    requireValue(response.ok,'reference_http_'+response.status);
    const golden=await response.json();report.reference=golden.reference;report.tolerance=golden.tolerance;
    for(const name of ['pattern','flat']){
      for(const[key,values]of Object.entries(fixture(name))){
        const hash=await sha256(values.buffer);requireValue(hash===golden.fixtures[name].input_sha256[key],'synthetic_input_hash_mismatch:'+name+':'+key);
      }
    }
    report.inputByteChecks='passed';
    let realInputs=null;
    if(includePortrait){
      try{realInputs=await portraitInputs();line('示例人像检测到 478 个关键点，图像输入已生成。');}
      catch(e){report.portrait.status='failed';report.portrait.error=e.message;line('示例人像链路未完成：'+e.message);render();}
    }
    for(const name of ['mobilenet_v4','base']){
      const record=report.models[name]={numericStatus:'running',cases:{}};
      const client=workerClient();render('正在检查 '+name+' 模型…');
      try{
        record.runtime=await client.request('init',{modelPath:'./mnn/'+name+'.mnn',sha256:golden.models[name].sha256});
        const actual=await client.request('infer',{inputs:fixture('pattern')});
        record.cases.pattern=compare(actual,golden.models[name].outputs.pattern,golden.tolerance);
        record.wrongLength=await expectRejection(client,{...fixture('pattern'),rect:new Float32Array(11)},/rect must contain/);
        const invalid=fixture('pattern');invalid.face[0]=NaN;
        record.nonfiniteInput=await expectRejection(client,invalid,/nonfinite_input/);
        const recovery=await client.request('infer',{inputs:fixture('flat')});
        record.cases.recoveryFlat=compare(recovery,golden.models[name].outputs.flat,golden.tolerance);
        record.numericStatus='passed';
        line(name+'：258 维数值对照通过；错尺寸、NaN 拒绝后恢复通过。');
        if(realInputs){
          try{
            const real=await client.request('infer',{inputs:realInputs});
            requireValue(Array.isArray(real.output)&&real.output.length===258&&real.output.every(Number.isFinite),'invalid_portrait_model_output');
            record.portrait={status:'passed',outputCount:real.output.length,allFinite:true,inferenceMs:real.inferenceMs,
              firstTwoUncalibratedOutputs:real.output.slice(0,2),gazeTruthAvailable:false};
            line(name+'：实际人像裁剪推理返回 258 个有限数值。');
          }catch(e){record.portrait={status:'failed',error:e.message};line(name+' 人像模型调用失败：'+e.message);}
        }
      }catch(e){record.numericStatus='failed';record.error=e.message;line(name+' 数值自测失败：'+e.message);}
      finally{client.close();render();}
    }
    report.numericStatus=Object.values(report.models).every(m=>m.numericStatus==='passed')?'passed':'failed';
    if(realInputs)report.portrait.status=Object.values(report.models).every(m=>m.portrait?.status==='passed')?'passed':'failed';
    report.status=report.numericStatus==='passed'&&(!includePortrait||report.portrait.status==='passed')?'passed':'failed';
  }catch(e){report.status='failed';report.error=e.message;if(report.numericStatus==='running')report.numericStatus='failed';line('自测未完成：'+e.message);}
  finally{
    report.completedAtUTC=new Date().toISOString();report.gazeAccuracyAssessed=false;
    render(report.status==='passed'?'自测通过；这不代表眼动精度达标。':'自测有未通过项；请查看具体原因。');
    busy=false;$('run-selftest').disabled=false;$('include-portrait').disabled=false;$('download-selftest').disabled=false;
  }
}
$('run-selftest').onclick=run;
$('download-selftest').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='image-model-selftest-'+new Date().toISOString().replace(/:/g,'-')+'.json';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
};
const parameters=new URLSearchParams(location.search);
$('include-portrait').checked=parameters.get('portrait')==='1';
render('等待开始');
if(parameters.get('autorun')==='1')void run();
