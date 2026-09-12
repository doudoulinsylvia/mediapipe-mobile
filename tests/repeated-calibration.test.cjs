'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../shared/gaze-core.js');
const targets = [.08, .5, .92].flatMap((y, row) => [.08, .5, .92].map((x, column) => ({ targetId: `c${row * 3 + column + 1}`, targetX: x, targetY: y })));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function samples({ count = 16, changingEyeDifference = false, roundTwoDifference = -.8, jitterMagnitude = .001 } = {}) {
  return [1, 2].flatMap(roundIndex => targets.flatMap(target => Array.from({ length: count }, (_, frame) => {
    const x = (target.targetX - .5) * .1, y = (target.targetY - .5) * .12;
    const jitter = frame % 2 ? jitterMagnitude : -jitterMagnitude;
    const difference = changingEyeDifference ? (roundIndex === 1 ? .8 : roundTwoDifference) : .1;
    return { ...target, roundIndex, presentationId: `round-${roundIndex}-${target.targetId}`, valid: true,
      features: [x + difference * x + jitter, y + difference * y, x - difference * x - jitter, y - difference * y] };
  })));
}
const fit = data => Core.createRepeatedCalibration(data, { expectedTargets: targets });
const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('two complete rounds compare fixed candidates, preserve raw input and require subsequent validation', () => {
  const data = samples(), snapshot = JSON.stringify(data);
  const result = fit(data);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(JSON.stringify(data), snapshot);
  assert.equal(result.diagnostics.expectedRoundCount, 2); assert.equal(result.diagnostics.expectedTargetCount, 9);
  assert.deepEqual(result.diagnostics.candidates.map(candidate => candidate.id), ['four_eye_affine', 'binocular_mean_affine']);
  for (const candidate of result.diagnostics.candidates) {
    assert.equal(candidate.ok, true); assert.equal(candidate.finalFit.ok, true);
    assert.deepEqual(candidate.folds.map(fold => [fold.trainRoundIndex, fold.testRoundIndex]), [[1, 2], [2, 1]]);
    assert.equal(candidate.perTarget.length, 9);
    close(candidate.score, mean(candidate.folds.map(fold => fold.metrics.meanErrorNorm)));
    for (const fold of candidate.folds) close(fold.metrics.meanErrorNorm, mean(fold.perTarget.map(point => point.metrics.meanErrorNorm)));
  }
  assert.ok(result.diagnostics.candidates.every(candidate => candidate.finalFit.diagnostics.settings.ridgeLambda === .01));
  assert.match(result.diagnostics.note, /not independent accuracy validation/);
  assert.equal(result.diagnostics.passed, undefined); assert.equal(result.model.calibrationRoundCount, 2);
});

test('each of the eighteen presentations must independently contain twelve valid frames', () => {
  const data = samples();
  const missing = fit(data.filter(sample => sample.roundIndex === 1));
  assert.equal(missing.ok, false); assert.equal(missing.reason, 'incomplete_calibration_round');
  assert.equal(missing.diagnostics.roundSummaries[1].presentationCount, 0);
  const tooFew = data.map((sample, index) => sample.roundIndex === 2 && sample.targetId === 'c1' && index % 16 >= 11
    ? { ...sample, valid: false, reason: 'temporal_recovery' } : sample);
  const extraFirstRound = tooFew.filter(sample => sample.roundIndex === 1 && sample.targetId === 'c1');
  const result = fit(tooFew.concat(...Array.from({ length: 20 }, () => extraFirstRound)));
  assert.equal(result.ok, false); assert.equal(result.reason, 'insufficient_samples_per_presentation');
  const second = result.diagnostics.roundSummaries[1];
  assert.equal(second.presentations.find(point => point.targetId === 'c1').validCount, 11);
  assert.equal(second.invalidReasons.temporal_recovery, 5);
  const exact = fit(samples({ count: 12 })); assert.equal(exact.ok, true);
});

test('invalid geometry is filtered internally while invalid attempts stay in round diagnostics', () => {
  const data = samples();
  const invalid = [{ ...data[0], valid: false, reason: 'no_face', features: [] },
    { ...data[0], features: [NaN, 0, 0, 0] }, { ...data[0], valid: 1 }];
  const baseline = fit(data), result = fit(data.concat(invalid));
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.attemptCount, data.length + 3); assert.equal(result.diagnostics.validCount, data.length);
  assert.equal(result.diagnostics.roundSummaries[0].invalidReasons.no_face, 1);
  assert.equal(result.diagnostics.roundSummaries[0].invalidReasons.invalid_features, 2);
  assert.deepEqual(result.model, baseline.model);
});

