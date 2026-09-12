'use strict';

// Regression tests for the revised browser app. No camera, network, npm
// dependencies, or historical experiment scripts are executed by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../shared/gaze-core.js');
const ValidationReport = require('../shared/validation-report.js');
const CalibrationReport = require('../shared/calibration-report.js');
const CalibrationStability = require('../shared/calibration-stability.js');
const CalibrationConsistency = require('../shared/calibration-consistency.js');
const GazeFilter = require('../shared/gaze-filter.js');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '../shared/experiment-v2.js'), 'utf8');

class FakeClock {
  constructor() { this.time = 0; this.nextId = 1; this.jobs = new Map(); this.callbacks = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.jobs.set(id, { callback, at: this.time + Math.max(0, Number(delay) || 0) });
    this.callbacks.set(id, callback);
    return id;
  };
  clearTimeout = id => this.jobs.delete(id);
  requestAnimationFrame = callback => this.setTimeout(() => callback(this.time), 16);
  cancelAnimationFrame = id => this.clearTimeout(id);
  advance(ms) {
    const target = this.time + ms;
    let iterations = 0;
    while (true) {
      const next = [...this.jobs.entries()].filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++iterations < 50000, 'The app must not create an unbounded immediate timer loop');
      this.time = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
  pendingCallbacks() { return [...this.jobs.values()].map(job => job.callback); }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

function landmarksForTarget(x, y, { closed = false } = {}) {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (centerX, indices) => {
    const [a, b, topA, bottomA, topB, bottomB, iris, edgeA, edgeB] = indices;
    const set = (index, px, py) => { points[index] = { x: px, y: py, z: 0 }; };
    set(a, centerX - 0.06, 0.42); set(b, centerX + 0.06, 0.42);
    const aperture = closed ? 0.001 : 0.025;
    set(topA, centerX - 0.01, 0.42 - aperture); set(bottomA, centerX - 0.01, 0.42 + aperture);
    set(topB, centerX + 0.01, 0.42 - aperture); set(bottomB, centerX + 0.01, 0.42 + aperture);
    const irisX = centerX + (x - 0.5) * 0.05;
    const irisY = 0.42 + (y - 0.5) * 0.05;
    set(iris, irisX, irisY); set(edgeA, irisX - 0.02, irisY); set(edgeB, irisX + 0.02, irisY);
  };
  eye(0.30, [33, 133, 159, 145, 158, 153, 468, 469, 471]);
  eye(0.70, [362, 263, 386, 374, 385, 380, 473, 474, 476]);
  return points;
}

function fixture(layout = 'horizontal', { startReady = true, core = Core, search = '?pilot=1' } = {}) {
  const clock = new FakeClock();
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  document.nodes = [];
  class Element extends FakeEventTarget {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.hidden = false;
      this.value = ''; this.dataset = {}; this.currentTime = 0; this.readyState = 4;
      this.videoWidth = 640; this.videoHeight = 480; this.videoCallbacks = new Map();
      document.nodes.push(this);
    }
    append(...elements) { for (const element of elements) { element.parentNode = this; this.children.push(element); } }
    appendChild(element) { this.append(element); return element; }
    replaceChildren(...elements) { this.children = []; this.append(...elements); }
    insertBefore(element, before) { this.children.splice(Math.max(0, this.children.indexOf(before)), 0, element); }
    get lastChild() { return this.children.at(-1); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    getBoundingClientRect() { return { left: 0, top: 0, width: context.innerWidth, height: context.innerHeight }; }
    getContext() { return new Proxy({}, { get: (target, key) => target[key] ?? (() => {}), set: (target, key, value) => { target[key] = value; return true; } }); }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    requestVideoFrameCallback(callback) { const id = this.videoCallbacks.size + 1; this.videoCallbacks.set(id, callback); return id; }
    cancelVideoFrameCallback(id) { this.videoCallbacks.delete(id); }
    click() { this.dispatchEvent({ type: 'click', detail: 0 }); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  }
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.nodes.find(element => element.id === id) || null;
  document.body = new Element('body'); document.body.dataset.layout = layout; document.hidden = false;
  for (const [id, tag] of [['stage','canvas'],['panel','section'],['status','span'],['camera','video'],['ratings','div'],['pause','button'],['save-backup','button'],['save-notice','span']]) {
    const element = new Element(tag); element.id = id; document.body.append(element);
  }
  class ClockDate extends Date {
    constructor(value) { super(value === undefined ? 1700000000000 + clock.now() : value); }
    static now() { return 1700000000000 + clock.now(); }
  }
  const math = Object.create(Math); math.random = () => 0.25;
  const exportedBlobs = [];
  class ExportURL extends URL {
    static createObjectURL(blob) { exportedBlobs.push(blob); return `blob:test/${exportedBlobs.length}`; }
    static revokeObjectURL() {}
  }
  Object.assign(window, { document, devicePixelRatio: 2, isSecureContext: true, GazeCore: core, ValidationReport, CalibrationReport, CalibrationStability, CalibrationConsistency, GazeFilter });
  window.visualViewport = Object.assign(new FakeEventTarget(), { width: 390, height: 844, scale: 1 });
  const context = {
    window, document, GazeCore: core, performance: { now: clock.now, timeOrigin: 1700000000000 },
    Date: ClockDate, Math: math, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    screen: { orientation: { type: 'portrait-primary' } },
    location: { search, href: 'https://localhost/food2/revised.html' },
    navigator: { userAgent: 'integration-test', platform: 'test', language: 'zh-CN' },
    crypto: { randomUUID: () => 'test-run' }, URL: ExportURL, URLSearchParams, Blob, console,
    module: { exports: {} }
  };
  vm.createContext(context); vm.runInContext(APP_SOURCE, context, { filename: 'experiment-v2.js' });
  const api = context.module.exports;
  const app = new api.Experiment(layout);
  // Replace the physical camera boundary, while retaining the real controller,
  // result-processing, calibration, validation, DOM and timer implementation.
  app.runningCamera = startReady; app.cameraStartedPerf = clock.now();
  app.ratingIds = [1, 2]; app.ratingCount = 2; app.trialCount = 2;
  for (const id of app.ratingIds) app.images.set(id, { complete: true, naturalWidth: 200, naturalHeight: 200 });
  if (startReady) app.ready('测试校准');
  const meta = () => ({ start: clock.now(), phaseId: app.phaseId, phase: app.phase,
    trialId: app.trial?.id ?? null, onset: app.trial?.onset ?? null, videoTime: clock.now() / 1000,
    mediaTime: clock.now() / 1000, presentedFrames: app.sampleId + 1,
    target: app.target ? { ...app.target } : null, viewportId: app.viewportId });
  function result(x = 0.5, y = 0.5, options = {}) {
    app.inferenceMeta = options.meta || meta();
    app.onResults({ multiFaceLandmarks: options.noFace ? [] : [landmarksForTarget(x, y, options)] });
    app.inferenceMeta = null;
    return app.gaze.at(-1);
  }
  function runBlock(kind, options = {}) {
    app.startBlock(kind);
    assert.equal(app.phase, kind);
    for (let n = 0; n < 4000 && app.phase === kind; n++) {
      clock.advance(33);
      if (app.phase === kind && app.target) result(app.target.targetX + (options.dx || 0), app.target.targetY + (options.dy || 0), options);
    }
    assert.notEqual(app.phase, kind, 'The target block must finish or fail within its configured deadlines');
    return app.calibrations.at(-1);
  }
  function calibrate() {
    const block = runBlock('calibration');
    assert.equal(block.status, 'complete', JSON.stringify(block.fit));
    assert.equal(app.phase, 'calibration_report');
    return block;
  }
  function validate() {
    const block = runBlock('validation');
    assert.equal(block.evaluation.passed, true, JSON.stringify(block.evaluation.failures));
    assert.equal(app.phase, 'validation_report');
    return block;
  }
  function advanceWithFrames(ms) {
    const end = clock.now() + ms;
    while (clock.now() + 33 <= end) {
      clock.advance(33);
      if (app.runningCamera) result(app.target?.targetX ?? 0.5, app.target?.targetY ?? 0.5);
    }
    clock.advance(end - clock.now());
  }
  function startChoice() {
    calibrate(); validate();
    app.trials = [{ images: [1,2], rating_1: 3, rating_2: 7 }, { images: [2,1], rating_1: 7, rating_2: 3 }];
    app.resumeAction = 'choice'; app.continueAfterValidation(); advanceWithFrames(16 + 850); clock.advance(16);
    assert.equal(app.phase, 'choice'); assert.ok(Number.isFinite(app.trial.onset));
  }
  return { app, api, clock, window, document, context, meta, result, runBlock, calibrate, validate, advanceWithFrames, startChoice, exportedBlobs };
}

function driveUntil(f, predicate, options = {}, limit = 4000) {
  for (let i = 0; i < limit && !predicate(); i++) {
    f.clock.advance(33);
    if (!predicate() && f.app.target) f.result(f.app.target.targetX, f.app.target.targetY, options);
  }
  assert.ok(predicate(), 'Expected controller state was not reached before the bounded fixture deadline');
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

function finishWithRoundMismatch(f, mismatch = true) {
  for(let n=0;n<4000&&f.app.phase==='calibration';n++) {
    f.clock.advance(33);
    const t=f.app.target;
    if(f.app.phase==='calibration'&&t) f.result(t.targetX+(mismatch&&t.targetId==='c9'&&t.roundIndex===2?.4:0),t.targetY);
  }
  assert.equal(f.app.phase,'calibration_report');
  return f.app.block;
}

test('cross-round mismatch blocks model activation and paired recollection preserves every original attempt', async()=>{
  const f=fixture();f.app.startBlock('calibration');
  const block=finishWithRoundMismatch(f);
  assert.equal(block.fit.ok,true);assert.equal(block.consistency.passed,false);
  assert.deepEqual(Array.from(block.consistency.failedTargetIds),['c9']);
  assert.equal(block.status,'needs_recollection');assert.equal(f.app.model,null);
  f.app.startBlock('validation');assert.equal(f.app.phase,'calibration_report');
  assert.ok(!f.app.events.some(e=>e.event==='model_created'));
  const old=block.targets.filter(t=>t.targetId==='c9'),oldSamples=old.map(t=>JSON.stringify(t.attempts));
  const oldIds=old.map(t=>t.presentationId);
  const button=descendants(f.app.panel).find(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('补采这'));
  assert.ok(button);button.click();button.click();
  assert.equal(block.repairCycles.length,1);assert.equal(f.app.phase,'calibration');
  assert.ok(oldIds.every(id=>!block.activePresentationIds.includes(id)));
  finishWithRoundMismatch(f,false);
  assert.equal(block.status,'complete');assert.equal(block.consistency.passed,true);
  assert.equal(block.targets.length,20);assert.equal(block.activePresentationIds.length,18);
  assert.equal(new Set(block.activePresentationIds).size,18);assert.equal(block.consistencyHistory.length,2);
  assert.deepEqual(old.map(t=>JSON.stringify(t.attempts)),oldSamples);
  assert.ok(old.every(t=>t.superseded&&t.supersededBy));
  assert.equal(block.repairCycles[0].status,'complete');assert.equal(f.app.validationOK,false);
  assert.equal(f.app.events.filter(e=>e.event==='model_created').length,1);
  const active=block.targets.filter(t=>block.activePresentationIds.includes(t.presentationId));
  const replay=Core.createRepeatedCalibration(active.flatMap(t=>t.attempts).filter(a=>a.fitEligible),{
    expectedTargets:f.api.CALIBRATION_TARGETS,aggregation:f.app.config.calibrationAggregation,
    minSamplesPerPresentation:f.app.config.minValidFramesPerPoint});
  assert.equal(JSON.stringify(replay),JSON.stringify(block.fit));
  await f.app.download('backup');
  const saved=JSON.parse(await f.exportedBlobs.at(-1).text()).calibration.blocks[0];
  assert.equal(saved.targets.length,20);assert.equal(saved.consistencyHistory.length,2);
  assert.equal(saved.consistencyHistory[0].evaluation.passed,false);
  assert.equal(saved.consistencyHistory[1].evaluation.passed,true);
  f.validate();
});

test('a still-inconsistent replacement pair cannot trigger another repair or activate the model',()=>{
  const f=fixture();f.app.startBlock('calibration');const block=finishWithRoundMismatch(f);
  f.app.repairCalibration(block);finishWithRoundMismatch(f);
  assert.equal(block.status,'failed');assert.equal(block.consistency.passed,false);
  assert.equal(f.app.model,null);assert.equal(f.app.validationOK,false);
  assert.equal(block.repairCycles.length,1);
  f.app.repairCalibration(block);f.app.startBlock('validation');
  assert.equal(f.app.phase,'calibration_report');assert.equal(block.targets.length,20);
  assert.ok(!descendants(f.app.panel).some(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('补采这')));
});

test('pause during paired recollection aborts that cycle and does not reinstate superseded observations',()=>{
  const f=fixture();f.app.startBlock('calibration');const block=finishWithRoundMismatch(f);
  f.app.repairCalibration(block);f.advanceWithFrames(350);
  const planned=Array.from(block.activePresentationIds),count=block.targets.length;
  f.window.dispatchEvent({type:'pagehide'});f.clock.advance(20000);
  assert.equal(f.app.phase,'paused');assert.equal(block.status,'aborted');
  assert.equal(block.repairCycles[0].status,'aborted');assert.equal(block.targets.length,count);
  assert.deepEqual(Array.from(block.activePresentationIds),planned);assert.equal(f.app.model,null);
  assert.ok(!f.app.events.some(e=>e.event==='model_created'));
});

test('recollection timeout closes the cycle before a direct full recalibration',()=>{
  const f=fixture();f.app.startBlock('calibration');const block=finishWithRoundMismatch(f);
  f.app.repairCalibration(block);
  for(let n=0;n<500&&f.app.phase==='calibration';n++) {
    f.clock.advance(33);if(f.app.phase==='calibration')f.result(.5,.5,{noFace:true});
  }
  assert.equal(f.app.phase,'failure');assert.equal(block.status,'failed');
  assert.equal(block.repairCycles[0].status,'failed');
  assert.equal(block.repairCycles[0].reason,'stable_collection_timeout');
  assert.ok(Number.isFinite(block.repairCycles[0].ended));
  const ended=block.repairCycles[0].ended;
  f.app.prepareCalibration();assert.equal(f.app.phase,'preparation');
  assert.equal(block.repairCycles[0].ended,ended);
});

test('even an unrealistically perfect filter cannot admit a failed raw validation or refit the model',()=>{
  const f=fixture();f.calibrate();const model=JSON.stringify(f.app.model);
  // Deliberately inject an oracle as a negative test of admission isolation.
  f.app.kalman={reset(){},update(s){return {x:f.app.target?.targetX??s.x,y:f.app.target?.targetY??s.y,
    timestamp:s.timestamp,valid:s.valid,reset:false,reason:null};}};
  const block=f.runBlock('validation',{dx:.3});
  assert.equal(block.evaluation.passed,false);assert.equal(block.filterComparison.kalman.passed,true);
  assert.equal(f.app.validationOK,false);assert.equal(JSON.stringify(f.app.model),model);
  assert.ok(!descendants(f.app.panel).some(e=>e.tagName==='BUTTON'&&e.textContent==='继续任务'));
  assert.equal(block.filterComparison.raw,block.evaluation);
});

test('actual Kalman outputs reset after missing face and exports keep raw, EMA and Kalman distinct',async()=>{
  const f=fixture();f.calibrate();const block=f.validate();
  for(const method of ['raw','ema','kalman'])assert.equal(block.filterComparison[method].validCount,block.evaluation.validCount);
  f.clock.advance(33);const lost=f.result(.4,.5,{noFace:true});
  assert.equal(lost.valid,false);assert.equal(lost.gaze_x_kalman,null);assert.equal(lost.roi_kalman,'UNKNOWN');
  f.advanceWithFrames(150);f.clock.advance(33);const recovered=f.result(.4,.5);
  assert.equal(recovered.valid,true);assert.ok(Number.isFinite(recovered.gaze_x_kalman));
  await f.app.download('backup');const saved=JSON.parse(await f.exportedBlobs.at(-1).text());
  assert.equal(saved.session.config.kalman.measurementStd,.04);
  assert.equal(saved.calibration.blocks.at(-1).filterComparison.definition,block.filterComparison.definition);
  assert.ok(saved.gaze.some(r=>r.gaze_x_kalman!==null&&r.kalman_timestamp!==null));
});

test('pagehide alone or before visibilitychange pauses every active sampling phase and cancels timers', () => {
  for (const phase of ['preparation','calibration','validation']) for (const withVisibility of [false,true]) {
    const f=fixture();
    if(phase==='preparation')f.app.prepareCalibration();
    else if(phase==='calibration')f.app.startBlock('calibration');
    else {f.calibrate();f.app.startBlock('validation');}
    f.clock.advance(50);
    const block=f.app.block,record=f.app.targetRecord;
    f.window.dispatchEvent({type:'pagehide'});
    if(withVisibility){f.document.hidden=true;f.document.dispatchEvent({type:'visibilitychange'});}
    assert.equal(f.app.phase,'paused');assert.equal(f.app.runningCamera,false);assert.equal(f.app.timer,null);
    if(block){assert.equal(block.status,'aborted');assert.equal(record.status,'aborted');}
    const events=f.app.events.length;f.clock.advance(20000);
    assert.equal(f.app.phase,'paused');assert.equal(f.app.events.length,events);
  }
});

test('two independently ordered rounds retain 18 distinct presentations without overwriting spatial targets', () => {
  const f = fixture(), block = f.calibrate();
  assert.equal(block.targets.length, 18);
  assert.equal(block.presentationPlan.length, 18);
  assert.equal(new Set(block.targets.map(target => target.presentationId)).size, 18);
  assert.equal(new Set(block.targets.map(target => target.targetId)).size, 9);
  const orders = [];
  for (const round of [1, 2]) {
    const records = block.targets.filter(target => target.roundIndex === round);
    assert.equal(records.length, 9);
    assert.equal(new Set(records.map(target => target.targetId)).size, 9);
    orders.push(records.map(target => target.targetId));
    for (const record of records) {
      assert.equal(record.status, 'complete');
      assert.equal(record.presentationId, `${block.id}-r${round}-${record.targetId}`);
      assert.ok(record.attempts.filter(attempt => attempt.valid).length >= 12);
      assert.ok(record.attempts.every(attempt => attempt.targetId === record.targetId &&
        attempt.roundIndex === round && attempt.presentationId === record.presentationId));
    }
  }
  assert.notDeepEqual(orders[0], orders[1], 'Even identical random permutations need an independently distinguishable second order');
  for (let i = 0; i < 18; i++) {
    for (const key of ['targetId', 'roundIndex', 'presentationId']) assert.equal(block.presentationPlan[i][key], block.targets[i][key]);
  }
  assert.equal(block.fit.diagnostics.expectedRoundCount, 2);
  assert.equal(block.fit.diagnostics.expectedTargetCount, 9);
  assert.equal(f.app.model.calibrationRoundCount, 2);
});

test('finishing the first round cannot create a model or unlock validation', () => {
  const f = fixture(); f.app.startBlock('calibration');
  driveUntil(f, () => f.app.target?.roundIndex === 2);
  const block = f.app.calibrations[0];
  assert.equal(block.targets.filter(target => target.status === 'complete').length, 9);
  assert.equal(f.app.phase, 'calibration'); assert.equal(f.app.model, null); assert.equal(f.app.validationOK, false);
  assert.equal(block.fit, undefined);
  f.app.startBlock('validation'); f.app.continueAfterValidation();
  assert.equal(f.app.phase, 'calibration'); assert.equal(f.app.calibrations.length, 1);
  assert.ok(!f.app.events.some(event => event.event === 'model_created'));
});

test('an incomplete second round fails without using a completed first round as a fallback', () => {
  const f = fixture(); f.app.startBlock('calibration');
  driveUntil(f, () => f.app.target?.roundIndex === 2);
  const block = f.app.calibrations[0];
  driveUntil(f, () => f.app.phase === 'failure', { noFace: true });
  assert.equal(block.status, 'failed'); assert.equal(f.app.model, null); assert.equal(f.app.validationOK, false);
  assert.equal(block.targets.filter(target => target.roundIndex === 1 && target.status === 'complete').length, 9);
  const failed = block.targets.at(-1);
  assert.equal(failed.roundIndex, 2); assert.equal(failed.status, 'failed');
  assert.ok(failed.attempts.length >= 12); assert.ok(failed.attempts.every(attempt => !attempt.valid));
  assert.ok(!f.app.events.some(event => event.event === 'model_created'));
});

test('a previous-round callback for the same spatial target cannot enter the new presentation', () => {
  const f = fixture(); f.app.startBlock('calibration'); f.clock.advance(650);
  const old = f.meta(), targetId = f.app.target.targetId;
  driveUntil(f, () => f.app.target?.roundIndex === 2 && f.app.target.targetId === targetId);
  f.clock.advance(650);
  const record = f.app.targetRecord, count = record.attempts.length;
  const stale = f.result(0.5, 0.5, { meta: old });
  assert.equal(stale.valid, false); assert.equal(stale.phase_match, false);
  assert.equal(stale.valid_reason, 'stale_phase', 'Phase mismatch takes precedence over presentation mismatch');
  assert.equal(stale.calibration_round, 2); assert.equal(stale.target_presentation_id, record.presentationId);
  assert.equal(stale.inference_calibration_round, 1); assert.equal(stale.inference_target_presentation_id, old.target.presentationId);
  assert.equal(record.attempts.length, count);
  // Check the presentation guard independently from the existing phase token:
  // a matching current phase still must not accept a round-1 presentation id.
  f.clock.advance(33);
  const mismatchedPresentation = { ...f.meta(), target: { ...old.target } };
  const mismatched = f.result(record.targetX, record.targetY, { meta: mismatchedPresentation });
  assert.equal(mismatched.phase_match, true); assert.equal(mismatched.valid, false);
  assert.equal(mismatched.valid_reason, 'stale_target_presentation');
  assert.equal(mismatched.calibration_round, 2); assert.equal(mismatched.target_presentation_id, record.presentationId);
  assert.equal(mismatched.inference_calibration_round, 1);
  assert.equal(mismatched.inference_target_presentation_id, old.target.presentationId);
  assert.equal(record.attempts.length, count);
  f.clock.advance(33);
  const current = f.result(record.targetX, record.targetY);
  assert.equal(record.attempts.length, count + 1);
  assert.equal(current.calibration_round, 2); assert.equal(current.target_presentation_id, record.presentationId);
  assert.equal(current.inference_calibration_round, 2);
  assert.equal(current.inference_target_presentation_id, record.presentationId);
  assert.equal(record.attempts.at(-1).presentationId, record.presentationId);
});

test('calibration diagnostics require the independent validation action and cannot directly start the task', () => {
  const f = fixture(), block = f.calibrate();
  assert.equal(f.app.block, block); assert.equal(f.app.validationOK, false);
  const nodes = descendants(f.app.panel), text = nodes.map(node => node.textContent || '').join('\n');
  assert.match(text, /校准诊断/); assert.match(text, /不是独立精度验证/);
  assert.ok(nodes.some(node => node.tagName === 'DETAILS'));
  const buttons = nodes.filter(node => node.tagName === 'BUTTON');
  assert.ok(!buttons.some(node => /继续任务/.test(node.textContent)));
  const validate = buttons.find(node => node.textContent === '开始独立验证'); assert.ok(validate);
  f.app.continueAfterValidation(); f.app.startChoice(); f.app.startRating();
  assert.equal(f.app.ratings.length, 0); assert.equal(f.app.behavior.length, 0);
  assert.ok(!f.app.events.some(event => ['stimulus_onset', 'rating_onset'].includes(event.event)));
  // Call the captured button itself: the task must enter validation, not rating.
  validate.click(); assert.equal(f.app.phase, 'validation');
});

test('a reported failure in an additional candidate cannot block an already fitted selected mapping', () => {
  let injectedCandidateId = null;
  const coreBoundary = { ...Core, createRepeatedCalibration(samples, options) {
    const fit = Core.createRepeatedCalibration(samples, options);
    assert.equal(fit.ok, true);
    // Only inject a diagnostic failure at the app/core boundary. The 18-target
    // collection, selected fit and later validation remain real implementations.
    // Core-level candidate eligibility and selection have their own regressions.
    const additional = fit.diagnostics.candidates.find(candidate => candidate.id !== fit.diagnostics.selectedCandidateId);
    injectedCandidateId = additional.id;
    additional.ok = false; additional.reason = 'injected_optional_candidate_failure'; additional.score = null;
    return fit;
  } };
  const f = fixture('horizontal', { core: coreBoundary }), block = f.calibrate();
  assert.equal(block.fit.ok, true, JSON.stringify(block.fit));
  assert.equal(f.app.phase, 'calibration_report');
  const candidates = block.fit.diagnostics.candidates;
  assert.equal(candidates.find(candidate => candidate.id === injectedCandidateId).ok, false);
  assert.equal(candidates.find(candidate => candidate.id === block.fit.diagnostics.selectedCandidateId).ok, true);
  const validation = f.validate();
  assert.equal(validation.evaluation.passed, true, JSON.stringify(validation.evaluation));
});

test('held-out validation never refits or selects a different frozen calibration model', () => {
  const f = fixture(), block = f.calibrate();
  const snapshot = JSON.stringify(f.app.model), hash = f.app.modelHash;
  const comparison = JSON.stringify(block.fit.diagnostics.candidates);
  const candidate = block.fit.diagnostics.selectedCandidateId;
  const failed = f.runBlock('validation', { dy: 0.3 });
  assert.equal(failed.evaluation.passed, false);
  assert.equal(JSON.stringify(f.app.model), snapshot); assert.equal(f.app.modelHash, hash);
  assert.equal(block.fit.diagnostics.selectedCandidateId, candidate);
  assert.equal(JSON.stringify(block.fit.diagnostics.candidates), comparison);
  f.validate();
  assert.equal(JSON.stringify(f.app.model), snapshot); assert.equal(f.app.modelHash, hash);
  assert.equal(f.app.events.filter(event => event.event === 'model_created').length, 1);
});

test('complete exports retain both rounds, every invalid attempt, model candidates and per-point calibration diagnostics', async () => {
  const f = fixture(); f.app.startBlock('calibration'); const blinkPresentations = new Set();
  while (f.app.phase === 'calibration') {
    f.clock.advance(33);
    if (f.app.phase !== 'calibration' || !f.app.target) break;
    const target = f.app.target;
    const closed = f.clock.now() >= f.app.targetRecord.collectStart && !blinkPresentations.has(target.presentationId);
    if (closed) blinkPresentations.add(target.presentationId);
    f.result(target.targetX, target.targetY, { closed });
  }
  const block = f.app.calibrations[0];
  assert.equal(block.fit.ok, true); assert.equal(blinkPresentations.size, 18);
  await f.app.download('backup');
  const backup = JSON.parse(await f.exportedBlobs.at(-1).text()), saved = backup.calibration.blocks[0];
  assert.equal(backup.session.appVersion, '2.3.0');
  assert.equal(saved.targets.length, 18); assert.equal(saved.presentationPlan.length, 18);
  assert.deepEqual(saved.targets, JSON.parse(JSON.stringify(block.targets)));
  assert.equal(saved.fit.diagnostics.candidates.length, 2);
  assert.ok(saved.fit.diagnostics.candidates.every(candidate => candidate.folds.length === 2));
  assert.equal(saved.fit.diagnostics.perTargetFit.length, 9);
  assert.ok(saved.fit.diagnostics.perTargetFit.every(point => point.roundMeans.length === 2));
  assert.ok(Number.isFinite(saved.fit.diagnostics.trainingMetrics.meanErrorNorm));
  assert.ok(saved.targets.every(record => record.attempts.some(attempt => !attempt.valid && attempt.reason === 'temporal_recovery')));
  const validCount = saved.targets.flatMap(record => record.attempts).filter(attempt => attempt.fitEligible).length;
  assert.equal(saved.fit.diagnostics.validCount, validCount);
  const rows = backup.gaze.filter(row => row.phase === 'calibration');
  assert.equal(new Set(rows.map(row => row.target_presentation_id)).size, 18);
  assert.ok(rows.some(row => row.calibration_round === 1) && rows.some(row => row.calibration_round === 2));
  assert.ok(rows.some(row => !row.temporal_quality_valid && row.quality_valid));
});

test('real multi-point calibration does not admit a failed held-out validation', () => {
  const f = fixture(); f.calibrate();
  const block = f.runBlock('validation', { dx: 0.4 });
  assert.equal(block.evaluation.passed, false);
  assert.equal(f.app.validationOK, false);
  f.app.continueAfterValidation(); f.app.continueAfterValidation(); f.clock.advance(5000);
  assert.equal(f.app.phase, 'validation_report');
  assert.equal(f.app.behavior.length, 0); assert.equal(f.app.ratings.length, 0);
  assert.ok(!f.app.events.some(event => ['stimulus_onset', 'rating_onset'].includes(event.event)));
});

test('a no-face calibration times out with retained attempts instead of silently passing', () => {
  const f = fixture(); const block = f.runBlock('calibration', { noFace: true });
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.model, null); assert.equal(f.app.validationOK, false);
  assert.equal(block.status, 'failed'); assert.ok(block.targets[0].attempts.length > 12);
  assert.ok(block.targets[0].attempts.every(attempt => attempt.valid === false && attempt.reason === 'no_face'));
  assert.ok(f.app.gaze.every(row => row.face_detected === false));
});

test('full rating-to-choice flow requires revalidation and admits repeated input only once', () => {
  const f = fixture(); f.calibrate(); f.validate();
  f.app.continueAfterValidation(); const token = f.app.token;
  f.app.continueAfterValidation(); assert.equal(f.app.token, token);
  f.clock.advance(1100); assert.equal(f.app.phase, 'rating');
  f.app.rate(3, f.clock.now(), 'pointer'); f.app.rate(9, f.clock.now(), 'pointer');
  assert.equal(f.app.ratings.length, 1); assert.equal(f.app.ratings[0].rating, 3);
  const expiredFeedback = f.clock.pendingCallbacks();
  f.clock.advance(1400); assert.equal(f.app.phase, 'rating');
  const ratingOnset = f.app.rating.onset;
  for (const callback of expiredFeedback) callback();
  assert.equal(f.app.rating.onset, ratingOnset);
  f.app.rate(7, f.clock.now(), 'pointer'); f.clock.advance(300);
  assert.equal(f.app.phase, 'ready'); assert.equal(f.app.validationOK, false);
  f.app.startChoice(); f.clock.advance(1200); assert.equal(f.app.phase, 'ready');
  assert.ok(!f.app.events.some(event => event.event === 'stimulus_onset'));
  f.validate(); f.app.continueAfterValidation(); f.app.continueAfterValidation(); f.clock.advance(1100);
  const trialId = f.app.trial.id, onset = f.app.trial.onset;
  f.clock.advance(120); f.app.respond(1, f.clock.now(), 'pointer'); f.app.respond(2, f.clock.now(), 'pointer');
  assert.equal(f.app.behavior.length, 1); assert.equal(f.app.behavior[0].trial_id, trialId);
  assert.equal(f.app.behavior[0].onset_timestamp, onset); assert.equal(f.app.behavior[0].choice, 1);
  assert.equal(f.app.events.filter(event => event.event === 'stimulus_onset' && event.detail.trial_id === trialId).length, 1);
});

test('no-face rows retain the fixed schema, reset smoothing and do not carry old gaze', () => {
  const f = fixture(); f.startChoice();
  const a = f.app.aois[0], x = (a.x + a.width / 2) / f.app.width, y = (a.y + a.height / 2) / f.app.height;
  const good = f.result(x, y); assert.equal(good.valid, true);
  f.clock.advance(33); const missing = f.result(0, 0, { noFace: true });
  assert.deepEqual(Object.keys(missing).sort(), Object.keys(good).sort());
  assert.equal(missing.valid, false); assert.equal(missing.valid_reason, 'no_face');
  assert.equal(missing.gaze_x_raw, null); assert.equal(missing.gaze_y_smooth, null); assert.equal(missing.roi_raw, 'UNKNOWN');
  assert.equal(f.app.smoothed, null);
  f.clock.advance(33); const recovering = f.result(0.74, 0.47);
  assert.equal(recovering.valid, false); assert.equal(recovering.quality_valid, true);
  assert.equal(recovering.gaze_y_smooth, null); assert.ok(Number.isFinite(recovering.gaze_x_raw));
  f.clock.advance(34); f.result(0.74, 0.47);
  f.clock.advance(33); const recovered = f.result(0.74, 0.47);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.gaze_x_smooth, recovered.gaze_x_raw);
  const text = f.api.csv([good, missing, recovered], f.api.GAZE_HEADERS);
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0].replace(/^\uFEFF/, '').split(',').length, f.api.GAZE_HEADERS.length);
  assert.ok(lines.slice(1).every(line => line.split(',').length === f.api.GAZE_HEADERS.length));
  assert.ok(!text.includes('undefined') && !text.includes('NaN'));
  assert.ok(!f.api.GAZE_HEADERS.some(header => /pupil/i.test(header)));
});

