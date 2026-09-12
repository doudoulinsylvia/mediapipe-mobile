'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const GazeCore = require('../shared/gaze-core.js');

const targets = [0.1, 0.5, 0.9].flatMap((x, column) => [0.1, 0.5, 0.9].map((y, row) => ({ targetId: `${column}-${row}`, targetX: x, targetY: y })));
function features(x, y) {
  return [0.10 * (x - 0.5) + 0.02 * (y - 0.5), -0.01 * (x - 0.5) + 0.12 * (y - 0.5),
    0.11 * (x - 0.5) - 0.02 * (y - 0.5), 0.005 * (x - 0.5) + 0.13 * (y - 0.5)];
}
function calibrationSamples(count = 16) {
  return targets.flatMap((target, ti) => Array.from({ length: count }, (_, i) => ({ ...target,
    features: features(target.targetX, target.targetY), timestamp: ti * 3000 + i * 40 })));
}
function validationSamples(offsetX = 0, offsetY = 0, count = 16) {
  return targets.flatMap((target, ti) => Array.from({ length: count }, (_, i) => ({ ...target,
    x: target.targetX + offsetX, y: target.targetY + offsetY, valid: true, timestamp: ti * 3000 + i * 40 })));
}
function eyeLandmarks(width, height, { roll = 0.2, earLeft = 0.24, earRight = 0.24, x = 0.04, y = 0.03 } = {}) {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eyeWidth = 70, ux = Math.cos(roll), uy = Math.sin(roll);
  function build(cx, cy, indices, ear) {
    function point(index, localX, localY) {
      points[index] = { x: (cx + eyeWidth * (localX * ux - localY * uy)) / width,
        y: (cy + eyeWidth * (localX * uy + localY * ux)) / height, z: 0 };
    }
    const [a, b, upperA, lowerA, upperB, lowerB, iris, irisA, irisB] = indices;
    point(a, -0.5, 0); point(b, 0.5, 0);
    point(upperA, -0.15, -ear / 2); point(lowerA, -0.15, ear / 2);
    point(upperB, 0.15, -ear / 2); point(lowerB, 0.15, ear / 2);
    point(iris, x, y); point(irisA, x - 0.12, y); point(irisB, x + 0.12, y);
  }
  build(width / 2 - 60, height / 2, [33, 133, 159, 145, 158, 153, 468, 469, 471], earLeft);
  build(width / 2 + 60, height / 2 + 15, [362, 263, 386, 374, 385, 380, 473, 474, 476], earRight);
  return points;
}

test('affine ridge recovers two-dimensional held-out positions and survives JSON roundtrip', () => {
  const fitted = GazeCore.createCalibration(calibrationSamples());
  assert.equal(fitted.ok, true, JSON.stringify(fitted.diagnostics));
  const model = JSON.parse(JSON.stringify(fitted.model));
  for (const [x, y] of [[0.23, 0.68], [0.77, 0.34], [0.37, 0.21], [0.81, 0.79]]) {
    const predicted = GazeCore.predict(model, features(x, y));
    assert.equal(predicted.ok, true);
    assert.ok(Math.hypot(predicted.x - x, predicted.y - y) < 0.01);
  }
  const outside = GazeCore.predict(model, features(1.4, -0.4));
  assert.ok(outside.x > 1 && outside.y < 0, 'predictions must remain unclipped');
});

test('calibration weights targets equally despite uneven sample counts', () => {
  const samples = calibrationSamples();
  const baseline = GazeCore.createCalibration(samples).model;
  const unbalanced = GazeCore.createCalibration(samples.concat(Array.from({ length: 300 }, () => ({ ...samples[0] })))).model;
  for (const axis of ['coefficientsX', 'coefficientsY']) {
    baseline[axis].forEach((value, i) => assert.ok(Math.abs(value - unbalanced[axis][i]) < 1e-10));
  }
});

