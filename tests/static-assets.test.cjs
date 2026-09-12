'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

test('both revised entry points resolve local scripts and styles', () => {
  for (const entry of ['food2/revised.html', 'food3_formal/revised.html','food2/revised-tasks.html','food3_formal/revised-tasks.html']) {
    const html = fs.readFileSync(path.join(root, entry), 'utf8');
    const sources = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1].split('?')[0]);
    assert.ok(sources.some(s => s.endsWith('gaze-core.js')));
    assert.ok(sources.some(s => s.endsWith('experiment-v2.js')));
    assert.ok(sources.some(s => s.endsWith('validation-report.js')));
    assert.ok(sources.some(s => s.endsWith('calibration-report.js')));
    assert.ok(sources.some(s => s.endsWith('calibration-stability.js')));
    assert.ok(sources.some(s => s.endsWith('calibration-consistency.js')));
    assert.ok(sources.some(s => s.endsWith('gaze-filter.js')));
    assert.ok(sources.some(s => s.endsWith('tracking-adapter.js')));
    for (const source of sources) {
      if (source.startsWith('#')) continue;
      assert.ok(!/^(https?:)?\/\//.test(source), `external dependency: ${source}`);
      assert.ok(fs.statSync(path.resolve(root, path.dirname(entry), source)).isFile(), source);
    }
    assert.ok(html.indexOf('gaze-core.js') < html.indexOf('experiment-v2.js'), 'core loads first');
    assert.ok(html.indexOf('validation-report.js') < html.indexOf('experiment-v2.js'), 'report formatter loads before app');
    assert.ok(html.indexOf('calibration-report.js') < html.indexOf('experiment-v2.js'), 'calibration formatter loads before app');
    for(const name of ['calibration-consistency.js','gaze-filter.js'])assert.ok(html.indexOf(name)<html.indexOf('experiment-v2.js'));
  }
});

test('Tasks comparison resources are version pinned and match their SHA-256 inventory', () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'shared/tasks-vision/0.10.32/manifest.json')));
  assert.equal(manifest.version,'0.10.32');assert.equal(manifest.modelVersion,'face_landmarker/float16/1');
  assert.equal(manifest.license,'Apache-2.0');assert.ok(manifest.packageIntegrity.startsWith('sha512-'));
  for(const file of manifest.files) {
    const data=fs.readFileSync(path.join(root,file.path));
    assert.equal(data.length,file.bytes,file.path);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),file.sha256,file.path);
  }
  for(const filename of ['vision_bundle.mjs','face_landmarker.task','wasm/vision_wasm_internal.wasm','wasm/vision_wasm_nosimd_internal.wasm'])
    assert.ok(manifest.files.some(file=>file.path.endsWith('/'+filename)),filename);
});

test('pinned FaceMesh runtime and model assets are present and match recorded hashes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/vendor-manifest.json')));
  assert.equal(manifest.packageVersion, '0.4.1633559619');
  const required = [
    'face_mesh.js', 'camera_utils.js', 'face_mesh.binarypb',
    'face_mesh_solution_packed_assets_loader.js', 'face_mesh_solution_packed_assets.data',
    'face_mesh_solution_simd_wasm_bin.js', 'face_mesh_solution_simd_wasm_bin.wasm',
    'face_mesh_solution_wasm_bin.js', 'face_mesh_solution_wasm_bin.wasm'
  ];
  for (const file of required) assert.ok(manifest.files.some(f => f.path.endsWith('/' + file)), file);
  for (const file of manifest.files) {
    const data = fs.readFileSync(path.join(root, file.path));
    assert.equal(data.length, file.bytes, file.path);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), file.sha256, file.path);
    if (file.path.endsWith('.wasm')) assert.deepEqual([...data.subarray(0, 4)], [0, 97, 115, 109]);
  }
});

test('all 200 rating stimuli exist in each layout dataset', () => {
  for (const folder of ['food2/images', 'food3/images']) {
    for (let i = 1; i <= 200; i++) {
      const data = fs.readFileSync(path.join(root, folder, `${i}.jpg`));
      assert.ok(data.length > 100, `${folder}/${i}.jpg is empty`);
      assert.equal(data[0], 0xff);
      assert.equal(data[1], 0xd8);
    }
  }
});