test('both layouts use real rectangles; outside-image predictions remain unclipped', () => {
  for (const layout of ['horizontal', 'vertical']) {
    const f = fixture(layout); f.startChoice();
    for (const [index, a] of f.app.aois.entries()) {
      f.clock.advance(33);
      const x = (a.x + a.width / 2) / f.app.width, y = (a.y + a.height / 2) / f.app.height;
      const row = f.result(x, y); assert.equal(row.roi_raw, String(index + 1));
    }
    const a = f.app.aois[0]; const centerX = (a.x + a.width / 2) / f.app.width;
    f.clock.advance(33);
    const outside = f.result(centerX, -0.2);
    assert.equal(outside.valid, true); assert.equal(outside.roi_raw, '0');
    assert.equal(outside.offscreen, true); assert.ok(outside.gaze_y_raw < 0, 'Unclipped evidence must not be replaced by the screen edge');
    assert.notEqual(outside.horizontal_band, '0');
  }
});

test('actual result logs integrate elapsed time without bridging invalid or long gaps', () => {
  const f = fixture(); f.startChoice();
  const onset = f.app.trial.onset; const initial = f.clock.now();
  const a = f.app.aois[0], x = (a.x + a.width / 2) / f.app.width, y = (a.y + a.height / 2) / f.app.height;
  f.result(x, y); f.clock.advance(40); f.result(x, y);
  f.clock.advance(30); f.result(x, y, { noFace: true });
  f.clock.advance(30); f.result(x, y); f.clock.advance(40); f.result(x, y);
  f.clock.advance(30); f.result(x, y); f.clock.advance(40); f.result(x, y);
  f.clock.advance(500); f.result(x, y); f.clock.advance(40); f.result(x, y);
  f.clock.advance(20); const response = f.clock.now(); f.app.respond(1, response, 'test');
  const row = f.app.behavior[0];
  assert.equal(row.roi1_ms, 120); assert.equal(row.roi2_ms, 0); assert.equal(row.other_ms, 0);
  assert.equal(row.rt_ms, response - onset); assert.ok(initial >= onset);
  assert.equal(row.roi1_ms + row.roi2_ms + row.other_ms + row.unknown_ms, row.rt_ms);
  assert.ok(row.unknown_ms >= 580); assert.equal(row.max_gap_ms, 500);
});

