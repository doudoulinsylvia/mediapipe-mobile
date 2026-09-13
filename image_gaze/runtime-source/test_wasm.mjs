import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGazeModel } from './dist/mnn-gaze.mjs';

const lengths = { face: 224 * 224 * 3, left: 112 * 112 * 3, right: 112 * 112 * 3, rect: 12 };
const expected = JSON.parse(await readFile(new URL('./model-inspection.json', import.meta.url)));

function fixture(name) {
  return Object.fromEntries(Object.entries(lengths).map(([key, count], index) => {
    let values;
    if (key === 'rect') {
      values = new Float32Array([.6, .8, .2, .1, .12, .12, .32, .32, .12, .12, .56, .32]);
      if (name === 'shifted_rect') for (const i of [2, 6, 10]) values[i] += Math.fround(.03);
    } else {
      values = new Float32Array(count);
      for (let i = 0; i < count; i++) values[i] = name === 'flat' ? .5 : ((i * 17 + index * 31) % 251) / 250;
    }
    return [key, values];
  }));
}

const report = { purpose: 'numeric_runtime_parity_not_participant_accuracy', models: {}, assertions: [] };
for (const name of ['base', 'mobilenet_v4']) {
  const model = await createGazeModel(new Uint8Array(await readFile(new URL(`./dist/${name}.mnn`, import.meta.url))));
  const record = { runtimeVersion: model.version, cases: {} };
  for (const caseName of ['flat', 'pattern', 'shifted_rect']) {
    const inputs = fixture(caseName);
    for (const [key, values] of Object.entries(inputs)) {
      assert.equal(createHash('sha256').update(new Uint8Array(values.buffer)).digest('hex'),
        expected.fixtures[caseName].input_sha256[key], 'JS and native must receive identical input bytes');
    }
    const timings = [];
    let actual;
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      actual = model.infer(inputs);
      timings.push(performance.now() - start);
    }
    const reference = expected.models[name].cases[caseName].output;
    assert.equal(actual.length, 258);
    let maxAbsoluteDifference = 0;
    let maxToleranceRatio = 0;
    for (let i = 0; i < actual.length; i++) {
      assert.ok(Number.isFinite(actual[i]));
      const delta = Math.abs(actual[i] - reference[i]);
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, delta);
      maxToleranceRatio = Math.max(maxToleranceRatio, delta / (1e-3 + 1e-4 * Math.abs(reference[i])));
    }
    record.cases[caseName] = { maxAbsoluteDifference, maxToleranceRatio,
      medianInferenceMs: timings.slice(1).sort((a, b) => a - b)[2], outputXY: Array.from(actual.slice(0, 2)) };
    assert.ok(maxToleranceRatio <= 1, `${name}/${caseName} differs from native reference: ${maxToleranceRatio}`);
  }
  const inputs = fixture('pattern');
  const saved = model.infer(inputs);
  const savedCopy = Float32Array.from(saved);
  model.infer(fixture('flat'));
  assert.deepEqual(saved, savedCopy, 'prior output must retain its values');
  assert.throws(() => model.infer({ ...inputs, rect: new Float32Array(11) }), /rect must contain/);
  inputs.face[0] = Number.NaN;
  assert.throws(() => model.infer(inputs), /nonfinite_input/);
  assert.equal(model.infer(fixture('flat')).length, 258, 'valid inference can resume after rejected input');
  model.dispose();
  model.dispose();
  assert.throws(() => model.infer(fixture('flat')), /disposed/);
  report.models[name] = record;
}
report.assertions = ['two genuine model binaries load', 'four input contracts and 258 finite outputs',
  'six model/fixture native-WASM comparisons', 'independent returned output storage',
  'wrong lengths rejected', 'NaN rejected with valid recovery', 'idempotent disposal'];
await writeFile(new URL('./wasm-parity.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
