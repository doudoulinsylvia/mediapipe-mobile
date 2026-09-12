'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../shared/gaze-core.js');
const Previous = require('./fixtures/gaze-core-v2.1.0.cjs');
const targets = [.08, .5, .92].flatMap((y, row) => [.08, .5, .92].map((x, column) => ({ targetId: `c${row * 3 + column + 1}`, targetX: x, targetY: y })));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function samples({ count = 15, outliers = true } = {}) {
  return [1, 2].flatMap(roundIndex => targets.flatMap(target => Array.from({ length: count }, (_, frame) => {
    const x = (target.targetX - .5) * .1, y = (target.targetY - .5) * .12;
    const phase = frame % 3;
    return { ...target, roundIndex, presentationId: `r${roundIndex}-${target.targetId}`, valid: true,
      features: [x + (outliers && phase === 2 ? .03 : 0), y, x + (outliers && phase === 1 ? .03 : 0), y] };
  })));
}
const fit = data => Core.createRepeatedCalibration(data, { expectedTargets: targets, aggregation: 'presentation_median' });

test('the default repeated-calibration protocol remains exactly unchanged apart from core version', () => {
  const data = samples();
  const oldResult = Previous.createRepeatedCalibration(data, { expectedTargets: targets });
  const current = Core.createRepeatedCalibration(data, { expectedTargets: targets });
  assert.equal(oldResult.ok, true); oldResult.model.version = current.model.version;
  assert.deepEqual(current, oldResult);
  assert.equal(current.model.aggregation, undefined); assert.equal(current.diagnostics.aggregation, undefined);
  const oldSingle = Previous.createCalibration(data.filter(sample => sample.roundIndex === 1));
  const currentSingle = Core.createCalibration(data.filter(sample => sample.roundIndex === 1));
  oldSingle.model.version = currentSingle.model.version;
  assert.deepEqual(currentSingle, oldSingle);
});

test('median training uses nine actual observations per fold and eighteen in the final fit', () => {
  const data = samples(), copy = JSON.stringify(data), result = fit(data);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(JSON.stringify(data), copy);
  assert.equal(result.diagnostics.aggregation, 'presentation_median'); assert.equal(result.model.aggregation, 'presentation_median');
  for (const candidate of result.diagnostics.candidates) {
    assert.equal(candidate.ok, true);
    for (const fold of candidate.folds) {
      const representative = fold.fitDiagnostics.representativeSummary;
      assert.equal(representative.representativeCount, 9); assert.equal(representative.trainingRawValidFrameCount, 135);
      assert.ok(fold.fitDiagnostics.targetSummaries.every(point => point.sampleCount === 1));
      assert.ok(representative.representatives.every(point => point.roundIndex === fold.trainRoundIndex));
    }
    const final = candidate.finalFit.diagnostics;
    assert.equal(final.representativeSummary.representativeCount, 18);
    assert.equal(final.representativeSummary.trainingRawValidFrameCount, 270);
    assert.ok(final.targetSummaries.every(point => point.sampleCount === 2));
  }
});

test('coordinate medians are formed from original four features before the binocular transform', () => {
  const result = fit(samples());
  const averaged = result.diagnostics.candidates.find(candidate => candidate.id === 'binocular_mean_affine');
  for (const fold of averaged.folds) for (const representative of fold.fitDiagnostics.representativeSummary.representatives) {
    const target = targets.find(target => target.targetId === representative.targetId);
    const expectedX = (target.targetX - .5) * .1;
    close(representative.features[0], expectedX); close(representative.features[2], expectedX);
    // Here median((left + right)/2) would be expectedX + .015, which is a
    // different estimator from the explicitly chosen coordinate-wise median.
    close((representative.features[0] + representative.features[2]) / 2, expectedX);
  }
});