test('presentation and target metadata cannot silently combine unrelated segments or rounds', () => {
  for (const [change, reason] of [
    [sample => ({ ...sample, roundIndex: 3 }), 'unexpected_calibration_round'],
    [sample => ({ ...sample, presentationId: '' }), 'missing_presentation_id'],
    [sample => ({ ...sample, targetX: .2 }), 'inconsistent_calibration_target'],
    [sample => ({ ...sample, presentationId: 'round-2-c1' }), 'presentation_id_reused'],
    [sample => ({ ...sample, presentationId: 'another-first-point-segment' }), 'duplicate_target_presentation']
  ]) {
    const data = samples(); data[1] = change(data[1]);
    const result = fit(data); assert.equal(result.ok, false);
    assert.ok(result.diagnostics.integrityFailures.includes(reason), JSON.stringify(result.diagnostics.integrityFailures));
  }
  assert.equal(Core.createRepeatedCalibration(samples(), { expectedTargets: targets.slice(1) }).reason, 'expected_nine_calibration_targets');
  assert.equal(Core.createRepeatedCalibration(samples(), { expectedTargets: targets, minSamplesPerPresentation: 1 }).reason, 'invalid_repeated_calibration_options');
  assert.equal(Core.createRepeatedCalibration(samples(), null).reason, 'invalid_repeated_calibration_options');
});

test('cross-round scores exactly match independently retraining each fold on its training round', () => {
  const data = samples({ changingEyeDifference: true }), result = fit(data);
  for (const candidate of result.diagnostics.candidates) {
    const transform = f => candidate.id === 'binocular_mean_affine' ? [(f[0] + f[2]) / 2, (f[1] + f[3]) / 2] : f;
    for (const fold of candidate.folds) {
      const train = data.filter(sample => sample.roundIndex === fold.trainRoundIndex).map(sample => ({ ...sample, features: transform(sample.features) }));
      const direct = Core.createCalibration(train, { minTargetCount: 9, minSamplesPerTarget: 12, ridgeLambda: .01 });
      assert.equal(direct.ok, true);
      const errors = targets.map(target => mean(data.filter(sample => sample.roundIndex === fold.testRoundIndex && sample.targetId === target.targetId).map(sample => {
        const point = Core.predict(direct.model, transform(sample.features));
        return Math.hypot(point.x - sample.targetX, point.y - sample.targetY);
      })));
      close(fold.score, mean(errors));
      fold.perTarget.forEach(point => close(point.metrics.meanErrorNorm, errors[targets.findIndex(target => target.targetId === point.targetId)]));
    }
  }
  assert.equal(result.diagnostics.selectedCandidateId, 'binocular_mean_affine');
  assert.ok(result.diagnostics.candidates[0].score > result.diagnostics.candidates[1].score);
});

test('unequal frame counts do not change presentation weights, selection, or final coefficients', () => {
  const data = samples({ changingEyeDifference: true, roundTwoDifference: -.35 });
  const segment = data.filter(sample => sample.roundIndex === 2 && sample.targetId === 'c1');
  const original = fit(data), repeated = fit(data.concat(...Array.from({ length: 40 }, () => segment)));
  assert.equal(original.ok, true); assert.equal(repeated.ok, true);
  assert.equal(original.diagnostics.selectedCandidateId, repeated.diagnostics.selectedCandidateId);
  original.diagnostics.candidates.forEach((candidate, index) => close(candidate.score, repeated.diagnostics.candidates[index].score));
  for (const key of ['featureMean', 'featureScale', 'coefficientsX', 'coefficientsY']) {
    original.model[key].forEach((value, index) => close(value, repeated.model[key][index]));
  }
  for (const key of ['meanErrorNorm', 'meanAbsErrorX', 'meanAbsErrorY']) close(original.diagnostics.trainingMetrics[key], repeated.diagnostics.trainingMetrics[key]);
  assert.ok(repeated.diagnostics.roundSummaries[1].validCount > original.diagnostics.roundSummaries[1].validCount);
});

