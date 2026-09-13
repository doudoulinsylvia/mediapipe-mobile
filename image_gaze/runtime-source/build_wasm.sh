#!/bin/bash
set -euo pipefail
MODEL_BUILD_ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$MODEL_BUILD_ROOT/../.venv/bin:$PATH"
source "$MODEL_BUILD_ROOT/emsdk/emsdk_env.sh"
MNN_SOURCE="$MODEL_BUILD_ROOT/vendor/MNN-3.5.0"
WASM_BUILD="$MODEL_BUILD_ROOT/build-wasm"
WASM_DIST="$MODEL_BUILD_ROOT/dist"
mkdir -p "$WASM_BUILD" "$WASM_DIST"

emcmake cmake -S "$MNN_SOURCE" -B "$WASM_BUILD" -G Ninja \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS='-msimd128 -msse4.1' \
  -DCMAKE_C_FLAGS='-msimd128 -msse4.1' \
  -DMNN_BUILD_SHARED_LIBS=OFF -DMNN_SEP_BUILD=OFF \
  -DMNN_BUILD_TOOLS=OFF -DMNN_BUILD_TEST=OFF -DMNN_BUILD_DEMO=OFF \
  -DMNN_BUILD_CONVERTER=OFF -DMNN_BUILD_TRAIN=OFF \
  -DMNN_FORBID_MULTI_THREAD=ON -DMNN_USE_THREAD_POOL=OFF \
  -DMNN_USE_SSE=ON -DMNN_AVX=OFF -DMNN_AVX512=OFF \
  -DMNN_OPENCL=OFF -DMNN_METAL=OFF -DMNN_VULKAN=OFF \
  -DMNN_CUDA=OFF -DMNN_ARM82=OFF -DMNN_ENABLE_INT8=OFF \
  -DMNN_BUILD_LLM=OFF -DMNN_LOW_MEMORY=OFF
cmake --build "$WASM_BUILD" --target MNN --parallel 6

em++ "$MODEL_BUILD_ROOT/mnn_gaze.cpp" "$WASM_BUILD/libMNN.a" \
  -I "$MNN_SOURCE/include" -O3 -std=c++17 -msimd128 -msse4.1 \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createMNNGaze \
  -s ENVIRONMENT='web,worker,node' -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 -s MAXIMUM_MEMORY=536870912 \
  -s FILESYSTEM=0 -s ASSERTIONS=1 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_gaze_create","_gaze_run","_gaze_output","_gaze_destroy","_gaze_error","_gaze_runtime_version"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32","HEAPU8"]' \
  -o "$WASM_DIST/mnn-gaze-runtime.mjs"
cp "$MNN_SOURCE/LICENSE.txt" "$WASM_DIST/LICENSE-MNN-Apache-2.0.txt"
cp "$MNN_SOURCE/3rd_party/half/LICENSE.txt" "$WASM_DIST/LICENSE-half-MIT.txt"
cp "$MNN_SOURCE/3rd_party/flatbuffers/LICENSE.txt" "$WASM_DIST/LICENSE-flatbuffers-Apache-2.0.txt"
cp "$MODEL_BUILD_ROOT/upstream/LICENSE-CC-BY-NC-SA" "$WASM_DIST/LICENSE-GazeFollower-CC-BY-NC-SA-4.0.txt"
cp "$MODEL_BUILD_ROOT/upstream/gazefollower/res/model_weights/mobilenet_v4.mnn" "$WASM_DIST/mobilenet_v4.mnn"
cp "$MODEL_BUILD_ROOT/upstream/gazefollower/res/model_weights/base.mnn" "$WASM_DIST/base.mnn"
cp "$MODEL_BUILD_ROOT/mnn-gaze.mjs" "$WASM_DIST/mnn-gaze.mjs"
printf 'Built %s\n' "$WASM_DIST"
