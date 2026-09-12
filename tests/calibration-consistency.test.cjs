'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../shared/gaze-core.js');
const Consistency = require('../shared/calibration-consistency.js');
const targets = [.1, .5, .9].flatMap((targetY, row) => [.1, .5, .9].map((targetX, col) => ({ targetId: `c${row * 3 + col + 1}`, targetX, targetY })));
function model() {
  return { ok: true, model: { kind: 'standardized_affine_ridge', featureCount: 4, activeFeatures: [0, 1, 2, 3],
    featureMean: [0, 0, 0, 0], featureScale: [1, 1, 1, 1], coefficientsX: [0, .5, 0, .5, 0], coefficientsY: [0, 0, .5, 0, .5] } };
}
function presentations() {
  return [1, 2].flatMap(roundIndex => targets.map(target => {
    const presentationId = `r${roundIndex}-${target.targetId}`;
    return { ...target, roundIndex, presentationId, attempts: Array.from({ length: 12 }, (_, index) => ({
      ...target, roundIndex, presentationId, sampleId: `${presentationId}-${index}`, valid: true, fitEligible: true,
      features: [target.targetX, target.targetY, target.targetX, target.targetY]
    })) };
  }));
}
const run = (records = presentations(), fit = model(), options = {}) => Consistency.evaluate(fit, records, { expectedTargets: targets, ...options });
const shifted = (records, id, changes) => {
  for (const sample of records.find(record => record.roundIndex === 2 && record.targetId === id).attempts)
    sample.features = sample.features.map((value, index) => value + changes[index]);
  return records;
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('two complete identical rounds pass, expose eighteen medians and use the shared feature span', () => {
  const result = run();
  assert.equal(result.passed, true); assert.equal(result.reason, null); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.failedTargetIds, []); assert.equal(result.pointSummaries.length, 9);
  for (const point of result.pointSummaries) {
    assert.equal(point.passed, true); assert.deepEqual(point.featureSpan, [.8, .8, .8, .8]);
    assert.deepEqual(point.featureDelta, [0, 0, 0, 0]); assert.deepEqual(point.normalizedFeatureDelta, [0, 0, 0, 0]);
    assert.deepEqual(point.mappedDelta, { x: 0, y: 0 });
    assert.deepEqual(point.presentations.map(item => item.roundIndex), [1, 2]);
    assert.ok(point.presentations.every(item => item.validCount === 12));
  }
  assert.equal(result.definition.expectedRoundCount, 2); assert.match(result.definition.limitation, /not a demonstrated accuracy guarantee/);
  assert.equal(Consistency.evaluate(model(), presentations()).passed, true, 'Can infer the nine target identities if expectedTargets is omitted');
});

test('shifted same-target medians fail on both original features and mapped coordinates', () => {
  const result = run(shifted(presentations(), 'c5', [.3, -.3, .3, -.3]));
  assert.equal(result.reason, 'calibration_consistency_failed'); assert.deepEqual(result.failedTargetIds, ['c5']);
  const point = result.pointSummaries.find(item => item.targetId === 'c5');
  close(point.mappedDelta.x, .3); close(point.mappedDelta.y, -.3);
  close(point.normalizedFeatureDelta[0], .375); close(point.normalizedFeatureDelta[1], -.375);
  assert.ok(point.failures.includes('mapped_delta_x_exceeded')); assert.ok(point.failures.includes('mapped_delta_y_exceeded'));
  assert.ok(point.failures.includes('normalized_feature_delta_exceeded:0'));
});

test('a mapping that compresses or cancels the discrepancy cannot conceal feature inconsistency', () => {
  const collapsed = model(); collapsed.model.coefficientsX = [0, 0, 0, 0, 0]; collapsed.model.coefficientsY = [0, 0, 0, 0, 0];
  const result = run(shifted(presentations(), 'c5', [.3, 0, -.3, 0]), collapsed);
  const point = result.pointSummaries.find(item => item.targetId === 'c5');
  assert.equal(result.passed, false); assert.deepEqual(point.mappedDelta, { x: 0, y: 0 });
  assert.ok(point.failures.includes('normalized_feature_delta_exceeded:0'));
  assert.ok(point.failures.includes('normalized_feature_delta_exceeded:2'));
  assert.ok(!point.failures.some(code => code.startsWith('mapped_delta')));
});

