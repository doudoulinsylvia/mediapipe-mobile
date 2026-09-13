import { createGazeModel } from './mnn/mnn-gaze.mjs';
let model = null;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      if (model) throw Error('model_already_initialized');
      const response = await fetch(new URL(data.modelPath, self.location.href));
      if (!response.ok) throw Error('model_http_' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== data.sha256) throw Error('model_checksum_mismatch');
      model = await createGazeModel(bytes, { locateFile: file => new URL('./mnn/' + file, self.location.href).href });
      self.postMessage({ id: data.id, ok: true, result: { sha256: hash, bytes: bytes.length, version: model.version } });
    } else if (data.type === 'infer') {
      if (!model) throw Error('model_not_initialized');
      const started = performance.now();
      const output = model.infer(data.inputs);
      if (output.length !== 258 || !output.every(Number.isFinite)) throw Error('invalid_network_output');
      self.postMessage({ id: data.id, ok: true, result: { output: Array.from(output), inferenceMs: performance.now() - started } });
    } else throw Error('unknown_worker_request');
  } catch (e) { self.postMessage({ id: data.id, ok: false, error: e.message || String(e) }); }
};