test('pause and viewport changes abort once and invalidate pending callbacks', () => {
  for (const reason of ['user_pause', 'resize', 'page_hidden']) {
    const f = fixture(); f.startChoice(); const trialId = f.app.trial.id;
    f.app.later(50, () => f.app.startChoice()); const expired = f.clock.pendingCallbacks();
    f.clock.advance(20);
    if (reason === 'resize') { f.context.innerHeight = 700; f.window.visualViewport.height = 700; f.window.dispatchEvent({ type: 'resize' }); }
    else if (reason === 'page_hidden') { f.document.hidden = true; f.document.dispatchEvent({ type: 'visibilitychange' }); }
    else f.app.pause(reason);
    assert.equal(f.app.phase, 'paused'); assert.equal(f.app.validationOK, false); assert.equal(f.app.runningCamera, false);
    assert.equal(f.app.behavior.length, 1); assert.equal(f.app.behavior[0].status, 'aborted');
    assert.equal(f.app.behavior[0].trial_id, trialId); assert.equal(f.app.behavior[0].abort_reason, reason);
    for (const callback of expired) callback(); f.clock.advance(3000);
    assert.equal(f.app.phase, 'paused'); assert.equal(f.app.behavior.length, 1);
    assert.equal(f.app.events.filter(event => event.event === 'stimulus_onset').length, 1);
    if (reason === 'resize') assert.equal(f.app.height, 700);
  }
});