test('constant and one-dimensional eye movement cannot produce a calibration', () => {
  const constant = calibrationSamples().map(s => ({ ...s, features: [0.1, 0.2, 0.1, 0.2] }));
  assert.equal(GazeCore.createCalibration(constant).ok, false);
  const line = calibrationSamples().map(s => ({ ...s, features: [s.targetX, s.targetX, s.targetX, s.targetX] }));
  assert.equal(GazeCore.createCalibration(line).reason, 'degenerate_two_dimensional_features');
  const narrow = calibrationSamples().map(s => ({ ...s, targetY: 0.5 }));
  assert.equal(GazeCore.createCalibration(narrow).reason, 'insufficient_target_span');
});

test('missing targets, under-sampled points and nonfinite calibration data are rejected', () => {
  const samples = calibrationSamples();
  assert.equal(GazeCore.createCalibration(samples.filter(s => s.targetId !== '0-0'), { expectedTargetIds: targets.map(t => t.targetId) }).reason, 'missing_calibration_target');
  assert.equal(GazeCore.createCalibration(calibrationSamples(2)).reason, 'insufficient_samples_per_target');
  const withNaN = samples.concat({ ...samples[0], features: [NaN, 0, 0, 0] });
  const fit = GazeCore.createCalibration(withNaN);
  assert.equal(fit.ok, true);
  assert.equal(fit.diagnostics.rejectedSamples, 1);
  assert.equal(GazeCore.predict(fit.model, [NaN, 0, 0, 0]).ok, false);
  assert.equal(GazeCore.predict(fit.model, [1, 2]).ok, false);
  assert.equal(GazeCore.predict({ ...fit.model, coefficientsY: [Infinity] }, features(0.5, 0.5)).ok, false);
});

test('valid independent multi-point validation passes, with transparent normalized errors', () => {
  const report = GazeCore.evaluateValidation(validationSamples(0.02, -0.03), { expectedTargets: targets });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.coverage, 1);
  assert.equal(report.validCount, 144);
  assert.ok(Math.abs(report.meanErrorNorm - Math.hypot(0.02, 0.03)) < 1e-12);
  assert.ok(Math.abs(report.meanAbsErrorX - 0.02) < 1e-12);
  assert.ok(Math.abs(report.meanAbsErrorY - 0.03) < 1e-12);
  assert.ok(Math.abs(report.biasY + 0.03) < 1e-12);
});

test('either failed axis blocks validation even with permissive combined error thresholds', () => {
  const relaxedNorm = { expectedTargets: targets, maxMeanErrorNorm: 1, maxP95ErrorNorm: 1, maxPointMeanErrorNorm: 1, maxPointP95ErrorNorm: 1 };
  const badX = GazeCore.evaluateValidation(validationSamples(0.15, 0), relaxedNorm);
  const badY = GazeCore.evaluateValidation(validationSamples(0, 0.15), relaxedNorm);
  assert.equal(badX.passed, false); assert.equal(badY.passed, false);
  assert.ok(badX.failures.includes('meanAbsErrorX_exceeded'));
  assert.ok(badY.failures.includes('meanAbsErrorY_exceeded'));
});

