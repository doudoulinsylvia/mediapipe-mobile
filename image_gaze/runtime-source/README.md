# Rebuild the public MNN WebAssembly bridge

This directory contains the source of the `mnn/` browser runtime. It is independent of the original developer's machine: the commands below start from a downloaded copy of this `runtime-source/` directory. Keep its files together and run the commands inside that directory. No author SDK, participant recordings, camera access, model training, or account credentials are required.

The public model checkpoints are from [GazeFollower](https://github.com/GanchengZhu/GazeFollower/tree/7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa), commit `7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa`. They are separate from the proprietary mobile SDK and are not claimed to reproduce the accuracy of the author's smartphone papers. GazeFollower models and the JavaScript adapter use **CC BY-NC-SA 4.0**; MNN uses **Apache-2.0**. The build copies these licenses and the half/FlatBuffers notices into `dist/`.

## Prerequisites and layout

A macOS or Linux shell with Git, Python 3.12 or later, and enough space for the Emscripten toolchain and MNN sources. Internet access is needed to obtain the public dependencies. The build was verified on macOS arm64; other host platforms have not been tested here.

The scripts expect this relative layout (names of the containing directories may differ):

```text
parent/
  .venv/                 Python environment created below
  runtime-source/        current directory
    mnn_gaze.cpp
    mnn-gaze.mjs
    build_wasm.sh
    asset-manifest.json
    build-tools-manifest.json
    emsdk/               official compiler checkout, created below
    upstream/            author source and weights, fetched below
    vendor/MNN-3.5.0/     official MNN source, extracted below
    dist/                generated deployable artifacts
```

## 1. Create local build dependencies

Run from `runtime-source/`. Activation does not modify shell startup profiles. These are the versions used for the published build.

```sh
python3 -m venv ../.venv
../.venv/bin/python -m pip install 'cmake==4.4.3' ninja
git clone https://github.com/emscripten-core/emsdk.git emsdk
git -C emsdk checkout 5eb0bde7585670252e8ba05e9d361627bffd08b5
```

## 2. Restore the exact assets in the published manifests

The following command downloads the immutable URLs and verifies their SHA-256 and byte counts **before writing or extracting them**. It also verifies the Git blob ID for each GazeFollower file. It does not execute the downloaded author Python modules.

Do not use `fetch_assets.py` to reproduce this release: that discovery script starts at the current upstream `main`, so a future run may select a newer revision. The manifest-based command below restores this release's fixed assets instead.

```sh
../.venv/bin/python - <<'PY'
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path.cwd()
assets = json.loads((root / 'asset-manifest.json').read_text())
assert assets['revision'] == '7096ed6b9969d4e67c2a78f6a9862407a0b2d5aa'


def download_verified(item, destination, git_blob=False):
    request = urllib.request.Request(item['source'], headers={'User-Agent': 'mnn-gaze-reproducible-build'})
    with urllib.request.urlopen(request, timeout=180) as response:
        data = response.read()
    assert len(data) == item['bytes'], f'Length mismatch: {destination}'
    assert hashlib.sha256(data).hexdigest() == item['sha256'], f'SHA-256 mismatch: {destination}'
    if git_blob:
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        assert blob == item['git_blob'], f'Git blob mismatch: {destination}'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    print('Verified', destination)

for item in assets['downloaded']:
    path = Path(item['path'])
    assert not path.is_absolute() and '..' not in path.parts
    download_verified(item, root / 'upstream' / path, git_blob=True)

expected_mnn_sha256 = '7a4db1df4bd6c2116841f90b51961b8cb9466d52520bc7893081bfa4c7e8a9be'
build = json.loads((root / 'build-tools-manifest.json').read_text())
assert len(build) == 1 and build[0]['name'] == 'MNN-3.5.0'
assert build[0]['sha256'] == expected_mnn_sha256
download_verified(build[0], root / 'downloads' / 'MNN-3.5.0.tar.gz')
PY
../.venv/bin/python bootstrap_build_tools.py
```

`bootstrap_build_tools.py` reuses the verified local MNN archive, extracts it with Python's safe data filter, and installs/activates Emscripten **4.0.14** in `emsdk/`. It does not install system-wide tools. The SDK launcher revision is pinned above; the Emscripten compiler version is separately pinned to 4.0.14. The SDK's helper Python/Node downloads may depend on host architecture and the SDK manifest.

## 3. Compile the bridge

```sh
bash build_wasm.sh
```

The build uses MNN **3.5.0**, CMake **4.4.3**, a single CPU thread, and WebAssembly SIMD. Thread pools, GPU backends, converters, training, demos, and LLM support are disabled. No `SharedArrayBuffer`, COOP/COEP headers, or threaded WASM are required. It does require a browser with module Web Workers and WebAssembly SIMD. Older iOS versions without these features are unsupported by this build.

`dist/` contains the JavaScript/WASM runtime, JavaScript input adapter, the original two `.mnn` weights, and license files. Publish only these generated files to the pilot's `mnn/` directory; do not publish the build toolchain, virtual environment, or temporary compiler outputs. Existing app files and worker remain separate.

`dist-manifest.json` records the hashes of the delivered artifacts. A rebuild is not claimed to be byte-identical across operating systems or compiler helper versions. Preserve the checkpoint hashes and verify numerical behavior after rebuilding.

## 4. Verify numerical behavior

A normal rebuild can compare against the **existing** `model-inspection.json` reference without installing Python MNN. After sourcing the SDK environment, its Node runtime is available through `EMSDK_NODE`:

```sh
source emsdk/emsdk_env.sh
"$EMSDK_NODE" test_wasm.mjs
```

This tests both genuine checkpoints with three deterministic tensor sets, input byte hashes, 258 finite outputs, Python-versus-WASM differences, wrong-length and NaN rejection, valid recovery, independent output storage, and disposal. The output is `wasm-parity.json`. The reference was generated with the author's MNN Python **Module API**, CPU, one thread, high precision, using MNN **3.6.1**. The WASM runtime is MNN **3.5.0**; this version difference is intentional and recorded. Numerical tolerance is `absolute difference <= 0.001 + 0.0001 * abs(reference)`.

To **regenerate** a native reference, use a host with an available MNN 3.6.1 Python wheel. Keep the original reference as an audit artifact before regeneration:

```sh
../.venv/bin/python -m pip install 'MNN==3.6.1' numpy
cp model-inspection.json model-inspection.published.json
../.venv/bin/python inspect_models.py
"$EMSDK_NODE" test_wasm.mjs
```

The browser app also contains `../selftest.html`. When served with the complete app over HTTPS or localhost, that page uses the production `../gaze-worker.mjs` and `../mnn/` assets. `?autorun=1` runs the numeric test. `?autorun=1&portrait=1` adds optional remote official portrait → FaceMesh → ROI preprocessing → model checks. It never opens the camera. Its JSON report appears in `#selftest-report` and can be downloaded.

**These are runtime and integration tests, not eye-tracking accuracy measurements.** Real phone speed, quality through eyeglasses, personal calibration, and independent known-target validation must still be measured in the pilot.

## Input API

```js
import { createGazeModel } from './mnn-gaze.mjs';
const model = await createGazeModel(modelBytesUint8Array, {
  locateFile: filename => new URL(filename, import.meta.url).href
});
const output = model.infer({ face, left, right, rect });
model.dispose();
```

`face`, `left`, `right`, and `rect` are `Float32Array` values with lengths 150528, 37632, 37632, and 12. Images are NHWC RGB in `[0,1]`; face size is 224×224, each eye 112×112, and the right eye is flipped horizontally after resize. The wrapper converts NHWC host inputs to the checkpoints' actual NCHW image tensors.

The output is a new `Float32Array(258)`. Its first two entries are raw model predictions and the remaining 256 entries are features. The app must apply a separately fitted personal mapping before interpreting predictions as normalized screen coordinates. The output is not clipped or silently calibrated by the runtime.
