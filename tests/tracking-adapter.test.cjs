'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Adapter = require('../shared/tracking-adapter.js');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'Expected asynchronous boundary was not reached'); }
function legacy(t, behavior = {}) {
  const previous = globalThis.FaceMesh;
  const state = { instances: [] };
  globalThis.FaceMesh = class {
    constructor(options) { this.constructorOptions = options; this.closeCount = 0; this.sendCount = 0; state.instances.push(this); }
    setOptions(options) { this.options = options; }
    onResults(callback) { this.callback = callback; }
    initialize() { this.initializeCount = (this.initializeCount || 0) + 1; return behavior.initialize ? behavior.initialize(this) : Promise.resolve(); }
    send(input) { this.sendCount++; this.input = input; if (behavior.send) return behavior.send(this, input); this.callback({ multiFaceLandmarks: [] }); return Promise.resolve(); }
    close() { this.closeCount++; return behavior.close ? behavior.close(this) : Promise.resolve(); }
  };
  t.after(() => { if (previous === undefined) delete globalThis.FaceMesh; else globalThis.FaceMesh = previous; });
  return state;
}
function tasks(t, behavior = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-adapter-test-'));
  const key = 'adapter-test-' + path.basename(directory);
  const state = { calls: [], options: null, wasmBase: null, backend: null, createStarted: false, behavior };
  globalThis[key] = state;
  fs.writeFileSync(path.join(directory, 'vision_bundle.mjs'), `
    const state = globalThis[${JSON.stringify(key)}];
    export const FilesetResolver = { async forVisionTasks(base) {
      state.wasmBase = base;
      if (state.behavior.fileset) await state.behavior.fileset();
      return { wasmLoaderPath: base + '/vision_wasm_internal.js' };
    }};
    export const FaceLandmarker = { async createFromOptions(fileset, options) {
      state.createStarted = true; state.fileset = fileset; state.options = options;
      if (state.behavior.create) await state.behavior.create();
      const backend = {
        closeCount: 0,
        detectForVideo(image, timestamp) {
          state.calls.push({ image, timestamp });
          return state.behavior.detect ? state.behavior.detect(image, timestamp) : { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
        },
        close() { this.closeCount++; if (state.behavior.close) return state.behavior.close(); }
      };
      state.backend = backend; return backend;
    }};
  `);
  t.after(() => { delete globalThis[key]; fs.rmSync(directory, { recursive: true, force: true }); });
  return { state, assetBase: pathToFileURL(directory + path.sep).href };
}

test('factory is synchronous, declares fixed identities and refuses invalid or unpinned options', () => {
  const adapter = Adapter.create({ engine: 'tasks' });
  assert.equal(adapter.state, 'new'); assert.equal(adapter.then, undefined);
  assert.equal(adapter.identity, adapter.info);
  assert.equal(Adapter.identityFor('tasks').packageVersion, '0.10.32');
  assert.match(adapter.identity.modelSource, /float16\/1\/face_landmarker\.task$/);
  assert.match(adapter.identity.moduleUrl, /tasks-vision\/0\.10\.32\/vision_bundle\.mjs$/);
  assert.equal(adapter.identity.automaticEngineFallback, false);
  assert.throws(() => Adapter.create({ engine: 'automatic' }), { code: 'invalid_engine' });
  assert.throws(() => Adapter.create({ engine: 'tasks', tasksOptions: { numFaces: 3 } }), { code: 'unsupported_option' });
  assert.throws(() => Adapter.create({ engine: 'tasks', tasksOptions: { delegate: 'AUTO' } }), { code: 'invalid_delegate' });
  assert.throws(() => Adapter.create({ engine: 'tasks', tasksOptions: { moduleUrl: 'https://example.test/tasks@latest/model.mjs' } }), { code: 'unpinned_resource' });
});

test('legacy initializes once and preserves the fixed baseline options and local asset paths', async t => {
  const state = legacy(t);
  const adapter = Adapter.create({ engine: 'legacy', assetBase: 'https://localhost/food2/mp/package/' });
  const first = adapter.initialize(); const second = adapter.initialize();
  assert.equal(first, second); await first; await adapter.initialize();
  assert.equal(state.instances.length, 1); assert.equal(state.instances[0].initializeCount, 1);
  assert.deepEqual(state.instances[0].options, { maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: .6, minTrackingConfidence: .6, selfieMode: false });
  assert.equal(state.instances[0].constructorOptions.locateFile('face_mesh_solution_simd_wasm_bin.wasm'), 'https://localhost/food2/mp/package/face_mesh_solution_simd_wasm_bin.wasm');
  await adapter.close(); await adapter.close(); assert.equal(state.instances[0].closeCount, 1);
});

test('Tasks loads the pinned local module with VIDEO, one face and optional diagnostics enabled', async t => {
  const { state, assetBase } = tasks(t);
  const adapter = Adapter.create({ engine: 'tasks', assetBase }); await adapter.initialize();
  assert.equal(state.wasmBase, assetBase + 'wasm');
  assert.deepEqual(state.options, { runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: .6,
    minFacePresenceConfidence: .5, minTrackingConfidence: .6, outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true, baseOptions: { modelAssetPath: assetBase + 'face_landmarker.task', delegate: 'GPU' } });
  await adapter.close(); assert.equal(state.backend.closeCount, 1);
});