test('a result submitted for the previous target cannot enter a new calibration target', () => {
  const f = fixture(); f.app.startBlock('calibration'); f.clock.advance(650);
  const old = f.meta(); const firstId = f.app.target.targetId;
  driveUntil(f, () => f.app.target?.targetId !== firstId);
  assert.notEqual(f.app.target.targetId, firstId);
  const count = f.app.targetRecord.attempts.length;
  const row = f.result(0.5, 0.5, { meta: old });
  assert.equal(row.phase_match, false); assert.equal(row.valid, false); assert.equal(row.valid_reason, 'stale_phase');
  assert.equal(f.app.targetRecord.attempts.length, count);
});

test('a frame submitted before stimulus draw cannot become a valid decision sample', () => {
  const f = fixture(); f.calibrate(); f.validate();
  f.app.trials = [{ images: [1,2], rating_1: 3, rating_2: 7 }]; f.app.resumeAction = 'choice';
  f.app.continueAfterValidation(); f.clock.advance(16 + 850);
  assert.equal(f.app.phase, 'choice'); assert.equal(f.app.trial.onset, null);
  const old = f.meta(); f.clock.advance(16); assert.ok(Number.isFinite(f.app.trial.onset));
  const row = f.result(0.26, 0.47, { meta: old });
  assert.equal(row.valid, false, 'The model image predates the stimulus, even though its callback is in the choice phase');
  assert.equal(row.roi_raw, 'UNKNOWN');
  assert.ok(['pre_stimulus','pre_stimulus_frame','stale_phase'].includes(row.valid_reason));
});