test('within-target spread separates jitter from a common bias without adding a pass gate', () => {
  const stableSamples = validationSamples(0.02, -0.03);
  const jitteredSamples = stableSamples.map((sample, index) => ({ ...sample,
    x: sample.x + (index % 2 ? 0.01 : -0.01), y: sample.y + (index % 2 ? 0.02 : -0.02) }));
  const stable = GazeCore.evaluateValidation(stableSamples, { expectedTargets: targets });
  const jittered = GazeCore.evaluateValidation(jitteredSamples, { expectedTargets: targets });
  assert.equal(stable.passed, true); assert.equal(jittered.passed, true);
  assert.ok(Math.abs(stable.biasX - jittered.biasX) < 1e-12);
  assert.ok(Math.abs(stable.biasY - jittered.biasY) < 1e-12);
  assert.ok(stable.sdX < 1e-12 && stable.sdY < 1e-12 && stable.radialRmsAroundMean < 1e-12);
  assert.ok(Math.abs(jittered.sdX - 0.01) < 1e-12);
  assert.ok(Math.abs(jittered.sdY - 0.02) < 1e-12);
  assert.ok(Math.abs(jittered.radialRmsAroundMean - Math.hypot(0.01, 0.02)) < 1e-12);
  assert.equal(jittered.precisionPointCount, 9);
  jittered.pointSummaries.forEach(point => assert.ok(Math.abs(point.radialRmsAroundMean - Math.hypot(0.01, 0.02)) < 1e-12));
  assert.equal(jittered.diagnostics.precision.passGate, false);
  const uneven = jitteredSamples.concat(Array.from({ length: 200 }, (_, i) => ({ ...jitteredSamples[i % 2], timestamp: 640 + i * 40 })));
  const repeated = GazeCore.evaluateValidation(uneven, { expectedTargets: targets });
  assert.ok(Math.abs(repeated.sdX - jittered.sdX) < 1e-12);
  assert.ok(Math.abs(repeated.radialRmsAroundMean - jittered.radialRmsAroundMean) < 1e-12);
  const single = GazeCore.evaluateValidation(validationSamples(0, 0, 1), { expectedTargets: targets });
  assert.equal(single.sdX, null); assert.equal(single.radialRmsAroundMean, null);
  assert.equal(single.precisionPointCount, 0);
});

test('invalid attempts and NaN are included in coverage denominator, not error metrics', () => {
  const samples = validationSamples().map((s, i) => i % 4 === 0 ? { ...s, x: NaN } : s);
  const report = GazeCore.evaluateValidation(samples, { expectedTargets: targets });
  assert.equal(report.passed, false);
  assert.equal(report.coverage, 0.75);
  assert.equal(report.sampleCoverage, 0.75);
  assert.equal(report.diagnostics.invalidReasons.nonfinite_prediction, 36);
  assert.equal(report.meanErrorNorm, 0);
  const noFace = GazeCore.evaluateValidation(validationSamples().map(s => ({ ...s, valid: false, reason: 'no_face', x: null, y: null })), { expectedTargets: targets });
  assert.equal(noFace.passed, false); assert.equal(noFace.coverage, 0);
  assert.equal(noFace.meanErrorNorm, null);
  assert.equal(noFace.diagnostics.invalidReasons.no_face, 144);
});

test('missing expected target has zero coverage and cannot pass despite other perfect points', () => {
  const report = GazeCore.evaluateValidation(validationSamples().filter(s => s.targetId !== '0-0'), { expectedTargets: targets });
  assert.equal(report.passed, false);
  assert.equal(report.pointSummaries.find(p => p.targetId === '0-0').coverage, 0);
  assert.ok(Math.abs(report.coverage - 8 / 9) < 1e-12);
  assert.equal(report.sampleCoverage, 1);
  const centerOnly = GazeCore.evaluateValidation(validationSamples().filter(s => s.targetId === '1-1'));
  assert.equal(centerOnly.passed, false);
  assert.ok(centerOnly.failures.includes('insufficient_validation_target_span'));
});

test('short, duplicate-time, missing-time and discontinuous validation cannot pass', () => {
  const opts = { expectedTargets: targets };
  assert.equal(GazeCore.evaluateValidation(validationSamples(0, 0, 3), opts).passed, false);
  assert.equal(GazeCore.evaluateValidation(validationSamples().map(s => ({ ...s, timestamp: undefined })), opts).passed, false);
  const duplicate = GazeCore.evaluateValidation(validationSamples().map(s => ({ ...s, timestamp: 1 })), opts);
  assert.equal(duplicate.passed, false);
  assert.ok(duplicate.pointSummaries[0].failures.includes('nonmonotonic_timestamps'));
  const gaps = GazeCore.evaluateValidation(validationSamples().map((s, i) => ({ ...s, timestamp: s.timestamp + (i % 16 >= 8 ? 1000 : 0) })), opts);
  assert.equal(gaps.passed, false);
  assert.ok(gaps.pointSummaries[0].failures.includes('discontinuous_valid_samples'));
});