test('Tasks normalizes results, preserves input timestamp and copies diagnostics without making gaze or validity', async t => {
  const result = { faceLandmarks: [[{ x: .1, y: .2, z: -.03 }]],
    faceBlendshapes: [{ categories: [{ categoryName: 'eyeBlinkLeft', score: .9 }] }],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: Array.from({ length: 16 }, (_, i) => i) }] };
  const { state, assetBase } = tasks(t, { detect: () => result });
  const received = [];
  const adapter = Adapter.create({ engine: 'tasks', assetBase, onResults: (r, m) => received.push({ r, m }) });
  await adapter.initialize(); adapter.captureMeta = { phaseId: 'phase-7', target: { targetId: 'v2' } };
  await adapter.send({ image: {}, timestamp: 123.45 });
  assert.equal(state.calls[0].timestamp, 123.45); assert.equal(received.length, 1);
  assert.deepEqual(received[0].r.multiFaceLandmarks, result.faceLandmarks);
  assert.equal(received[0].r.diagnostics.inputTimestampMs, 123.45);
  assert.equal(received[0].r.diagnostics.engine, 'tasks'); assert.equal(received[0].r.diagnostics.diagnosticsOnly, true);
  assert.equal(received[0].r.valid, undefined); assert.equal(received[0].r.gazeX, undefined);
  result.faceBlendshapes[0].categories[0].score = 0; result.facialTransformationMatrixes[0].data[0] = 99;
  assert.equal(received[0].r.diagnostics.faceBlendshapes[0].categories[0].score, .9);
  assert.equal(received[0].r.diagnostics.facialTransformationMatrices[0].data[0], 0);
  await adapter.close();
});

test('both engines emit empty arrays for no face, with no old result carryover', async t => {
  const old = legacy(t); const modern = tasks(t); const output = [];
  for (const engine of ['legacy', 'tasks']) {
    const adapter = Adapter.create({ engine, assetBase: engine === 'tasks' ? modern.assetBase : undefined, onResults: r => output.push(r) });
    await adapter.initialize(); await adapter.send({ image: {}, timestamp: 0 }); await adapter.close();
  }
  assert.equal(old.instances.length, 1); assert.equal(output.length, 2);
  for (const row of output) {
    assert.deepEqual(row.multiFaceLandmarks, []); assert.deepEqual(row.diagnostics.faceBlendshapes, []);
    assert.deepEqual(row.diagnostics.facialTransformationMatrices, []);
  }
});

test('timestamps must be finite nonnegative and strictly increasing without silent clamping', async t => {
  const { state, assetBase } = tasks(t); const adapter = Adapter.create({ engine: 'tasks', assetBase });
  await assert.rejects(adapter.send({ image: {}, timestamp: 0 }), { code: 'adapter_not_ready' });
  await adapter.initialize();
  for (const timestamp of [undefined, NaN, Infinity, -1]) await assert.rejects(adapter.send({ image: {}, timestamp }), { code: 'invalid_timestamp' });
  await adapter.send({ image: {}, timestamp: 0 }); await adapter.send({ image: {}, timestamp: 16.7 });
  for (const timestamp of [0, 16.7, 15]) await assert.rejects(adapter.send({ image: {}, timestamp }), { code: 'nonmonotonic_timestamp' });
  await adapter.send({ image: {}, timestamp: 33.4 });
  assert.deepEqual(state.calls.map(call => call.timestamp), [0, 16.7, 33.4]);
  await adapter.close();
});

test('legacy pending inference rejects reentry and captures phase metadata before asynchronous results', async t => {
  const gate = deferred(); const output = [];
  const state = legacy(t, { send: async instance => { await gate.promise; instance.callback({ multiFaceLandmarks: [] }); instance.callback({ multiFaceLandmarks: [] }); } });
  const adapter = Adapter.create({ engine: 'legacy', onResults: (r, meta) => output.push({ r, meta }) }); await adapter.initialize();
  adapter.captureMeta = { phaseId: 'old-phase', target: { targetId: 'old-target' } };
  const pending = adapter.send({ image: {}, timestamp: 1 });
  adapter.captureMeta.phaseId = 'new-phase'; adapter.captureMeta.target.targetId = 'new-target';
  await assert.rejects(adapter.send({ image: {}, timestamp: 2 }), { code: 'adapter_busy' });
  gate.resolve(); await pending;
  assert.equal(state.instances[0].sendCount, 1); assert.equal(output.length, 1);
  assert.deepEqual(output[0].meta, { phaseId: 'old-phase', target: { targetId: 'old-target' } });
  await adapter.close();
});

