'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Pilot = require('./pilot.js');
const Core = require('../../mediapipe-mobile/shared/gaze-core.js');

const flush = async () => { for(let i=0;i<14;i++)await Promise.resolve(); };
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function clock(){
  let now=0,id=0;const tasks=new Map();
  return {get now(){return now;},get size(){return tasks.size;},
    setTimeout(fn,ms=0){const n=++id;tasks.set(n,{fn,at:now+ms});return n;},
    clearTimeout(n){tasks.delete(n);},
    async advance(ms){
      const end=now+ms;await flush();
      for(;;){const next=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;
        now=next[1].at;tasks.delete(next[0]);next[1].fn();await flush();}
      now=end;await flush();
    }
  };
}
const measurement = () => ({width:390,height:780,header:{left:0,top:0,right:390,bottom:95},footer:{left:0,top:710,right:390,bottom:780},canvas:{left:0,top:0,right:390,bottom:780},visual:{left:0,top:0,right:390,bottom:780,scale:1}});

test('safe grid respects actual controls, visible bounds, distinct holdout positions and unchanged span gates',()=>{
  const m=measurement(),before=JSON.stringify(m),g=Pilot.generateTargetGrid(m);
  assert.equal(JSON.stringify(m),before);assert.equal(g.calibration.length,9);assert.equal(g.validation.length,9);
  for(const p of [...g.calibration,...g.validation]){
    assert.ok(p.targetY*m.height>=m.header.bottom+27-1e-8);
    assert.ok(p.targetY*m.height<=m.footer.top-27+1e-8);
    assert.ok(p.targetX*m.width>=27 && p.targetX*m.width<=m.width-27);
  }
  assert.ok(g.constraints.calibrationSpanY>=.5);assert.ok(g.constraints.validationSpanY>=.4);
  for(const v of g.validation)assert.ok(g.calibration.every(c=>v.targetX!==c.targetX||v.targetY!==c.targetY));
  const range=Pilot.validationCoverage(g.validation);
  assert.ok(range.minY>g.region.yMin);assert.ok(range.maxY<g.region.yMax);
  m.header.bottom=330;assert.throws(()=>Pilot.generateTargetGrid(m),/insufficient_visible_target_span/);
  m.height=NaN;assert.throws(()=>Pilot.generateTargetGrid(m),/invalid_viewport/);
});
test('empty validation retains all nine expected positions and exposes missing reasons',()=>{
  const g=Pilot.generateTargetGrid(measurement());
  const e=Core.evaluateValidation([],{expectedTargets:g.validation,minTargetCount:9,minTargetSpanX:.4,minTargetSpanY:.4});
  assert.equal(e.passed,false);assert.equal(e.pointSummaries.length,9);
  assert.ok(e.pointSummaries.every(p=>!p.passed&&p.failures.includes('missing_target')));
  assert.ok(!e.failures.includes('insufficient_validation_target_span'));
  assert.match(Pilot.failureText('missing_target'),/没有采样记录/);
});
test('capture window is half-open; late completion stays in denominator but cannot be accepted',()=>{
  const p={collectStart:100,collectEnd:200};
  assert.deepEqual(Pilot.collectionDecision(p,100,200),{attempt:true,accepted:true,reason:null});
  assert.equal(Pilot.collectionDecision(p,200,200).attempt,false);
  assert.equal(Pilot.collectionDecision(p,99,150).attempt,false);
  assert.deepEqual(Pilot.collectionDecision(p,199,201),{attempt:true,accepted:false,reason:'completed_after_collection_window'});
  assert.equal(Pilot.collectionDecision(p,150,151,false).accepted,false);
  assert.equal(Pilot.collectionDecision(p,150,149).reason,'nonmonotonic_pipeline_timestamp');
  assert.equal(Pilot.collectionDecision(p,150,null).attempt,false);
  const s=Pilot.samplingSummary([{capturedInCollectionWindow:true,completedAt:201,state:'complete',valid:false,windowReason:'completed_after_collection_window'},
    {capturedInCollectionWindow:false,completedAt:99,state:'complete',valid:true}]);
  assert.equal(s.capturedInCollectionWindow,1);assert.equal(s.capturedOutsideCollectionWindow,1);assert.equal(s.lateCompletions,1);assert.equal(s.validInCollectionWindow,0);
});
test('timed-out permission promise cleans up its late stream and consumes its rejection',async()=>{
  const c=clock(),s=Pilot.createTaskScope(c),d=deferred();let stopped=0;
  const result=s.wait(d.promise,50,'camera_permission_timeout',stream=>stream.stop()).catch(e=>e.message);
  await c.advance(51);assert.equal(await result,'camera_permission_timeout');assert.equal(s.pendingCount,0);
  d.resolve({stop(){stopped++;}});await flush();assert.equal(stopped,1);assert.equal(c.size,0);
  const r=deferred();const result2=s.wait(r.promise,10,'timeout').catch(e=>e.message);s.cancel();r.reject(Error('late camera error'));
  assert.equal(await result2,'run_cancelled');await flush();assert.equal(c.size,0);
});
test('cancellation rejects every pending wait, including waits created after cancellation',async()=>{
  const c=clock(),s=Pilot.createTaskScope(c),d=deferred();
  const results=[s.wait(d.promise,100,'timeout'),s.wait(d.promise,100,'timeout')].map(p=>p.catch(e=>e.message));
  s.cancel();assert.deepEqual(await Promise.all(results),['run_cancelled','run_cancelled']);
  assert.equal(await s.wait(d.promise,100,'timeout').catch(e=>e.message),'run_cancelled');
  assert.equal(s.pendingCount,0);assert.equal(c.size,0);
});