test('post-blink frames keep raw evidence but cannot enter calibration, validation or AOI totals', () => {
  for (const phase of ['calibration', 'validation', 'choice']) {
    const f = fixture();
    if (phase === 'choice') f.startChoice();
    else {
      if (phase === 'validation') f.calibrate();
      f.app.startBlock(phase); f.clock.advance(650);
    }
    const target = f.app.target;
    const a = f.app.aois[0];
    const x = target?.targetX ?? (a.x + a.width / 2) / f.app.width;
    const y = target?.targetY ?? (a.y + a.height / 2) / f.app.height;
    const blinkTime = f.clock.now();
    const closed = f.result(x, y, { closed: true });
    assert.equal(closed.quality_valid, false);
    for (const delay of [13, 14, 52]) {
      f.clock.advance(blinkTime + delay - f.clock.now());
      const row = f.result(x, y);
      assert.equal(row.quality_valid, true); assert.equal(row.temporal_quality_valid, false);
      assert.equal(row.temporal_quality_reason, 'temporal_recovery'); assert.equal(row.valid, false);
      assert.equal(row.temporal_ms_since_invalid, delay); assert.ok(Number.isFinite(row.feature_ly));
      assert.equal(row.roi_raw, 'UNKNOWN'); assert.equal(row.gaze_y_smooth, null);
      if (phase !== 'calibration') assert.ok(Number.isFinite(row.gaze_y_raw));
      if (target) {
        const attempt = f.app.targetRecord.attempts.at(-1);
        assert.equal(attempt.sampleId, row.sample_id); assert.equal(attempt.valid, false);
        assert.equal(attempt.reason, 'temporal_recovery'); assert.equal(attempt.features.length, 4);
      }
    }
    f.clock.advance(blinkTime + 100 - f.clock.now());
    const recovered = f.result(x, y);
    assert.equal(recovered.temporal_quality_valid, true);
    if (target) assert.equal(f.app.targetRecord.attempts.at(-1).valid, true);
    else {
      assert.equal(recovered.valid, true); f.clock.advance(20); f.app.respond(1, f.clock.now(), 'test');
      assert.equal(f.app.behavior[0].roi1_ms, 0, 'Recovery frames cannot create a dwell interval');
      assert.equal(f.app.behavior[0].unknown_ms, f.app.behavior[0].rt_ms);
    }
  }
});

test('target transitions preserve recovery and retired-camera callbacks cannot change its clock', () => {
  const f = fixture(); f.app.startBlock('calibration'); f.clock.advance(650);
  const oldMeta = f.meta(), oldId = f.app.target.targetId;
  f.result(0.5, 0.5, { closed: true });
  f.app.targetIndex++; f.app.nextTarget();
  assert.notEqual(f.app.target.targetId, oldId);
  f.clock.advance(13); const recovering = f.result(f.app.target.targetX, f.app.target.targetY);
  assert.equal(recovering.temporal_quality_valid, false); assert.equal(recovering.temporal_ms_since_invalid, 13);
  f.clock.advance(1);
  f.app.onResults({ multiFaceLandmarks: [] }, oldMeta, { retired: true });
  assert.equal(f.app.gaze.at(-1).temporal_quality_reason, 'stale_camera');
  f.clock.advance(38); f.result(f.app.target.targetX, f.app.target.targetY);
  f.clock.advance(48); const recovered = f.result(f.app.target.targetX, f.app.target.targetY);
  assert.equal(recovered.temporal_quality_valid, true);
  assert.equal(recovered.temporal_ms_since_invalid, 100, 'Retired no-face results must not extend active recovery');
  assert.equal(f.app.targetRecord.attempts.length, 0, 'Settle and retired frames cannot become collected target attempts');
});

test('camera stop resets recovery so a new real startup can accept its first healthy frame', async () => {
  const f = fixture(); f.result(0.5, 0.5, { closed: true });
  f.clock.advance(13); assert.equal(f.result().temporal_quality_valid, false);
  f.app.pause('user_pause');
  const { meshes, tracks } = installStartupBoundary(f);
  await f.app.start(); assert.equal(f.app.phase, 'starting');
  f.clock.advance(1); await f.app.cameraFrame({ mediaTime: 0, presentedFrames: 1 });
  meshes[0].callback({ multiFaceLandmarks: [landmarksForTarget(0.5, 0.5)] });
  assert.equal(f.app.phase, 'ready'); assert.equal(f.app.gaze.at(-1).temporal_quality_valid, true);
  assert.equal(f.app.gaze.at(-1).temporal_ms_since_invalid, null);
  assert.equal(tracks[0].stopped, false); assert.equal(meshes[0].closed, false);
});

test('diagnostic JSON retains recovery attempts and evaluates coverage with every logged attempt', async () => {
  const f = fixture(); f.calibrate(); f.app.startBlock('validation');
  const blinkTargets = new Set();
  while (f.app.phase === 'validation') {
    f.clock.advance(33);
    if (f.app.phase !== 'validation' || !f.app.target) break;
    const target = f.app.target, collecting = f.clock.now() >= f.app.targetRecord.collectStart;
    const closed = collecting && !blinkTargets.has(target.targetId);
    if (closed) blinkTargets.add(target.targetId);
    f.result(target.targetX, target.targetY, { closed });
  }
  assert.equal(blinkTargets.size, 9);
  const block = f.app.calibrations.at(-1), attempts = block.targets.flatMap(target => target.attempts);
  const invalid = attempts.filter(attempt => !attempt.valid);
  assert.ok(invalid.some(attempt => attempt.reason === 'temporal_recovery'));
  assert.ok(invalid.some(attempt => attempt.reason === 'eye_closed_or_occluded'));
  assert.equal(block.evaluation.attemptCount, attempts.length);
  assert.equal(block.evaluation.validCount, attempts.length - invalid.length);
  for (const point of block.evaluation.pointSummaries) {
    const recorded = attempts.filter(attempt => attempt.targetId === point.targetId);
    assert.equal(point.attemptCount, recorded.length);
    assert.equal(point.coverage, recorded.filter(attempt => attempt.valid).length / recorded.length);
  }
  await f.app.download('backup');
  const backup = JSON.parse(await f.exportedBlobs.at(-1).text());
  assert.equal(backup.session.appVersion, '2.3.0');
  const saved = backup.calibration.blocks.at(-1);
  assert.deepEqual(saved.targets.flatMap(target => target.attempts), JSON.parse(JSON.stringify(attempts)));
  const recovery = backup.gaze.filter(row => row.temporal_quality_reason === 'temporal_recovery');
  assert.ok(recovery.length > 0);
  assert.ok(recovery.every(row => row.quality_valid && !row.temporal_quality_valid && !row.valid));
});

