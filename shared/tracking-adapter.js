/* Pinned tracking engines. Diagnostics are not gaze coordinates or quality gates. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TrackingAdapter = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const VERSION = '2.2.0';
  const TASKS_VERSION = '0.10.32';
  const LEGACY_VERSION = '0.4.1633559619';
  const LEGACY_OPTIONS = Object.freeze({ maxNumFaces: 1, refineLandmarks: true,
    minDetectionConfidence: .6, minTrackingConfidence: .6, selfieMode: false });
  const TASKS_OPTIONS = Object.freeze({ runningMode: 'VIDEO', numFaces: 1,
    minFaceDetectionConfidence: .6, minFacePresenceConfidence: .5, minTrackingConfidence: .6,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
  const ENGINES = Object.freeze({
    legacy: Object.freeze({ packageName: '@mediapipe/face_mesh', packageVersion: LEGACY_VERSION,
      packageSource: 'https://registry.npmjs.org/@mediapipe/face_mesh/-/face_mesh-' + LEGACY_VERSION + '.tgz',
      license: 'Apache-2.0' }),
    tasks: Object.freeze({ packageName: '@mediapipe/tasks-vision', packageVersion: TASKS_VERSION,
      packageSource: 'https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-' + TASKS_VERSION + '.tgz',
      modelSource: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      modelVersion: 'face_landmarker/float16/1', license: 'Apache-2.0', modelLicense: 'Apache-2.0' })
  });

  function failure(code, message, cause) {
    const error = new Error(message); error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }
  function absolute(value, base) { return new URL(value, base).href; }
  function copyDiagnostics(value) {
    if (Array.isArray(value)) return value.map(copyDiagnostics);
    if (value && typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) result[key] = copyDiagnostics(value[key]);
      return result;
    }
    return value;
  }
  function snapshotMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    return { ...meta, ...(meta.target ? { target: { ...meta.target } } : {}) };
  }

  class Adapter {
    constructor(options) {
      if (!options || !['legacy', 'tasks'].includes(options.engine))
        throw failure('invalid_engine', 'Choose an explicit legacy or tasks tracking engine.');
      this.engine = options.engine;
      this.state = 'new'; this.captureMeta = null;
      this._backend = null; this._initialization = null; this._initializing = false; this._error = null;
      this._busy = false; this._request = null; this._lastTimestamp = null;
      this._callback = null; this._disposed = new WeakMap();
      const page = root.document?.baseURI || root.location?.href || 'file:///';
      const defaultBase = this.engine === 'tasks' ? '../shared/tasks-vision/' + TASKS_VERSION + '/' : '../food2/mp/package/';
      const base = absolute(options.assetBase || defaultBase, page);
      this.assetBase = base.endsWith('/') ? base : base + '/';
      const tasks = options.tasksOptions || {};
      const allowed = new Set(['delegate', 'moduleUrl', 'wasmBase', 'modelUrl']);
      if (Object.keys(tasks).some(key => !allowed.has(key)))
        throw failure('unsupported_option', 'Tasks options may configure only delegate and pinned resource locations.');
      this.delegate = tasks.delegate || 'GPU';
      if (!['GPU', 'CPU'].includes(this.delegate)) throw failure('invalid_delegate', 'Tasks delegate must be GPU or CPU.');
      this.moduleUrl = absolute(tasks.moduleUrl || 'vision_bundle.mjs', this.assetBase);
      this.wasmBase = absolute(tasks.wasmBase || 'wasm/', this.assetBase).replace(/\/$/, '');
      this.modelUrl = absolute(tasks.modelUrl || 'face_landmarker.task', this.assetBase);
      if ([this.moduleUrl, this.wasmBase, this.modelUrl].some(url => /(?:@|\/|%40)latest(?:\/|$|[?#])/i.test(url)))
        throw failure('unpinned_resource', 'Tracking resources must use fixed versions; latest is not allowed.');
      this.info = Object.freeze({ adapterVersion: VERSION, engine: this.engine,
        ...ENGINES[this.engine],
        assetBase: this.assetBase,
        ...(this.engine === 'tasks' ? { moduleUrl: this.moduleUrl, wasmBase: this.wasmBase,
          modelUrl: this.modelUrl, modelVersion: 'face_landmarker/float16/1', delegate: this.delegate,
          options: TASKS_OPTIONS } : { options: LEGACY_OPTIONS }),
        diagnosticsOnly: true, automaticEngineFallback: false });
      this.identity = this.info;
      if (options.onResults !== undefined) this.onResults(options.onResults);
    }
    onResults(callback) {
      if (typeof callback !== 'function') throw failure('invalid_callback', 'onResults requires a function.');
      if (this.state === 'closed') throw failure('adapter_closed', 'The tracking adapter is closed.');
      this._callback = callback; return this;
    }
    initialize() {
      if (this.state === 'closed') return Promise.reject(failure('adapter_closed', 'The tracking adapter is closed.'));
      if (this.state === 'failed') return Promise.reject(this._error);
      if (this.state === 'ready') return Promise.resolve(this);
      if (this._initialization) return this._initialization;
      this.state = 'initializing'; this._initializing = true;
      this._initialization = this._initialize();
      return this._initialization;
    }
    _assertOpen() {
      if (this.state === 'closed') throw failure('adapter_closed', 'The tracking adapter was closed during an operation.');
    }
    async _initialize() {
      let instance;
      try {
        if (this.engine === 'legacy') {
          if (typeof root.FaceMesh !== 'function') throw failure('legacy_unavailable', 'The local FaceMesh script is not loaded.');
          instance = new root.FaceMesh({ locateFile: file => absolute(file, this.assetBase) });
          this._backend = instance;
          instance.setOptions({ ...LEGACY_OPTIONS });
          instance.onResults(result => {
            const request = this._request;
            if (request && !request.delivered && this.state === 'ready') this._deliver(result, request);
          });
          if (typeof instance.initialize === 'function') await instance.initialize();
          this._assertOpen();
        } else {
          const module = await import(this.moduleUrl);
          this._assertOpen();
          if (!module.FilesetResolver?.forVisionTasks || !module.FaceLandmarker?.createFromOptions)
            throw failure('tasks_module_invalid', 'The pinned Tasks module does not expose FaceLandmarker and FilesetResolver.');
          const fileset = await module.FilesetResolver.forVisionTasks(this.wasmBase);
          this._assertOpen();
          instance = await module.FaceLandmarker.createFromOptions(fileset, {
            ...TASKS_OPTIONS, baseOptions: { modelAssetPath: this.modelUrl, delegate: this.delegate }
          });
          this._backend = instance;
          this._assertOpen();
        }
        this.state = 'ready'; return this;
      } catch (cause) {
        if (this.state !== 'closed') {
          this.state = 'failed';
          this._error = failure('initialization_failed', 'Tracking engine initialization failed: ' + cause.message, cause);
        }
        try { await this._dispose(instance); } catch (cleanupError) {
          if (this._error) this._error.cleanupError = cleanupError;
        }
        throw this.state === 'closed' ? failure('adapter_closed', 'Tracking initialization was cancelled.', cause) : this._error;
      } finally {
        this._initializing = false;
      }
    }
    _deliver(result, request) {
      if (this.state !== 'ready' || request !== this._request || request.delivered) return;
      request.delivered = true;
      const tasks = this.engine === 'tasks';
      const normalized = { multiFaceLandmarks: (tasks ? result?.faceLandmarks : result?.multiFaceLandmarks) || [],
        diagnostics: { engine: this.engine, packageVersion: this.info.packageVersion,
          inputTimestampMs: request.timestamp,
          faceBlendshapes: tasks ? copyDiagnostics(result?.faceBlendshapes || []) : [],
          facialTransformationMatrices: tasks ? copyDiagnostics(result?.facialTransformationMatrixes || []) : [],
          diagnosticsOnly: true } };
      if (this._callback) this._callback(normalized, request.meta);
    }
    async send({ image, timestamp } = {}) {
      if (this.state === 'closed') throw failure('adapter_closed', 'The tracking adapter is closed.');
      if (this.state !== 'ready') throw failure('adapter_not_ready', 'Initialize the tracking adapter before sending frames.');
      if (this._busy) throw failure('adapter_busy', 'Only one inference may be active at a time.');
      if (!image) throw failure('invalid_image', 'A camera frame is required.');
      if (!Number.isFinite(timestamp) || timestamp < 0) throw failure('invalid_timestamp', 'Frame timestamps must be finite, nonnegative milliseconds.');
      if (this._lastTimestamp !== null && timestamp <= this._lastTimestamp)
        throw failure('nonmonotonic_timestamp', 'Frame timestamps must increase strictly; duplicate media frames should be dropped by the caller.');
      this._lastTimestamp = timestamp; this._busy = true;
      const request = { timestamp, meta: snapshotMeta(this.captureMeta), delivered: false };
      this._request = request;
      const instance = this._backend;
      try {
        if (this.engine === 'tasks') {
          const result = instance.detectForVideo(image, timestamp);
          this._deliver(result, request);
        } else {
          await instance.send({ image });
        }
      } catch (cause) {
        if (this.state !== 'closed') {
          this.state = 'failed';
          this._error = failure('inference_failed', 'Tracking inference failed: ' + cause.message, cause);
        }
        throw this.state === 'closed' ? failure('adapter_closed', 'Tracking inference was cancelled.', cause) : this._error;
      } finally {
        this._busy = false;
        if (this._request === request) this._request = null;
        if (this.state === 'closed' || this.state === 'failed') {
          try { await this._dispose(instance); } catch (cleanupError) {
            if (this._error) this._error.cleanupError = cleanupError;
          }
        }
      }
    }
    _dispose(instance) {
      if (!instance) return Promise.resolve();
      if (this._disposed.has(instance)) return this._disposed.get(instance);
      if (this._backend === instance) this._backend = null;
      // Register before invoking close, including runtimes that throw synchronously.
      const promise = Promise.resolve().then(() => typeof instance.close === 'function' ? instance.close() : undefined);
      this._disposed.set(instance, promise); return promise;
    }
    close() {
      this.state = 'closed'; this._callback = null;
      // Initialization/send may not be cancellable inside the vendor runtime.
      // Invalidate callbacks immediately; dispose its handle once that operation settles.
      if (this._initializing || this._busy) return Promise.resolve();
      return this._dispose(this._backend);
    }
  }
  function create(options) { return new Adapter(options); }
  function identityFor(engine, options = {}) { return create({ ...options, engine }).identity; }
  return { VERSION, TASKS_VERSION, LEGACY_VERSION, LEGACY_OPTIONS, TASKS_OPTIONS, ENGINES, identityFor, create };
});