function harness(options={}){
  const c=clock(),elements=new Map(),listeners={},visualListeners={},fits=[],workers=[];
  const ctx={setTransform(){},clearRect(){},beginPath(){},arc(){},fill(){},stroke(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(4)};}};
  function element(id){if(!elements.has(id))elements.set(id,{style:{},hidden:false,textContent:'',innerHTML:'',value:'mobilenet_v4',
    getContext:()=>ctx,getBoundingClientRect:()=>({left:0,top:0,right:390,bottom:780,width:390,height:780}),click(){},remove(){}});return elements.get(id);}
  const header=element('header'),footer=element('footer');
  header.getBoundingClientRect=()=>({left:0,top:0,right:390,bottom:80,width:390,height:80});
  footer.getBoundingClientRect=()=>({left:0,top:710,right:390,bottom:780,width:390,height:70});
  let stops=0,closed=0;const track={stop(){stops++;},getSettings:()=>({width:640,height:480,frameRate:30})};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const video=element('camera');video.readyState=2;video.videoWidth=640;video.videoHeight=480;
  Object.defineProperty(video,'currentTime',{get:()=>c.now/1000});video.play=()=>options.playPromise||Promise.resolve();
  const adapter={state:'idle',initialize:()=>options.initializePromise||Promise.resolve(),onResults(fn){this.callback=fn;},
    send(){if(options.sendPromise)return options.sendPromise;this.callback({multiFaceLandmarks:[[]]});return Promise.resolve();},close(){closed++;}};
  const root={document:{getElementById:element,createElement:()=>element('created-'+elements.size),querySelector:s=>s==='header'?header:footer,
    addEventListener:(name,fn)=>listeners[name]=fn,body:{appendChild(){}}},
    navigator:{userAgent:'test Safari',mediaDevices:{getUserMedia:()=>options.cameraPromise||Promise.resolve(stream)}},
    crypto:{randomUUID:()=> 'fixture',getRandomValues:a=>{a[0]=1;return a;}},performance:{now:()=>c.now},
    ImageCalibration:{fitCalibration(targets){fits.push(JSON.parse(JSON.stringify(targets)));return {ok:true,selectedCandidateId:'fixture',model:{candidateId:'fixture',fixed:[1,2]}};},predict(model,output){return {x:output[0],y:output[1],valid:true};}},
    GazeCore:{...Core,extractFeatures:()=>({features:[.5,.5,.5,.5],diagnostics:{headProxy:[]},quality:{valid:true}})},
    MGazePreprocess:{contract:{id:'fixture-preprocessing'},roisFromLandmarks:()=>({ok:true,face:{},leftEye:{},rightEye:{}}),prepareInputs:()=>({face:{data:[]},left:{data:[]},right:{data:[]},rect:{data:[]}})},
    TrackingAdapter:{create:()=>adapter},
    Worker:class{
      constructor(){if(options.workerConstructorThrows)throw Error('worker_constructor_failure');workers.push(this);}
      postMessage(m){const reply=()=>this.onmessage?.({data:{id:m.id,ok:true,result:m.type==='init'?{runtime:'fixture'}:{output:Array(258).fill(.5),inferenceMs:options.inferDelay||0}}});
        if(m.type==='infer'&&options.inferDelay)c.setTimeout(reply,options.inferDelay);else Promise.resolve().then(reply);}
      terminate(){this.terminated=true;}
    },URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},Blob:class{},
    setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,requestAnimationFrame:fn=>c.setTimeout(()=>fn(c.now),16),
    addEventListener:(name,fn)=>listeners[name]=fn,location:{reload(){}},scrollTo(){},
    innerWidth:390,innerHeight:780,devicePixelRatio:3,isSecureContext:true,
    visualViewport:{offsetLeft:0,offsetTop:0,width:390,height:780,scale:1,addEventListener:(name,fn)=>visualListeners[name]=fn}
  };
  if(options.missing)delete root[options.missing];
  const app=Pilot.createApp(root);
  return {app,c,root,e:element,stream,workers,fits,listeners,visualListeners,get stops(){return stops;},get closed(){return closed;},
    async until(predicate,limit=130000){const deadline=c.now+limit;while(!predicate()&&c.now<deadline)await c.advance(50);assert.ok(predicate(),'condition not reached');}};
}