test('canvas CSS size, viewport history and rendered targets share current CSS pixel dimensions', () => {
  const f = fixture();
  for (const [width, height] of [[390, 844], [390, 700]]) {
    f.context.innerWidth = width; f.context.innerHeight = height;
    f.window.visualViewport.width = width; f.window.visualViewport.height = height;
    f.app.resizeCanvas('test_resize');
    assert.equal(f.app.canvas.style.width, `${width}px`); assert.equal(f.app.canvas.style.height, `${height}px`);
    assert.equal(f.app.canvas.width, width * 2); assert.equal(f.app.canvas.height, height * 2);
    const viewport = f.app.session().viewportHistory.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(viewport.canvasRect)), { left: 0, top: 0, width, height });
    f.app.ready('测试校准'); f.app.startBlock('calibration'); f.clock.advance(16);
    const target = f.app.targetRecord;
    assert.equal(target.renderedTargetCss.x, target.targetX * width);
    assert.equal(target.renderedTargetCss.y, target.targetY * height);
    assert.deepEqual(target.canvasRect, viewport.canvasRect);
    const onset = f.app.events.filter(event => event.event === 'target_onset').at(-1);
    assert.deepEqual(onset.detail.rendered_target_css, target.renderedTargetCss);
  }
});

test('a locally failed point explains its Chinese reason in the DOM without a continue button', () => {
  const f = fixture(); f.calibrate(); f.app.startBlock('validation');
  const failedId = f.app.target.targetId;
  while (f.app.phase === 'validation') {
    f.clock.advance(33);
    if (f.app.phase !== 'validation' || !f.app.target) break;
    const target = f.app.target;
    f.result(target.targetX + (target.targetId === failedId ? 0.16 : 0), target.targetY);
  }
  const evaluation = f.app.calibrations.at(-1).evaluation;
  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.meanAbsErrorX < 0.10 && evaluation.meanErrorNorm < 0.12);
  assert.ok(!evaluation.failures.includes('meanAbsErrorX_exceeded'));
  assert.ok(evaluation.pointSummaries.find(point => point.targetId === failedId).failures.includes('point_x_mean_error'));
  const descendants = element => [element, ...element.children.flatMap(descendants)];
  const panelNodes = descendants(f.app.panel), text = panelNodes.map(node => node.textContent || '').join('\n');
  assert.match(text, /独立验证未通过/); assert.match(text, /逐点通过：8\/9 个点。各点均须达标/);
  assert.match(text, /X 平均绝对误差.*此项未通过/); assert.match(text, /门槛/);
  assert.ok(panelNodes.some(node => node.tagName === 'DETAILS'));
  assert.ok(!panelNodes.some(node => node.tagName === 'BUTTON' && /继续任务/.test(node.textContent)));
  f.app.continueAfterValidation(); assert.equal(f.app.phase, 'validation_report');
});

test('real startup awaits model initialization, bounds the first callback, and rejects retired model results', async () => {
  const f = fixture('horizontal', { startReady: false });
  const meshes = [], tracks = [];
  let releaseInitialize;
  const initialization = new Promise(resolve => { releaseInitialize = resolve; });
  class FakeMesh {
    constructor() { this.index = meshes.length; this.sent = 0; this.closed = false; meshes.push(this); }
    setOptions(options) { this.options = options; }
    onResults(callback) { this.callback = callback; }
    initialize() { this.initializeCalled = true; return this.index === 0 ? initialization : Promise.resolve(); }
    send() { this.sent++; return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  f.window.FaceMesh = f.context.FaceMesh = FakeMesh;
  f.context.navigator.mediaDevices = { getUserMedia: async () => {
    const track = new FakeEventTarget(); track.stopped = false;
    track.stop = () => { track.stopped = true; }; track.getSettings = () => ({ width: 640, height: 480, frameRate: 30 });
    tracks.push(track); return { getTracks: () => [track], getVideoTracks: () => [track] };
  } };
  const starting = f.app.start();
  for (let i = 0; i < 30 && !meshes[0]?.initializeCalled; i++) await Promise.resolve();
  assert.ok(meshes[0], JSON.stringify(f.app.events.slice(-3)));
  assert.equal(meshes[0].initializeCalled, true); assert.equal(f.app.phase, 'starting');
  assert.equal(f.app.runningCamera, false); assert.equal(meshes[0].sent, 0);
  f.clock.advance(1000); releaseInitialize(); await starting;
  assert.equal(f.app.phase, 'starting'); assert.equal(f.app.runningCamera, true);
  await f.app.cameraFrame({ mediaTime: 0, presentedFrames: 1 });
  assert.equal(meshes[0].sent, 1);
  f.clock.advance(f.app.config.cameraStartupTimeoutMs + 1);
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.runningCamera, false);
  assert.equal(tracks[0].stopped, true); assert.equal(meshes[0].closed, true);
  assert.ok(f.app.events.some(event => event.event === 'failure' && event.detail.code === 'first_callback_timeout'));
  meshes[0].callback({ multiFaceLandmarks: [] });
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.gaze.at(-1).valid_reason, 'stale_phase');
  await f.app.start(); assert.equal(meshes.length, 2); assert.equal(f.app.phase, 'starting');
  meshes[0].callback({ multiFaceLandmarks: [landmarksForTarget(0.5, 0.5)] });
  assert.equal(f.app.phase, 'starting', 'A retired model callback must not unlock a new camera session');
  await f.app.cameraFrame({ mediaTime: 0, presentedFrames: 1 });
  meshes[1].callback({ multiFaceLandmarks: [] });
  assert.equal(f.app.phase, 'ready');
  assert.equal(f.app.gaze.at(-1).face_detected, false, 'Camera readiness does not assert valid gaze or accuracy');
  f.clock.advance(f.app.config.callbackGapPauseMs + 100);
  assert.equal(f.app.phase, 'paused'); assert.equal(f.app.runningCamera, false);
  assert.ok(f.app.events.some(event => event.event === 'pause' && event.detail.reason === 'camera_callback_gap'));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, explanation = 'Expected asynchronous startup step') {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), explanation);
}

function installStartupBoundary(f, { initialize = () => Promise.resolve(), permission } = {}) {
  const meshes = [], tracks = [];
  class FakeMesh {
    constructor() { this.index = meshes.length; this.closed = false; meshes.push(this); }
    setOptions() {}
    onResults(callback) { this.callback = callback; }
    initialize() { this.initializeCalled = true; return initialize(this); }
    send() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const stream = () => {
    const track = new FakeEventTarget(); track.stopped = false;
    track.stop = () => { track.stopped = true; };
    track.getSettings = () => ({ width: 640, height: 480, frameRate: 30 });
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  f.window.FaceMesh = f.context.FaceMesh = FakeMesh;
  f.context.navigator.mediaDevices = { getUserMedia: permission || (async () => stream()) };
  return { meshes, tracks, stream };
}

function installControlledImages(f, { synchronousLoad = false } = {}) {
  const created = [], requests = [];
  class ControlledImage {
    constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; created.push(this); }
    set src(value) {
      this.source = value;
      if (value) {
        requests.push(value);
        if (synchronousLoad) {
          assert.equal(typeof this.onload, 'function', 'Attach load handling before assigning a cached image source');
          assert.equal(typeof this.onerror, 'function', 'Attach error handling before assigning an image source');
          this.load();
        }
      }
    }
    get src() { return this.source; }
    removeAttribute(name) { if (name === 'src') this.source = ''; }
    load() { this.complete = true; this.naturalWidth = this.naturalHeight = 200; this.onload?.({ type: 'load' }); }
  }
  f.context.Image = f.window.Image = ControlledImage;
  return { created, requests };
}

test('a first model download longer than 20 seconds can finish without a false camera timeout', async () => {
  const f = fixture('horizontal', { startReady: false });
  const initialization = deferred();
  const { meshes } = installStartupBoundary(f, { initialize: () => initialization.promise });
  const starting = f.app.start();
  await flushUntil(() => meshes[0]?.initializeCalled);
  assert.equal(f.app.startupStageInfo.name, 'model');
  f.clock.advance(25000);
  assert.equal(f.app.phase, 'starting', 'Slow model download must receive its own deadline');
  assert.equal(f.app.runningCamera, false);
  initialization.resolve(); await starting;
  assert.equal(f.app.startupStageInfo.name, 'first_result');
  await f.app.cameraFrame({ mediaTime: 0, presentedFrames: 1 });
  meshes[0].callback({ multiFaceLandmarks: [] });
  assert.equal(f.app.phase, 'ready');
  assert.ok(!f.app.events.some(event => event.event === 'failure'));
});

test('a stalled model reports the model deadline and retires its late initialization safely', async () => {
  const f = fixture('horizontal', { startReady: false });
  const initialization = deferred();
  const { meshes, tracks } = installStartupBoundary(f, { initialize: () => initialization.promise });
  const starting = f.app.start();
  await flushUntil(() => meshes[0]?.initializeCalled);
  f.clock.advance(f.app.config.modelLoadTimeoutMs + 1);
  assert.equal(f.app.phase, 'failure'); assert.equal(tracks[0].stopped, true);
  const failure = f.app.events.find(event => event.event === 'failure');
  assert.equal(failure.detail.code, 'model_timeout');
  assert.equal(meshes[0].closed, false, 'Do not close a model while its initializer is mutating WASM state');
  initialization.resolve(); await starting;
  await flushUntil(() => meshes[0].closed, 'Retired initialization must release its model after settlement');
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.runningCamera, false);
});