test('mapped discrepancy can fail even when feature discrepancies are below their separate bound', () => {
  const amplified = model(); amplified.model.coefficientsX = [0, 5, 0, 5, 0];
  const result = run(shifted(presentations(), 'c5', [.04, 0, .04, 0]), amplified);
  const point = result.pointSummaries.find(item => item.targetId === 'c5');
  assert.equal(result.passed, false); assert.deepEqual(point.failures, ['mapped_delta_x_exceeded']); close(point.mappedDelta.x, .4);
});

test('all admitted frames define medians before binocular transformation; invalid noneligible frames do not enter', () => {
  const records = presentations();
  for (const record of records) {
    record.attempts = Array.from({ length: 15 }, (_, index) => ({ valid: true, fitEligible: true,
      features: [record.targetX + (index % 3 === 0 ? .3 : 0), record.targetY,
        record.targetX + (index % 3 === 1 ? .3 : 0), record.targetY] }));
    record.attempts.push({ valid: false, fitEligible: false, features: [NaN] });
  }
  const binocular = { ok: true, model: { kind: 'standardized_affine_ridge', featureCount: 2, inputFeatureCount: 4,
    featureTransform: { kind: 'binocular_mean', inputFeatureCount: 4, outputFeatureCount: 2 }, activeFeatures: [0, 1],
    featureMean: [0, 0], featureScale: [1, 1], coefficientsX: [0, 1, 0], coefficientsY: [0, 0, 1] } };
  const result = run(records, binocular); assert.equal(result.passed, true);
  for (const point of result.pointSummaries) for (const item of point.presentations) {
    assert.equal(item.validCount, 15); close(item.prediction.x, point.targetX); close(item.prediction.y, point.targetY);
    assert.deepEqual(item.medianFeatures, [point.targetX, point.targetY, point.targetX, point.targetY]);
  }
});

test('exact engineering thresholds pass and values beyond floating tolerance fail', () => {
  const exactFeature = run(shifted(presentations(), 'c5', [.2, 0, 0, 0]));
  assert.equal(exactFeature.passed, true);
  assert.equal(run(shifted(presentations(), 'c5', [.20000001, 0, 0, 0])).passed, false);
  const exactMapped = run(shifted(presentations(), 'c5', [.15, 0, .15, 0]));
  assert.equal(exactMapped.passed, true);
  assert.equal(run(shifted(presentations(), 'c5', [.15000001, 0, .15000001, 0])).passed, false);
});