test('missing dependencies give a visible loading error before attaching a dead start button',()=>{
  for(const name of ['GazeCore','TrackingAdapter','MGazePreprocess','ImageCalibration']){
    const h=harness({missing:name});assert.equal(h.app.ready,false);assert.match(h.e('status').textContent,/加载失败/);assert.ok(h.e('panel').textContent.includes(name));
  }
});
test('cancel during permission stops a stream granted later; no model or sampling starts',async()=>{
  const d=deferred(),h=harness({cameraPromise:d.promise});const started=h.app.start();await flush();h.app.pause();
  d.resolve(h.stream);await started;await flush();
  assert.equal(h.stops,1);assert.equal(h.closed,1);assert.equal(h.app.getState().backup.session.phase,'paused');
  assert.equal(h.app.getState().backup.gaze.length,0);assert.equal(h.app.getState().pendingTasks,0);assert.equal(h.app.getState().pendingWorkerCalls,0);
});
test('a synchronous Worker construction failure also cleans up a later camera permission result',async()=>{
  const d=deferred(),h=harness({cameraPromise:d.promise,workerConstructorThrows:true});await h.app.start();d.resolve(h.stream);await flush();
  assert.equal(h.stops,1);assert.match(h.e('panel').innerHTML,/worker_constructor_failure/);assert.equal(h.app.getState().running,false);
});
test('camera permission, video playback, FaceMesh initialization and FaceMesh inference all have bounded failure paths',async()=>{
  for(const [options,duration,reason] of [[{cameraPromise:new Promise(()=>{})},60001,'camera_permission_timeout'],
    [{playPromise:new Promise(()=>{})},20001,'video_play_timeout'],
    [{initializePromise:new Promise(()=>{})},120001,'face_mesh_initialization_timeout'],
    [{sendPromise:new Promise(()=>{})},10001,'face_mesh_inference_timeout']]){
    const h=harness(options),started=h.app.start();await flush();await h.c.advance(duration);await started;
    assert.equal(h.app.getState().running,false);assert.equal(h.app.getState().backup.session.phase,'failed');
    assert.ok(h.e('panel').innerHTML.includes(reason),reason+': '+h.e('panel').innerHTML);assert.equal(h.app.getState().pendingTasks,0);
    assert.equal(h.app.getState().pendingWorkerCalls,0);assert.equal(h.workers[0].terminated,true);
  }
});
test('idle Worker failure terminates the run; visual viewport change pauses a locked layout',async()=>{
  const h=harness(),started=h.app.start();await h.until(()=>h.app.getState().gridLocked);
  h.workers[0].onerror({message:'idle_worker_failure'});await h.c.advance(50);await started;
  assert.equal(h.app.getState().backup.session.phase,'failed');assert.equal(h.stops,1);assert.match(h.e('panel').innerHTML,/idle_worker_failure/);
  const v=harness(),started2=v.app.start();await v.until(()=>v.app.getState().gridLocked);
  assert.equal(v.e('status').style.whiteSpace,'nowrap');assert.equal(v.e('header').style.height,'80px');
  v.root.visualViewport.offsetTop=20;v.visualListeners.scroll();await v.c.advance(50);await started2;
  assert.equal(v.app.getState().backup.session.phase,'paused');assert.equal(v.app.getState().running,false);
});
test('complete simulated protocol fits only 18 settled calibration presentations, preserves late attempts, freezes mapping and reports limited coverage',async()=>{
  const h=harness({inferDelay:87}),started=h.app.start();await h.until(()=>h.app.getState().backup?.session.phase==='report');await started;await flush();
  const b=h.app.getState().backup;assert.equal(h.fits.length,1);assert.equal(h.fits[0].length,18);
  assert.ok(h.fits[0].every(p=>p.kind==='calibration'&&p.attempts.every(a=>a.phase==='calibration'&&Number.isFinite(a.completedAt)&&a.state!=='pending')));
  const cal=b.calibration.blocks[0],val=b.calibration.blocks[1];
  assert.equal(cal.targets.length,18);assert.equal(val.targets.length,9);
  assert.deepEqual(h.fits[0],cal.targets);assert.deepEqual(b.calibration.currentModel,val.mappingFrozenBeforeValidation);
  assert.ok(cal.targets.every(p=>p.attempts.filter(a=>a.valid).length>=12));
  const late=[...cal.targets,...val.targets].flatMap(p=>p.attempts.filter(a=>a.completedAt>p.collectEnd));
  assert.ok(late.length>0);assert.ok(late.every(a=>a.valid===false&&a.windowReason==='completed_after_collection_window'));
  assert.equal(val.evaluation.attemptCount,val.targets.reduce((n,p)=>n+p.attempts.length,0));
  assert.equal(val.evaluation.pointSummaries.length,9);assert.equal(b.session.samplingSummary.pending,0);
  assert.deepEqual(b.session.cameraImageSize,{width:640,height:480});assert.equal(b.session.preprocessing.id,'fixture-preprocessing');
  assert.match(b.session.timestamps.collection,/Late results stay as invalid attempts/);
  assert.match(h.e('panel').innerHTML,/结论限于这些位置/);assert.match(h.e('panel').innerHTML,/判定原因/);assert.match(h.e('panel').innerHTML,/误差超标/);
  assert.equal(h.app.getState().running,false);assert.equal(h.stops,1);assert.equal(h.closed,1);
});
