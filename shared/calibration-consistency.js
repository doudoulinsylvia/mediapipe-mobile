/* Calibration-only repeatability gate. This is not independent gaze accuracy. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gaze-core.js'));
  else root.CalibrationConsistency = factory(root.GazeCore);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const defaults = Object.freeze({ maxNormalizedFeatureDelta: 0.25, maxMappedDeltaX: 0.15,
    maxMappedDeltaY: 0.15, minSamplesPerPresentation: 12, minFeatureSpan: 1e-8 });
  const definition = Object.freeze({
    protocol: 'two_round_calibration_consistency_v1', expectedRoundCount: 2, expectedTargetCount: 9,
    representative: 'Coordinate-wise median of all valid, fitEligible original four-feature frames in each presentation. No frame rejection or best-round selection is performed here.',
    featureDelta: 'Signed round 2 minus round 1 median, for [leftX, leftY, rightX, rightY].',
    featureSpan: 'For each original feature, maximum minus minimum over all eighteen presentation medians.',
    normalizedFeatureDelta: 'Signed featureDelta / featureSpan. Every absolute component must be at or below maxNormalizedFeatureDelta.',
    mappedDelta: 'Signed round 2 minus round 1 predictions of the two original-feature medians, both using the same final fit.model without clipping. X and Y use screen-width and screen-height normalization.',
    zeroSpanRule: 'Any feature span at or below minFeatureSpan fails closed; its normalized delta is null, never Infinity or a silently accepted zero.',
    comparisonTolerance: 1e-12,
    limitation: 'Fixed engineering candidate thresholds, not a demonstrated accuracy guarantee. Uses calibration only; independent validation remains required.'
  });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const key = value => (typeof value === 'string' || finite(value)) && String(value).length ? String(value) : null;
  const targetValid = target => target && key(target.targetId) !== null && finite(target.targetX) && finite(target.targetY) &&
    target.targetX >= 0 && target.targetX <= 1 && target.targetY >= 0 && target.targetY <= 1;
  const sameTarget = (a, b) => Math.abs(a.targetX - b.targetX) < 1e-7 && Math.abs(a.targetY - b.targetY) < 1e-7;
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
  };
  const append = (list, value) => { if (!list.includes(value)) list.push(value); };

  function evaluate(fit, presentations, options = {}) {
    const validOptions = options && typeof options === 'object' && !Array.isArray(options);
    const settings = { ...defaults };
    if (validOptions) for (const name of Object.keys(defaults)) if (options[name] !== undefined) settings[name] = options[name];
    const result = { passed: false, reason: null, failures: [], pointSummaries: [], failedTargetIds: [], settings,
      definition: { ...definition } };
    const finish = reason => {
      result.reason = reason;
      result.passed = reason === null;
      result.failedTargetIds = result.pointSummaries.filter(point => !point.passed).map(point => point.targetId);
      return result;
    };
    const reject = (code, reason = 'invalid_calibration_consistency_input') => { append(result.failures, code); return finish(reason); };
    if (!validOptions || ['maxNormalizedFeatureDelta', 'maxMappedDeltaX', 'maxMappedDeltaY'].some(name => !finite(settings[name]) || settings[name] < 0) ||
        !Number.isInteger(settings.minSamplesPerPresentation) || settings.minSamplesPerPresentation < 12 ||
        !finite(settings.minFeatureSpan) || settings.minFeatureSpan <= 0) return reject('invalid_consistency_options');
    if (!fit || fit.ok !== true || !fit.model) return reject('calibration_fit_failed', 'calibration_fit_failed');
    if (!Core || typeof Core.predict !== 'function') return reject('gaze_core_unavailable');
    if (!Array.isArray(presentations)) return reject('invalid_presentations');

    const suppliedTargets = options.expectedTargets === undefined ? presentations.filter(targetValid)
      .filter((target, index, all) => all.findIndex(other => key(other.targetId) === key(target.targetId)) === index) : options.expectedTargets;
    if (!Array.isArray(suppliedTargets)) return reject('invalid_expected_targets');
    const expected = new Map();
    for (const target of suppliedTargets) {
      if (!targetValid(target) || expected.has(key(target.targetId)) || Array.from(expected.values()).some(other => sameTarget(other, target))) return reject('invalid_expected_targets');
      expected.set(key(target.targetId), { targetId: key(target.targetId), targetX: target.targetX, targetY: target.targetY });
    }
    if (expected.size !== 9) return reject('expected_nine_calibration_targets');
    result.pointSummaries = Array.from(expected.values()).map(target => ({ ...target, passed: false, failures: [],
      presentations: [], featureDelta: null, featureSpan: null, normalizedFeatureDelta: null, mappedDelta: null }));
    const pointById = new Map(result.pointSummaries.map(point => [point.targetId, point]));
    const fail = (code, point) => { append(result.failures, code); if (point) append(point.failures, code); };
    const byRoundAndTarget = new Map(), usedIds = new Map();
    if (presentations.length !== 18) fail('expected_eighteen_presentations');
    for (const record of presentations) {
      const point = record && pointById.get(key(record.targetId));
      if (!targetValid(record) || !point) { fail('unexpected_calibration_target', point); continue; }
      if (!sameTarget(record, point)) { fail('inconsistent_calibration_target', point); continue; }
      if (record.roundIndex !== 1 && record.roundIndex !== 2) { fail('unexpected_calibration_round', point); continue; }
      const presentationId = key(record.presentationId), pairKey = JSON.stringify([record.roundIndex, point.targetId]);
      if (presentationId === null) { fail('missing_presentation_id', point); continue; }
      if (usedIds.has(presentationId)) {
        fail('duplicate_presentation_id', point); fail('duplicate_presentation_id', usedIds.get(presentationId));
      }
      usedIds.set(presentationId, point);
      if (byRoundAndTarget.has(pairKey)) { fail('duplicate_target_presentation', point); continue; }
      const summary = { roundIndex: record.roundIndex, presentationId, validCount: 0, medianFeatures: null, prediction: null };
      point.presentations.push(summary); byRoundAndTarget.set(pairKey, summary);
      if (!Array.isArray(record.attempts)) { fail('invalid_presentation_attempts', point); continue; }
      const admitted = [];
      const sampleIds = new Set();
      for (const sample of record.attempts) {
        if (!sample || sample.fitEligible !== true) continue;
        if (sample.valid !== true || !Array.isArray(sample.features) || sample.features.length !== 4 || !sample.features.every(finite)) {
          fail('invalid_fit_eligible_sample', point); continue;
        }
        if ((sample.targetId !== undefined && key(sample.targetId) !== point.targetId) ||
            (sample.roundIndex !== undefined && sample.roundIndex !== record.roundIndex) ||
            (sample.presentationId !== undefined && key(sample.presentationId) !== presentationId) ||
            (sample.targetX !== undefined && (!finite(sample.targetX) || Math.abs(sample.targetX - point.targetX) >= 1e-7)) ||
            (sample.targetY !== undefined && (!finite(sample.targetY) || Math.abs(sample.targetY - point.targetY) >= 1e-7))) {
          fail('inconsistent_sample_presentation', point); continue;
        }
        if (sample.sampleId !== undefined) {
          const sampleId = key(sample.sampleId);
          if (sampleId === null || sampleIds.has(sampleId)) { fail('invalid_or_duplicate_sample_id', point); continue; }
          sampleIds.add(sampleId);
        }
        admitted.push(sample.features);
      }
      summary.validCount = admitted.length;
      if (admitted.length < settings.minSamplesPerPresentation) { fail('insufficient_samples_per_presentation', point); continue; }
      summary.medianFeatures = [0, 1, 2, 3].map(index => median(admitted.map(features => features[index])));
    }
    for (const point of result.pointSummaries) {
      point.presentations.sort((a, b) => a.roundIndex - b.roundIndex);
      if (!byRoundAndTarget.has(JSON.stringify([1, point.targetId])) || !byRoundAndTarget.has(JSON.stringify([2, point.targetId]))) fail('incomplete_calibration_round', point);
    }
    // A partial set cannot define the common normalization span. No point is
    // marked passing when another integrity error prevents the full check.
    if (result.failures.length) return finish('invalid_calibration_consistency_input');

    const representatives = result.pointSummaries.flatMap(point => point.presentations.map(presentation => presentation.medianFeatures));
    const featureSpan = [0, 1, 2, 3].map(index => Math.max(...representatives.map(features => features[index])) - Math.min(...representatives.map(features => features[index])));
    for (const point of result.pointSummaries) {
      point.featureSpan = featureSpan.map(value => finite(value) ? value : null);
      point.featureDelta = point.presentations[0].medianFeatures.map((value, index) => point.presentations[1].medianFeatures[index] - value);
      point.normalizedFeatureDelta = point.featureDelta.map((delta, index) => {
        if (!finite(featureSpan[index]) || !finite(delta)) { fail(`nonfinite_feature_difference:${index}`, point); return null; }
        if (featureSpan[index] <= settings.minFeatureSpan) { fail(`feature_span_too_small:${index}`, point); return null; }
        const normalized = delta / featureSpan[index];
        if (Math.abs(normalized) > settings.maxNormalizedFeatureDelta + definition.comparisonTolerance) fail(`normalized_feature_delta_exceeded:${index}`, point);
        return normalized;
      });
      point.featureDelta = point.featureDelta.map(value => finite(value) ? value : null);
      for (const presentation of point.presentations) {
        const prediction = Core.predict(fit.model, presentation.medianFeatures);
        if (!prediction || prediction.ok !== true || !finite(prediction.x) || !finite(prediction.y)) fail('invalid_model_prediction', point);
        else presentation.prediction = { x: prediction.x, y: prediction.y };
      }
      if (point.presentations.every(presentation => presentation.prediction)) {
        const [first, second] = point.presentations.map(presentation => presentation.prediction);
        const x = second.x - first.x, y = second.y - first.y;
        if (!finite(x) || !finite(y)) fail('nonfinite_mapped_difference', point);
        else {
          point.mappedDelta = { x, y };
          if (Math.abs(x) > settings.maxMappedDeltaX + definition.comparisonTolerance) fail('mapped_delta_x_exceeded', point);
          if (Math.abs(y) > settings.maxMappedDeltaY + definition.comparisonTolerance) fail('mapped_delta_y_exceeded', point);
        }
      }
      point.passed = point.failures.length === 0;
      if (!point.passed) append(result.failures, `target_failed:${point.targetId}`);
    }
    // A malformed model is an integrity failure, not grounds for target repair.
    if (result.failures.includes('invalid_model_prediction') || result.failures.includes('nonfinite_mapped_difference') ||
        result.failures.some(code => code.startsWith('nonfinite_feature_difference:'))) return finish('invalid_calibration_consistency_input');
    return finish(result.failures.length ? 'calibration_consistency_failed' : null);
  }

  return Object.freeze({ evaluate, defaults, definition });
}));