test('camera permission approved after its deadline closes the late stream without starting a model', async () => {
  const f = fixture('horizontal', { startReady: false });
  const permission = deferred();
  const { meshes, tracks, stream } = installStartupBoundary(f, { permission: () => permission.promise });
  const starting = f.app.start();
  assert.equal(f.app.startupStageInfo.name, 'permission');
  f.clock.advance(f.app.config.permissionTimeoutMs + 1);
  assert.equal(f.app.phase, 'failure');
  assert.equal(f.app.events.find(event => event.event === 'failure').detail.code, 'permission_timeout');
  permission.resolve(stream()); await starting;
  assert.equal(tracks.length, 1); assert.equal(tracks[0].stopped, true);
  assert.equal(meshes.length, 0); assert.equal(f.app.video.srcObject, null);
  assert.equal(f.app.phase, 'failure');
});

test('a stalled food image reports its image ID and ends within the per-image deadline', async () => {
  const f = fixture('horizontal', { startReady: false });
  f.app.images.clear(); installStartupBoundary(f);
  const { requests } = installControlledImages(f);
  const starting = f.app.start();
  await flushUntil(() => requests.length > 0);
  assert.equal(f.app.startupStageInfo.name, 'images');
  f.clock.advance(f.app.config.imageLoadTimeoutMs + 1);
  await starting;
  assert.equal(f.app.phase, 'failure');
  const failure = f.app.events.find(event => event.event === 'failure');
  assert.equal(failure.detail.code, 'image_load_timeout');
  assert.match(failure.detail.message, /1/, 'The failed image must be identifiable in the diagnostic');
  assert.equal(f.app.images.size, 0);
  assert.equal(f.app.imageLoadCancels.size, 0, 'Failure must release remaining pending image handlers');
});

test('cancelling image preparation stops its queue and rejects late cache writes', async () => {
  const f = fixture('horizontal', { startReady: false });
  f.app.images.clear(); f.app.ratingIds = [1,2,3,4,5,6,7,8];
  installStartupBoundary(f);
  const { created, requests } = installControlledImages(f);
  const starting = f.app.start();
  await flushUntil(() => requests.length === 4, 'Preparation must bound image downloads to four workers');
  const lateHandlers = created.map(image => image.onload);
  f.app.pause('startup_cancel');
  assert.equal(f.app.phase, 'paused'); assert.equal(f.app.imageLoadCancels.size, 0);
  for (const handler of lateHandlers) handler?.({ type: 'load' });
  await starting;
  f.clock.advance(f.app.config.imageLoadTimeoutMs + 1);
  assert.equal(requests.length, 4, 'Cancelled workers must not request the next queued images');
  assert.equal(f.app.images.size, 0, 'Retired image completions must not populate the shared cache');
  assert.equal(f.app.phase, 'paused');
});

test('synchronously cached images settle once with handlers registered before src assignment', async () => {
  const f = fixture('horizontal', { startReady: false });
  f.app.images.clear(); installStartupBoundary(f);
  const { requests } = installControlledImages(f, { synchronousLoad: true });
  await f.app.start();
  assert.equal(requests.length, 2); assert.equal(f.app.images.size, 2);
  assert.equal(f.app.imageLoadCancels.size, 0); assert.equal(f.app.phase, 'starting');
  assert.equal(f.app.startupStageInfo.name, 'first_result');
});

test('retry waits for a retired initialization and cannot let it close or unlock the current camera', async () => {
  const f = fixture('horizontal', { startReady: false });
  const oldInitialization = deferred(), newInitialization = deferred();
  let activeInitializers = 0, maximumConcurrentInitializers = 0;
  const { meshes, tracks } = installStartupBoundary(f, { initialize: mesh => {
    activeInitializers++; maximumConcurrentInitializers = Math.max(maximumConcurrentInitializers, activeInitializers);
    return (mesh.index === 0 ? oldInitialization : newInitialization).promise.finally(() => { activeInitializers--; });
  } });
  const original = f.app.start();
  await flushUntil(() => meshes[0]?.initializeCalled);
  f.app.pause('startup_cancel');
  assert.equal(tracks[0].stopped, true); assert.equal(meshes[0].closed, false);
  const retry = f.app.start();
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(meshes.length, 1, 'Do not create a second WASM model while the first initializer is pending');
  oldInitialization.resolve(); await original;
  await flushUntil(() => meshes[1]?.initializeCalled, 'Retry must proceed when retired initialization settles');
  assert.equal(maximumConcurrentInitializers, 1); assert.equal(meshes[0].closed, true);
  assert.equal(meshes[1].closed, false); assert.equal(tracks[1].stopped, false);
  meshes[0].callback({ multiFaceLandmarks: [] });
  assert.equal(f.app.phase, 'starting', 'Retired callbacks cannot release the new startup gate');
  newInitialization.resolve(); await retry;
  await f.app.cameraFrame({ mediaTime: 0, presentedFrames: 1 });
  meshes[1].callback({ multiFaceLandmarks: [] });
  assert.equal(f.app.phase, 'ready'); assert.equal(meshes[1].closed, false);
  assert.equal(tracks[1].stopped, false); assert.equal(maximumConcurrentInitializers, 1);
});

// v2.2 regressions; append after the existing integration fixtures/tests.
test('v2.2 preparation requires both the countdown and a subsequent stable window before calibration', () => {
  const f = fixture(); f.app.prepareCalibration(); f.clock.advance(16);
  const onset = f.app.preparation.onset, gateStart = f.app.preparation.gateStart;
  f.advanceWithFrames(f.app.config.preparationCountdownMs - 1);
  f.app.startBlock('calibration'); f.app.startBlock('validation'); f.app.continueAfterValidation();
  assert.equal(f.app.phase, 'preparation'); assert.equal(f.app.calibrations.length, 0);
  assert.equal(f.app.model, null); assert.equal(f.app.validationOK, false);
  assert.equal(f.app.preparation.state, null, 'Countdown frames cannot build the stability window early');
  f.advanceWithFrames(f.app.config.calibrationStability.windowMs - 50);
  assert.equal(f.app.phase, 'preparation'); assert.equal(f.app.calibrations.length, 0);
  f.advanceWithFrames(250);
  assert.equal(f.app.phase, 'calibration'); assert.equal(f.app.calibrations.length, 1);
  const completed = f.app.events.filter(event => event.event === 'preparation_complete');
  assert.equal(completed.length, 1); assert.ok(completed[0].timestamp >= gateStart + f.app.config.calibrationStability.windowMs);
  assert.equal(f.app.events.filter(event => event.event === 'preparation_onset')[0].timestamp, onset);
  assert.equal(f.app.calibrations[0].targets.length, 1);
});

test('v2.2 failed preparation ends at its deadline with diagnostics and no calibration or task onset', () => {
  const f = fixture(); f.app.prepareCalibration(); f.clock.advance(16);
  const onset = f.app.preparation.onset, deadline = onset + f.app.config.preparationTimeoutMs;
  while (f.clock.now() + 33 < deadline) {
    f.clock.advance(33); f.result(.5, .5, { noFace: true });
  }
  assert.equal(f.app.phase, 'preparation');
  f.clock.advance(deadline - f.clock.now() + 1);
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.model, null); assert.equal(f.app.validationOK, false);
  assert.equal(f.app.calibrations.length, 0); assert.ok(f.app.gaze.length > 12);
  assert.ok(f.app.gaze.every(row => row.face_detected === false));
  const failure = f.app.events.find(event => event.event === 'preparation_failed');
  assert.ok(failure); assert.equal(failure.detail.reason, 'stability_timeout');
  assert.equal(failure.detail.elapsed_ms, f.app.config.preparationTimeoutMs);
  assert.ok(!f.app.events.some(event => ['model_created', 'stimulus_onset', 'rating_onset'].includes(event.event)));
  f.clock.advance(5000); assert.equal(f.app.phase, 'failure');
});