test('close during legacy inference suppresses late callbacks and releases only once after settlement', async t => {
  const gate = deferred(); let callbacks = 0;
  const state = legacy(t, { send: async instance => { await gate.promise; instance.callback({ multiFaceLandmarks: [] }); } });
  const adapter = Adapter.create({ engine: 'legacy', onResults: () => { callbacks++; } }); await adapter.initialize();
  const pending = adapter.send({ image: {}, timestamp: 1 }); await adapter.close(); await adapter.close();
  assert.equal(adapter.state, 'closed'); assert.equal(state.instances[0].closeCount, 0);
  await assert.rejects(adapter.send({ image: {}, timestamp: 2 }), { code: 'adapter_closed' });
  gate.resolve(); await pending; state.instances[0].callback({ multiFaceLandmarks: [] });
  assert.equal(callbacks, 0); assert.equal(state.instances[0].closeCount, 1);
});

test('close during legacy initialization remains closed and cleans up a late initialization handle', async t => {
  const gate = deferred(); const state = legacy(t, { initialize: () => gate.promise });
  const adapter = Adapter.create({ engine: 'legacy' }); const initializing = adapter.initialize();
  const rejected = assert.rejects(initializing, { code: 'adapter_closed' });
  await adapter.close(); await adapter.close(); assert.equal(state.instances[0].closeCount, 0);
  gate.resolve(); await rejected;
  assert.equal(adapter.state, 'closed'); assert.equal(state.instances[0].closeCount, 1);
  await assert.rejects(adapter.initialize(), { code: 'adapter_closed' });
});

test('close during asynchronous Tasks creation disposes the late resource instead of reviving the adapter', async t => {
  const gate = deferred(); const { state, assetBase } = tasks(t, { create: () => gate.promise });
  const adapter = Adapter.create({ engine: 'tasks', assetBase }); const initializing = adapter.initialize();
  const rejected = assert.rejects(initializing, { code: 'adapter_closed' });
  await until(() => state.createStarted); await adapter.close(); gate.resolve(); await rejected;
  assert.equal(adapter.state, 'closed'); assert.equal(state.backend.closeCount, 1);
});

test('close before Tasks fileset resolution prevents model creation', async t => {
  const gate = deferred(); const { state, assetBase } = tasks(t, { fileset: () => gate.promise });
  const adapter = Adapter.create({ engine: 'tasks', assetBase }); const initializing = adapter.initialize();
  const rejected = assert.rejects(initializing, { code: 'adapter_closed' });
  await until(() => state.wasmBase !== null); await adapter.close(); gate.resolve(); await rejected;
  assert.equal(state.createStarted, false); assert.equal(adapter.state, 'closed');
});

test('failed legacy initialization releases its handle and requires a fresh adapter', async t => {
  const state = legacy(t, { initialize: () => Promise.reject(new Error('broken model')) });
  const adapter = Adapter.create({ engine: 'legacy' });
  await assert.rejects(adapter.initialize(), error => error.code === 'initialization_failed' && /broken model/.test(error.message));
  assert.equal(adapter.state, 'failed'); assert.equal(state.instances[0].closeCount, 1);
  await assert.rejects(adapter.initialize(), { code: 'initialization_failed' }); assert.equal(state.instances.length, 1);
  await adapter.close(); assert.equal(state.instances[0].closeCount, 1);
});

test('Tasks load failures are explicit and never initialize legacy as a fallback', async t => {
  const old = legacy(t); const { state, assetBase } = tasks(t, { create: () => Promise.reject(new Error('GPU unavailable')) });
  const adapter = Adapter.create({ engine: 'tasks', assetBase });
  await assert.rejects(adapter.initialize(), error => error.code === 'initialization_failed' && /GPU unavailable/.test(error.message));
  assert.equal(adapter.state, 'failed'); assert.equal(old.instances.length, 0); assert.equal(state.backend, null);
});

test('Tasks inference failure releases its resource, preserves error and cannot silently resume', async t => {
  const { state, assetBase } = tasks(t, { detect: () => { throw new Error('inference lost'); } });
  const adapter = Adapter.create({ engine: 'tasks', assetBase }); await adapter.initialize();
  await assert.rejects(adapter.send({ image: {}, timestamp: 5 }), error => error.code === 'inference_failed' && /inference lost/.test(error.message));
  assert.equal(adapter.state, 'failed'); assert.equal(state.backend.closeCount, 1);
  await assert.rejects(adapter.send({ image: {}, timestamp: 6 }), { code: 'adapter_not_ready' });
  await adapter.close(); assert.equal(state.backend.closeCount, 1);
});

test('a reentrant send from a synchronous Tasks callback is rejected and close stops future output', async t => {
  const { state, assetBase } = tasks(t); let reentry; let calls = 0;
  const adapter = Adapter.create({ engine: 'tasks', assetBase, onResults: () => {
    calls++; reentry = assert.rejects(adapter.send({ image: {}, timestamp: 2 }), { code: 'adapter_busy' }); adapter.close();
  } });
  await adapter.initialize(); await adapter.send({ image: {}, timestamp: 1 }); await reentry;
  assert.equal(calls, 1); assert.equal(state.backend.closeCount, 1); assert.equal(adapter.state, 'closed');
});
