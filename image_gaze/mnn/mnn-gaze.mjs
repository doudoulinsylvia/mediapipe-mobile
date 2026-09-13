/** Single-model browser adapter. Inputs are normalized RGB NHWC Float32Arrays. */
import createMNNGaze from './mnn-gaze-runtime.mjs';

const LENGTHS = Object.freeze({ face: 224 * 224 * 3, left: 112 * 112 * 3, right: 112 * 112 * 3, rect: 12 });

export async function createGazeModel(modelBytes, runtimeOptions = {}) {
  if (!(modelBytes instanceof Uint8Array) || modelBytes.length < 1024 || modelBytes.length > 100 * 1024 * 1024) {
    throw new TypeError('Provide the MNN model as a Uint8Array (1 KB to 100 MB).');
  }
  const runtime = await createMNNGaze(runtimeOptions);
  const allocations = [];
  let disposed = false;
  function allocate(bytes) {
    const pointer = runtime._malloc(bytes);
    if (!pointer) throw new Error('WASM memory allocation failed.');
    allocations.push(pointer);
    return pointer;
  }
  function error() { return runtime.UTF8ToString(runtime._gaze_error()); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    runtime._gaze_destroy();
    for (const pointer of allocations) runtime._free(pointer);
  }
  try {
    const modelPointer = allocate(modelBytes.byteLength);
    runtime.HEAPU8.set(modelBytes, modelPointer);
    if (runtime._gaze_create(modelPointer, modelBytes.byteLength) !== 1) throw new Error(error());
    const pointers = Object.fromEntries(Object.entries(LENGTHS).map(([key, length]) => [key, allocate(length * 4)]));
    return Object.freeze({
      version: runtime.UTF8ToString(runtime._gaze_runtime_version()),
      outputLength: 258,
      inputLengths: LENGTHS,
      infer(inputs) {
        if (disposed) throw new Error('Model is disposed.');
        for (const [key, length] of Object.entries(LENGTHS)) {
          if (!(inputs?.[key] instanceof Float32Array) || inputs[key].length !== length) {
            throw new TypeError(`${key} must contain ${length} Float32 values.`);
          }
          runtime.HEAPF32.set(inputs[key], pointers[key] >>> 2);
        }
        const count = runtime._gaze_run(pointers.face, LENGTHS.face, pointers.left, LENGTHS.left,
          pointers.right, LENGTHS.right, pointers.rect, LENGTHS.rect);
        if (count !== 258) throw new Error(error());
        const pointer = runtime._gaze_output();
        if (!pointer) throw new Error('MNN returned no output.');
        // A copy prevents subsequent inference or memory growth changing previous records.
        return runtime.HEAPF32.slice(pointer >>> 2, (pointer >>> 2) + count);
      },
      dispose,
    });
  } catch (cause) {
    dispose();
    throw cause;
  }
}