test('v2.2 one calibration feature jump interrupts the whole window and every excluded attempt stays out of fitting', () => {
  let fittedAttempts;
  const core = { ...Core, createRepeatedCalibration: (samples, options) => {
    fittedAttempts = samples.map(sample => ({ ...sample }));
    return Core.createRepeatedCalibration(samples, options);
  } };
  const f = fixture('horizontal', { core }); f.app.startBlock('calibration');
  driveUntil(f, () => f.app.targetRecord?.samplingStage === 'collect');
  const record = f.app.targetRecord, firstWindow = record.activeWindow, deadline = record.deadline;
  for (let i = 0; i < 4; i++) { f.clock.advance(33); f.result(record.targetX, record.targetY); }
  assert.ok(firstWindow.sampleIds.length > 0);
  f.clock.advance(33); const jump = f.result(record.targetX + .4, record.targetY);
  assert.equal(jump.quality_valid, true, 'The gate must catch a jump even when per-frame geometry is plausible');
  assert.equal(jump.calibration_stability.reason, 'feature_jump');
  assert.equal(firstWindow.status, 'interrupted'); assert.equal(firstWindow.reason, 'feature_jump');
  assert.equal(record.activeWindow, null); assert.equal(record.deadline, deadline);
  const jumpAttempt = record.attempts.find(attempt => attempt.sampleId === jump.sample_id);
  assert.ok(jumpAttempt); assert.equal(jumpAttempt.fitEligible, false);
  assert.equal(jumpAttempt.windowId, firstWindow.id);
  driveUntil(f, () => record.status === 'complete');
  assert.ok(record.samplingWindows.length >= 2); assert.notEqual(record.acceptedWindowId, firstWindow.id);
  assert.equal(record.deadline, deadline);
  const interruptedIds = new Set([...firstWindow.sampleIds, jump.sample_id]);
  assert.ok(record.attempts.filter(attempt => interruptedIds.has(attempt.sampleId)).every(attempt => !attempt.fitEligible));
  driveUntil(f, () => f.app.phase !== 'calibration');
  assert.equal(f.app.phase, 'calibration_report'); assert.ok(fittedAttempts.length > 0);
  assert.ok(fittedAttempts.every(attempt => attempt.fitEligible === true && !interruptedIds.has(attempt.sampleId)));
  assert.equal(fittedAttempts.length, f.app.calibrations[0].targets.reduce((sum, target) => sum + target.attempts.filter(attempt => attempt.fitEligible).length, 0));
  assert.ok(f.app.calibrations[0].samplingSummary.interruptedWindows >= 1);
});

test('v2.2 no-face and sample gaps require new calibration windows without extending the point deadline', () => {
  for (const kind of ['no_face', 'sample_gap']) {
    const f = fixture(); f.app.startBlock('calibration');
    driveUntil(f, () => f.app.targetRecord?.samplingStage === 'collect');
    const record = f.app.targetRecord, firstWindow = record.activeWindow, deadline = record.deadline;
    f.clock.advance(33); f.result(record.targetX, record.targetY);
    if (kind === 'no_face') { f.clock.advance(33); f.result(record.targetX, record.targetY, { noFace: true }); }
    else f.clock.advance(f.app.config.calibrationStability.maxGapMs + 101);
    assert.equal(firstWindow.status, 'interrupted'); assert.equal(record.activeWindow, null);
    assert.equal(record.deadline, deadline); assert.ok(record.attempts.every(attempt => attempt.fitEligible === false));
    driveUntil(f, () => record.activeWindow && record.activeWindow.id !== firstWindow.id);
    assert.equal(record.deadline, deadline); assert.equal(record.samplingWindows.length, 2);
    f.clock.advance(33); f.result(record.targetX, record.targetY, { noFace: true });
    while (f.clock.now() + 33 < deadline) { f.clock.advance(33); f.result(record.targetX, record.targetY, { noFace: true }); }
    f.clock.advance(deadline - f.clock.now() + 1);
    assert.equal(f.app.phase, 'failure'); assert.equal(f.app.calibrations[0].failure, 'stable_collection_timeout');
    assert.equal(record.collectEnd, deadline); assert.equal(record.deadline, deadline);
    assert.equal(record.status, 'failed'); assert.equal(f.app.model, null);
    assert.ok(record.attempts.length > firstWindow.sampleIds.length);
    assert.ok(record.attempts.every(attempt => !attempt.fitEligible));
    assert.ok(record.samplingWindows.every(window => window.status === 'interrupted'));
  }
});

test('v2.2 independent validation metrics are unchanged by extreme calibration-only stability settings', () => {
  const trained = fixture(); trained.calibrate();
  const model = JSON.parse(JSON.stringify(trained.app.model));
  const fixtures = [fixture(), fixture()];
  fixtures[1].app.config.calibrationStability = { windowMs: 999999, minFrames: 9999, maxGapMs: 1, maxSpread: 0, maxDrift: 0, maxStep: 0 };
  const outcomes = fixtures.map(f => {
    f.app.model = JSON.parse(JSON.stringify(model)); f.app.modelId = 'frozen-model'; f.app.modelHash = trained.app.modelHash;
    const before = JSON.stringify(f.app.model);
    const block = f.runBlock('validation');
    assert.equal(f.app.phase, 'validation_report'); assert.equal(JSON.stringify(f.app.model), before);
    assert.ok(block.targets.every(target => target.samplingWindows.length === 0));
    assert.ok(f.app.gaze.every(row => row.calibration_stability === null));
    return { evaluation: block.evaluation, attempts: block.targets.map(target => target.attempts),
      rows: f.app.gaze.map(row => ({ x: row.gaze_x_raw, y: row.gaze_y_raw, valid: row.valid, reason: row.valid_reason })) };
  });
  assert.deepEqual(JSON.parse(JSON.stringify(outcomes[1])), JSON.parse(JSON.stringify(outcomes[0])),
    'The same frozen model and frame sequence must have identical independent validation denominators and errors');
});

test('v2.2 Tasks without pilot is blocked before camera access and retains its requested engine', async () => {
  const f = fixture('horizontal', { startReady: false, search: '?engine=tasks' });
  let permissions = 0, creations = 0;
  f.context.navigator.mediaDevices = { getUserMedia: async () => { permissions++; throw new Error('should not request camera'); } };
  f.window.TrackingAdapter = { create() { creations++; throw new Error('should not construct Tasks'); } };
  assert.equal(f.app.engine, 'tasks'); assert.equal(f.app.pilot, false);
  assert.ok(!descendants(f.app.panel).some(node => node.tagName === 'BUTTON'));
  await f.app.start();
  assert.equal(permissions, 0); assert.equal(creations, 0); assert.equal(f.app.engine, 'tasks');
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.runningCamera, false);
  assert.equal(f.app.config.trackingEngine, 'tasks');
});

test('v2.2 an explicit Tasks initialization failure cannot silently fall back to the available legacy model', async () => {
  const f = fixture('horizontal', { startReady: false, search: '?pilot=1&engine=tasks' });
  const { meshes, tracks } = installStartupBoundary(f);
  let creations = 0, closed = 0, requested;
  f.window.TrackingAdapter = { create(options) {
    creations++; requested = options;
    return { onResults() {}, initialize: async () => { throw new Error('Tasks GPU failed'); }, close: async () => { closed++; } };
  } };
  await f.app.start(); await flushUntil(() => closed === 1);
  assert.equal(creations, 1); assert.equal(requested.engine, 'tasks');
  assert.match(requested.assetBase, /tasks-vision\/0\.10\.32\/$/);
  assert.equal(meshes.length, 0); assert.equal(tracks[0].stopped, true);
  assert.equal(f.app.phase, 'failure'); assert.equal(f.app.engine, 'tasks'); assert.equal(f.app.config.trackingEngine, 'tasks');
  assert.ok(f.app.events.some(event => event.event === 'failure' && /Tasks GPU failed/.test(event.detail.message)));
});

test('v2.2 extreme optional Tasks diagnostics cannot change raw gaze, validity or ROI for identical landmarks', () => {
  const trained = fixture(); trained.calibrate();
  const fixtures = [fixture(), fixture('horizontal', { search: '?pilot=1&engine=tasks' })];
  for (const f of fixtures) {
    f.app.model = JSON.parse(JSON.stringify(trained.app.model)); f.app.modelId = 'same-model'; f.app.modelHash = trained.app.modelHash;
    f.app.aois = [{ x: 0, y: 0, width: 195, height: 844 }, { x: 195, y: 0, width: 195, height: 844 }];
  }
  for (const condition of ['open', 'closed', 'no_face']) {
    const rows = fixtures.map((f, index) => {
      f.clock.advance(33);
      const diagnostics = index ? { engine: 'tasks', faceBlendshapes: [{ categories: [{ categoryName: 'eyeBlinkLeft', score: condition === 'open' ? 1 : 0 },
        { categoryName: 'eyeLookUpLeft', score: 1 }] }], facialTransformationMatrices: [{ rows: 4, columns: 4, data: Array(16).fill(1e6) }] } : undefined;
      f.app.onResults({ multiFaceLandmarks: condition === 'no_face' ? [] : [landmarksForTarget(.25, .35, { closed: condition === 'closed' })], diagnostics }, f.meta());
      const row = f.app.gaze.at(-1);
      assert.equal(row.tracking_diagnostics, diagnostics || null);
      return row;
    });
    for (const key of ['gaze_x_raw','gaze_y_raw','gaze_x_smooth','gaze_y_smooth','quality_valid','temporal_quality_valid','valid','valid_reason','roi_raw','roi_smooth'])
      assert.equal(rows[0][key], rows[1][key], `${condition}: diagnostic fields must not alter ${key}`);
    assert.equal(rows[1].valid, condition === 'open');
  }
});