test('per-point errors cannot be hidden by numerous accurate samples on another target', () => {
  const samples = validationSamples();
  samples.forEach(s => { if (s.targetId === '0-0') s.y += 0.35; });
  const additional = Array.from({ length: 1000 }, (_, i) => ({ ...samples[32], timestamp: 6640 + i * 40 }));
  const report = GazeCore.evaluateValidation(samples.concat(additional), { expectedTargets: targets });
  assert.equal(report.passed, false);
  assert.ok(Math.abs(report.meanErrorNorm - 0.35 / 9) < 1e-12, 'targets must be equally weighted regardless of their sample counts');
  assert.ok(report.pointSummaries.find(p => p.targetId === '0-0').failures.includes('point_y_mean_error'));
});

test('repeated or collinear target positions cannot masquerade as a two-dimensional layout', () => {
  const diagonal = validationSamples().map(s => ({ ...s, targetY: s.targetX, y: s.targetX }));
  assert.equal(GazeCore.evaluateValidation(diagonal).passed, false);
  assert.ok(GazeCore.evaluateValidation(diagonal).failures.includes('degenerate_validation_target_layout'));
  const duplicate = calibrationSamples().map(s => ({ ...s, targetY: s.targetX }));
  assert.equal(GazeCore.createCalibration(duplicate).reason, 'degenerate_target_layout');
});

test('aggregate validation errors do not change when one target is sampled more often', () => {
  const samples = validationSamples().map(s => ({ ...s, x: s.x + (s.targetId === '0-0' ? 0.06 : 0.01) }));
  const baseline = GazeCore.evaluateValidation(samples, { expectedTargets: targets });
  const more = samples.concat(Array.from({ length: 200 }, (_, i) => ({ ...samples[0], timestamp: 640 + i * 40 })));
  const repeated = GazeCore.evaluateValidation(more, { expectedTargets: targets });
  assert.equal(repeated.passed, true);
  assert.ok(Math.abs(baseline.meanErrorNorm - repeated.meanErrorNorm) < 1e-12);
  assert.ok(Math.abs(baseline.p95ErrorNorm - repeated.p95ErrorNorm) < 1e-12);
});

test('eye geometry restores camera aspect ratio before local projection', () => {
  for (const [width, height] of [[480, 640], [1280, 720], [640, 640]]) {
    const result = GazeCore.extractFeatures(eyeLandmarks(width, height), width, height);
    assert.equal(result.quality.valid, true, result.quality.reason);
    result.features.forEach((value, i) => assert.ok(Math.abs(value - (i % 2 ? 0.03 : 0.04)) < 1e-12));
    assert.ok(Math.abs(result.quality.leftEAR - 0.24) < 1e-12);
    assert.ok(Math.abs(result.iris.meanRatio - 0.24) < 1e-12);
  }
  const landmarks = eyeLandmarks(1280, 720);
  const correct = GazeCore.extractFeatures(landmarks, 1280, 720);
  const wrongAspect = GazeCore.extractFeatures(landmarks, 720, 720);
  assert.ok(Math.abs(correct.features[1] - wrongAspect.features[1]) > 0.005);
});

test('vertical feature uses eye width and does not change with eyelid opening', () => {
  const normal = GazeCore.extractFeatures(eyeLandmarks(640, 480), 640, 480);
  const narrowed = GazeCore.extractFeatures(eyeLandmarks(640, 480, { earLeft: 0.12, earRight: 0.13 }), 640, 480);
  assert.equal(narrowed.quality.valid, true);
  assert.deepEqual(normal.features, narrowed.features);
  assert.notEqual(normal.quality.leftEAR, narrowed.quality.leftEAR);
});