test('cross-round scores and final training diagnostics still count every raw held-out frame', () => {
  const data = samples(), result = fit(data);
  const selected = result.diagnostics.candidates.find(candidate => candidate.id === result.diagnostics.selectedCandidateId);
  const targetErrors = targets.map(target => mean(data.filter(sample => sample.roundIndex === 2 && sample.targetId === target.targetId).map(sample => {
    const point = Core.predict(result.model, sample.features);
    return Math.hypot(point.x - sample.targetX, point.y - sample.targetY);
  })));
  // These rounds are identical, so each fold model and the final model have the
  // same median observations and weights. This checks raw-frame scoring directly.
  for (const fold of selected.folds) {
    assert.ok(fold.perTarget.every(point => point.validCount === 15));
    close(fold.score, mean(targetErrors));
    assert.ok(fold.score > fold.fitDiagnostics.trainingMeanErrorNorm + .02);
  }
  close(result.diagnostics.trainingMetrics.meanErrorNorm, mean(targetErrors));
  assert.ok(result.diagnostics.perTargetFit.every(point => point.validCount === 30));
  assert.ok(result.diagnostics.perTargetFit.some(point => point.roundMeans[0].featureSD[0] > 0));
});

test('invalid or insufficient original frames cannot be replaced by duplicated median observations', () => {
  const missing = fit(samples({ count: 11 }));
  assert.equal(missing.ok, false); assert.equal(missing.reason, 'insufficient_samples_per_presentation');
  const data = samples();
  const invalid = data.map(sample => sample.roundIndex === 2 && sample.targetId === 'c1' ? { ...sample, valid: false, reason: 'unstable_window' } : sample);
  const result = fit(invalid);
  assert.equal(result.ok, false); assert.equal(result.reason, 'insufficient_samples_per_presentation');
  assert.equal(result.diagnostics.roundSummaries[1].invalidReasons.unstable_window, 15);
  assert.equal(Core.createCalibration(targets.map(target => ({ ...target, features: [.1 * target.targetX, .1 * target.targetY] })), { minSamplesPerTarget: 1 }).reason, 'invalid_calibration_options');
});

test('collapsed representative geometry fails explicitly without falling back to raw-frame fits', () => {
  const data = samples({ count: 15, outliers: false }).map((sample, index) => ({ ...sample,
    features: index % 15 < 8 ? [0, 0, 0, 0] : sample.features.map(value => value * 4) }));
  const raw = Core.createRepeatedCalibration(data, { expectedTargets: targets });
  assert.equal(raw.ok, true, 'Raw frame means retain a two-dimensional signal in this construction');
  const median = fit(data);
  assert.equal(median.ok, false); assert.equal(median.reason, 'no_eligible_calibration_candidate');
  assert.equal(median.diagnostics.aggregation, 'presentation_median');
  assert.ok(median.diagnostics.candidates.every(candidate => candidate.folds.every(fold => fold.reason === 'insufficient_eye_feature_span')));
});

test('replicating a complete presentation does not change representative weights or model selection', () => {
  const data = samples(), segment = data.filter(sample => sample.roundIndex === 2 && sample.targetId === 'c1');
  const original = fit(data), repeated = fit(data.concat(...Array.from({ length: 20 }, () => segment)));
  assert.equal(original.ok, true); assert.equal(repeated.ok, true);
  assert.deepEqual(original.model, repeated.model);
  original.diagnostics.candidates.forEach((candidate, index) => close(candidate.score, repeated.diagnostics.candidates[index].score));
  assert.equal(repeated.diagnostics.finalFitDiagnostics.representativeSummary.representativeCount, 18);
});

test('aggregation is explicit, validated and survives a JSON model roundtrip', () => {
  const data = samples(), result = fit(data);
  const model = JSON.parse(JSON.stringify(result.model));
  assert.equal(model.aggregation, 'presentation_median');
  assert.deepEqual(Core.predict(model, data[0].features), Core.predict(result.model, data[0].features));
  assert.equal(Core.createRepeatedCalibration(data, { expectedTargets: targets, aggregation: 'validation_median' }).reason, 'invalid_calibration_aggregation');
  const explicitRaw = Core.createRepeatedCalibration(data, { expectedTargets: targets, aggregation: 'raw_frames' });
  assert.equal(explicitRaw.ok, true); assert.equal(explicitRaw.model.aggregation, 'raw_frames');
});