test('zero and near-zero feature spans fail explicitly without division by zero or JSON data loss', () => {
  for (const scale of [0, 1e-10]) {
    const records = presentations();
    for (const record of records) for (const sample of record.attempts) sample.features[2] *= scale;
    const result = run(records); assert.equal(result.reason, 'calibration_consistency_failed');
    assert.equal(result.failedTargetIds.length, 9);
    assert.ok(result.pointSummaries.every(point => point.failures.includes('feature_span_too_small:2') && point.normalizedFeatureDelta[2] === null));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

const corruptions = [
  ['missing presentation', records => records.pop(), 'incomplete_calibration_round'],
  ['duplicate record', records => records.push(records[0]), 'duplicate_target_presentation'],
  ['reused presentation id', records => { records[1].presentationId = records[0].presentationId; }, 'duplicate_presentation_id'],
  ['duplicate target within round', records => { records[1] = { ...records[0], presentationId: 'another' }; }, 'duplicate_target_presentation'],
  ['third round', records => { records[0].roundIndex = 3; }, 'unexpected_calibration_round'],
  ['missing presentation id', records => { delete records[0].presentationId; }, 'missing_presentation_id'],
  ['nonfinite target coordinate', records => { records[0].targetX = NaN; }, 'unexpected_calibration_target'],
  ['changed coordinates', records => { records[0].targetX = .2; }, 'inconsistent_calibration_target'],
  ['too few eligible frames', records => { records[0].attempts[0].fitEligible = false; }, 'insufficient_samples_per_presentation'],
  ['eligible NaN frame despite twelve other valid frames', records => { records[0].attempts.push({ fitEligible: true, valid: true, features: [NaN, 0, 0, 0] }); }, 'invalid_fit_eligible_sample'],
  ['eligible frame marked invalid', records => { records[0].attempts[0].valid = false; }, 'invalid_fit_eligible_sample'],
  ['sample from another presentation', records => { records[0].attempts[0].presentationId = 'different'; }, 'inconsistent_sample_presentation'],
  ['duplicate sample id', records => { records[0].attempts[1].sampleId = records[0].attempts[0].sampleId; }, 'invalid_or_duplicate_sample_id'],
  ['missing attempt list', records => { delete records[0].attempts; }, 'invalid_presentation_attempts']
];
for (const [name, mutate, code] of corruptions) test(`fail closed: ${name}`, () => {
  const records = presentations(); mutate(records); const result = run(records);
  assert.equal(result.passed, false); assert.equal(result.reason, 'invalid_calibration_consistency_input');
  assert.ok(result.failures.includes(code), JSON.stringify(result.failures));
  assert.ok(result.pointSummaries.every(point => !point.passed && point.featureSpan === null), 'Incomplete data must not define a partial feature range');
});

test('fit failure, malformed model, invalid expected targets and invalid options fail closed', () => {
  assert.equal(run(presentations(), { ok: false, model: model().model }).reason, 'calibration_fit_failed');
  const broken = model(); broken.model.coefficientsX[0] = NaN;
  assert.equal(run(presentations(), broken).reason, 'invalid_calibration_consistency_input');
  assert.ok(run(presentations(), broken).failures.includes('invalid_model_prediction'));
  assert.ok(run(presentations(), model(), { expectedTargets: targets.slice(1) }).failures.includes('expected_nine_calibration_targets'));
  assert.ok(run(presentations(), model(), { expectedTargets: targets.concat(targets[0]) }).failures.includes('invalid_expected_targets'));
  for (const options of [null, [], { minSamplesPerPresentation: 11 }, { maxNormalizedFeatureDelta: NaN }, { maxMappedDeltaY: -1 }, { minFeatureSpan: 0 }]) {
    assert.equal(Consistency.evaluate(model(), presentations(), options).passed, false);
  }
});

test('nonfinite arithmetic is an integrity failure and never a successful zero discrepancy', () => {
  const records = presentations();
  for (const record of records) for (const sample of record.attempts) sample.features[0] = record.targetX < .5 ? -1e308 : 1e308;
  const result = run(records); assert.equal(result.reason, 'invalid_calibration_consistency_input');
  assert.ok(result.failures.includes('nonfinite_feature_difference:0'));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('the real repeated-calibration model contract is accepted without modification', () => {
  const records = presentations(), allFrames = records.flatMap(record => record.attempts);
  const fit = Core.createRepeatedCalibration(allFrames, { expectedTargets: targets, aggregation: 'presentation_median' });
  assert.equal(fit.ok, true); assert.equal(run(records, fit).passed, true);
});

test('inputs may be deeply frozen, output arrays are detached, and order does not affect comparisons', () => {
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  const records = freeze(presentations()), fit = freeze(model()), options = freeze({ expectedTargets: structuredClone(targets) });
  const result = Consistency.evaluate(fit, records, options);
  assert.equal(result.passed, true);
  result.pointSummaries[0].presentations[0].medianFeatures[0] = 999;
  assert.equal(records[0].attempts[0].features[0], .1);
  assert.deepEqual(Consistency.evaluate(fit, records, options), Consistency.evaluate(fit, records.slice().reverse(), options));
});

test('browser UMD exports the same evaluator and fails closed without GazeCore', () => {
  const source = fs.readFileSync(require.resolve('../shared/calibration-consistency.js'), 'utf8');
  const browser = { GazeCore: Core }; vm.runInNewContext(source, browser);
  assert.equal(browser.CalibrationConsistency.evaluate(model(), presentations()).passed, true);
  const missingCore = {}; vm.runInNewContext(source, missingCore);
  assert.equal(missingCore.CalibrationConsistency.evaluate(model(), presentations()).reason, 'invalid_calibration_consistency_input');
});