test('both eyes must be open; incomplete, nonfinite and tiny geometry is rejected', () => {
  for (const options of [{ earLeft: 0.03 }, { earRight: 0.03 }]) {
    const result = GazeCore.extractFeatures(eyeLandmarks(640, 480, options), 640, 480);
    assert.equal(result.quality.valid, false);
    assert.equal(result.quality.reason, 'eye_closed_or_occluded');
    assert.deepEqual(result.features, []);
  }
  assert.equal(GazeCore.extractFeatures([], 640, 480).quality.reason, 'no_face');
  assert.equal(GazeCore.extractFeatures([{ x: 0, y: 0 }], 640, 480).quality.valid, false);
  const bad = eyeLandmarks(640, 480); bad[468].x = NaN;
  assert.equal(GazeCore.extractFeatures(bad, 640, 480).quality.valid, false);
  assert.equal(GazeCore.extractFeatures(eyeLandmarks(640, 480), 0, 480).quality.valid, false);
  assert.equal(GazeCore.extractFeatures(eyeLandmarks(640, 480), 10, 10).quality.reason, 'eye_geometry_too_small');
});

test('temporal quality starts with a healthy frame and leaves raw quality unchanged', () => {
  const quality = Object.freeze(GazeCore.extractFeatures(eyeLandmarks(640, 480), 640, 480).quality);
  const gate = GazeCore.createTemporalQualityGate();
  assert.deepEqual(gate.update(quality, 0), { valid: true, reason: null, rawValid: true,
    recovering: false, stableFrames: 1, msSinceInvalid: null });
  for (let timestamp = 30; timestamp <= 300; timestamp += 30) assert.equal(gate.update(quality, timestamp).valid, true);
  assert.equal(gate.update(quality, 330).stableFrames, 3, 'stable count saturates');
  assert.equal(quality.valid, true);
});

test('temporal quality rejects observed 13, 14 and 52 ms post-blink frames despite valid geometry', () => {
  const closed = GazeCore.extractFeatures(eyeLandmarks(640, 480, { earLeft: 0.03 }), 640, 480).quality;
  const reopened = GazeCore.extractFeatures(eyeLandmarks(640, 480, { earLeft: 0.12, earRight: 0.13 }), 640, 480).quality;
  assert.equal(reopened.valid, true, 'single-frame EAR gates still allow a reopened eye');
  for (const delay of [13, 14, 52]) {
    const gate = GazeCore.createTemporalQualityGate();
    assert.equal(gate.update(closed, 1000).reason, 'eye_closed_or_occluded');
    const result = gate.update(reopened, 1000 + delay);
    assert.equal(result.valid, false); assert.equal(result.rawValid, true);
    assert.equal(result.reason, 'temporal_recovery'); assert.equal(result.msSinceInvalid, delay);
  }
});

test('temporal quality requires both 100 ms recovery and three consecutive valid frames', () => {
  const healthy = { valid: true }, invalid = { valid: false, reason: 'eye_closed_or_occluded' };
  const gate = GazeCore.createTemporalQualityGate();
  gate.update(invalid, 0);
  assert.equal(gate.update(healthy, 30).valid, false);
  assert.equal(gate.update(healthy, 60).valid, false);
  const thirdEarly = gate.update(healthy, 99);
  assert.equal(thirdEarly.stableFrames, 3); assert.equal(thirdEarly.valid, false);
  assert.equal(gate.update(healthy, 100).valid, true, '100 ms is inclusive when enough frames exist');
  gate.update(invalid, 200);
  const firstLate = gate.update(healthy, 300);
  assert.equal(firstLate.stableFrames, 1); assert.equal(firstLate.valid, false, 'time alone is insufficient');
  assert.equal(gate.update(healthy, 330).valid, false);
  assert.equal(gate.update(healthy, 360).valid, true);
  gate.update(invalid, 400); gate.update(healthy, 430);
  gate.update(invalid, 440);
  assert.equal(gate.update(healthy, 540).stableFrames, 1, 'another invalid frame resets the streak');
  assert.equal(gate.update(healthy, 550).valid, false);
  assert.equal(gate.update(healthy, 560).valid, true);
});