test('mean-eye model accepts original four features after JSON roundtrip and rejects malformed transforms', () => {
  const result = fit(samples({ changingEyeDifference: true }));
  const model = JSON.parse(JSON.stringify(result.model));
  assert.equal(model.featureTransform.kind, 'binocular_mean');
  assert.equal(model.inputFeatureCount, 4); assert.equal(model.featureCount, 2);
  const features = [.027, .032, .019, .04];
  const predicted = Core.predict(model, features);
  const bare = { ...model }; delete bare.featureTransform; delete bare.inputFeatureCount;
  const direct = Core.predict(bare, [(features[0] + features[2]) / 2, (features[1] + features[3]) / 2]);
  assert.deepEqual(predicted, direct); assert.equal(predicted.ok, true);
  assert.equal(Core.predict(model, [0, 0]).ok, false);
  assert.equal(Core.predict({ ...model, featureTransform: { ...model.featureTransform, kind: 'unknown' } }, features).reason, 'invalid_feature_transform');
  assert.equal(Core.predict({ ...model, inputFeatureCount: 2 }, features).reason, 'invalid_feature_transform');
  assert.equal(Core.predict(bare, [.01, .02]).ok, true, 'Legacy two-dimensional models remain supported');
});

test('one unusable candidate keeps failure evidence while another fully fitted candidate remains eligible', () => {
  // Finite but extreme input tests overflow handling independently per candidate.
  const data = samples().map((sample, index) => {
    const x = (sample.targetX - .5) * 1e150, y = (sample.targetY - .5) * 1e150, cancellation = (index % 2 ? 1 : -1) * 1e154;
    return { ...sample, features: [x + cancellation, y + cancellation, x - cancellation, y - cancellation] };
  });
  const result = fit(data); assert.equal(result.ok, true);
  const [four, averaged] = result.diagnostics.candidates;
  assert.equal(four.ok, false); assert.equal(four.reason, 'cross_round_fit_failed');
  assert.ok(four.folds.every(fold => fold.reason === 'nonfinite_cross_round_prediction'));
  assert.equal(averaged.ok, true); assert.equal(averaged.finalFit.ok, true);
  assert.equal(result.diagnostics.selectedCandidateId, 'binocular_mean_affine');
  const degenerate = fit(samples().map(sample => sample.roundIndex === 2 ? { ...sample, features: [0, 0, 0, 0] } : sample));
  assert.equal(degenerate.ok, false); assert.equal(degenerate.reason, 'no_eligible_calibration_candidate');
  assert.ok(degenerate.diagnostics.candidates.every(candidate => candidate.folds.length === 2 && !candidate.ok));
  assert.ok(degenerate.diagnostics.candidates.every(candidate => candidate.folds[1].reason === 'insufficient_eye_feature_span'));
});

test('per-target diagnostics retain raw feature stability and define round differences as round two minus one', () => {
  const data = samples({ changingEyeDifference: true }), result = fit(data);
  assert.equal(result.diagnostics.perTargetFit.length, 9);
  for (const point of result.diagnostics.perTargetFit) {
    assert.equal(point.roundMeans.length, 2); assert.equal(point.validCount, 32);
    const [first, second] = point.roundMeans;
    close(point.roundMeanDelta.x, second.x - first.x); close(point.roundMeanDelta.y, second.y - first.y);
    for (let index = 0; index < 4; index++) {
      const firstSamples = data.filter(sample => sample.roundIndex === 1 && sample.targetId === point.targetId);
      close(first.features[index], mean(firstSamples.map(sample => sample.features[index])));
      close(point.roundMeanDelta.features[index], second.features[index] - first.features[index]);
      assert.ok(Number.isFinite(first.featureSD[index]));
    }
    assert.ok(Number.isFinite(point.metrics.p95ErrorNorm)); assert.ok(Number.isFinite(point.sdY));
    close(point.metrics.meanErrorNorm, mean(point.roundMeans.map(round => round.metrics.meanErrorNorm)));
  }
});

test('scores within numerical tie tolerance prefer the original four-feature candidate', () => {
  let low = -.8, high = .8;
  for (let iteration = 0; iteration < 45; iteration++) {
    const middle = (low + high) / 2;
    const result = fit(samples({ changingEyeDifference: true, roundTwoDifference: middle, jitterMagnitude: 0 }));
    const [four, averaged] = result.diagnostics.candidates;
    if (four.score > averaged.score) low = middle; else high = middle;
  }
  const result = fit(samples({ changingEyeDifference: true, roundTwoDifference: high, jitterMagnitude: 0 }));
  const [four, averaged] = result.diagnostics.candidates;
  close(four.score, averaged.score, 1e-12);
  assert.equal(result.diagnostics.selectedCandidateId, 'four_eye_affine');
});