test('temporal quality recovers after no face and any other invalid or missing quality', () => {
  const noFace = GazeCore.extractFeatures([], 640, 480).quality;
  for (const quality of [noFace, { valid: false, reason: 'implausible_eye_geometry' }, null, {}, { valid: 1 }]) {
    const gate = GazeCore.createTemporalQualityGate();
    assert.equal(gate.update({ valid: true }, 0).valid, true);
    const rejected = gate.update(quality, 30);
    assert.equal(rejected.valid, false); assert.equal(rejected.rawValid, false);
    assert.equal(rejected.reason, quality && quality.reason || 'invalid_quality');
    assert.equal(gate.update({ valid: true }, 130).valid, false);
    assert.equal(gate.update({ valid: true }, 160).valid, false);
    assert.equal(gate.update({ valid: true }, 190).valid, true);
  }
});

test('temporal quality recollects a stable streak after gaps greater than 500 ms', () => {
  const gate = GazeCore.createTemporalQualityGate(), healthy = { valid: true };
  gate.update(healthy, 0);
  assert.equal(gate.update(healthy, 500).valid, true, 'exactly 500 ms is not a long gap');
  const afterGap = gate.update(healthy, 1001);
  assert.equal(afterGap.valid, false); assert.equal(afterGap.reason, 'temporal_gap_recovery');
  assert.equal(afterGap.stableFrames, 1); assert.equal(afterGap.msSinceInvalid, null);
  assert.equal(gate.update(healthy, 1030).valid, false);
  assert.equal(gate.update(healthy, 1060).valid, true);
  gate.update({ valid: false, reason: 'no_face' }, 1100);
  assert.equal(gate.update(healthy, 1700).valid, false, 'a gap does not bypass an earlier recovery');
  assert.equal(gate.update(healthy, 1730).valid, false);
  assert.equal(gate.update(healthy, 1760).valid, true);
});

test('temporal quality rejects bad and duplicate or reverse timestamps then safely rebases', () => {
  for (const timestamp of [NaN, Infinity, -1, undefined, '100', 100, 99]) {
    const gate = GazeCore.createTemporalQualityGate(), healthy = { valid: true };
    gate.update(healthy, 100);
    const rejected = gate.update(healthy, timestamp);
    assert.equal(rejected.valid, false); assert.equal(rejected.rawValid, true);
    assert.equal(rejected.reason, timestamp === 100 || timestamp === 99 ? 'nonmonotonic_timestamp' : 'invalid_timestamp');
    assert.equal(rejected.stableFrames, 0); assert.equal(rejected.msSinceInvalid, null);
    const rebased = gate.update(healthy, 1000);
    assert.equal(rebased.valid, false); assert.equal(rebased.msSinceInvalid, 0);
    assert.equal(gate.update(healthy, 1030).valid, false);
    assert.equal(gate.update(healthy, 1099).valid, false);
    assert.equal(gate.update(healthy, 1100).valid, true);
  }
});

test('temporal quality reset starts a new stream and options control documented boundaries', () => {
  const gate = GazeCore.createTemporalQualityGate({ recoveryMs: 40, minStableFrames: 2, maxGapMs: 100 });
  const healthy = { valid: true };
  gate.update({ valid: false, reason: 'no_face' }, 1000);
  assert.equal(gate.update(healthy, 1039).valid, false);
  assert.equal(gate.update(healthy, 1040).valid, true);
  assert.equal(gate.update(healthy, 1141).valid, false);
  assert.equal(gate.update(healthy, 1142).valid, true);
  gate.update({ valid: false }, 1200);
  gate.reset();
  assert.deepEqual(gate.update(healthy, 0), { valid: true, reason: null, rawValid: true,
    recovering: false, stableFrames: 1, msSinceInvalid: null });
  for (const options of [{ recoveryMs: -1 }, { recoveryMs: NaN }, { minStableFrames: 0 },
    { minStableFrames: 1.5 }, { maxGapMs: 0 }, { maxGapMs: Infinity }]) {
    assert.throws(() => GazeCore.createTemporalQualityGate(options), RangeError);
  }
});

test('UMD exposes the same API in a browser without module dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/gaze-core.js'), 'utf8'), context);
  assert.equal(typeof context.GazeCore.extractFeatures, 'function');
  assert.equal(typeof context.GazeCore.createTemporalQualityGate, 'function');
  assert.equal(context.GazeCore.version, GazeCore.version);
});
