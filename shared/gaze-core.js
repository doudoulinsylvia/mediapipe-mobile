/* Gaze geometry, calibration and independent validation. No camera or DOM access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GazeCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const version = '2.1.0';
  const qualityThresholds = Object.freeze({ minEyeWidthPixels: 4, minEAR: 0.09, maxEAR: 0.65,
    minIrisRatio: 0.02, maxIrisRatio: 0.8, maxAbsLocalX: 0.8, maxAbsLocalY: 0.6 });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const quantile = (values, p) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
  };
  const span = values => values.length ? Math.max(...values) - Math.min(...values) : 0;
  const targetKey = value => (typeof value === 'string' || finite(value)) && String(value).length ? String(value) : null;
  const targetValid = sample => sample && targetKey(sample.targetId) !== null &&
    finite(sample.targetX) && finite(sample.targetY) && sample.targetX >= 0 && sample.targetX <= 1 && sample.targetY >= 0 && sample.targetY <= 1;
  const sameTarget = (a, b) => Math.abs(a.targetX - b.targetX) < 1e-7 && Math.abs(a.targetY - b.targetY) < 1e-7;
  function layoutDiagnostics(targets) {
    const unique = [];
    for (const target of targets) if (!unique.some(other => sameTarget(target, other))) unique.push(target);
    const x = unique.map(t => t.targetX), y = unique.map(t => t.targetY), mx = mean(x), my = mean(y);
    const vx = mean(x.map(v => (v - mx) ** 2)), vy = mean(y.map(v => (v - my) ** 2));
    const covariance = mean(x.map((v, i) => (v - mx) * (y[i] - my)));
    return { uniquePositionCount: unique.length, correlation: vx > 0 && vy > 0 ? covariance / Math.sqrt(vx * vy) : null };
  }

  function extractFeatures(landmarks, videoWidth, videoHeight) {
    const result = {
      features: [],
      quality: { valid: false, faceDetected: Array.isArray(landmarks) && landmarks.length > 0, eyeOpen: false, leftEAR: null, rightEAR: null, reason: null },
      iris: { leftRatio: null, rightRatio: null, meanRatio: null },
      diagnostics: { geometry: 'camera_pixels', eyeNormalization: 'eye_corner_width', qualityThresholds,
        thresholdNote: 'Engineering geometry gates; not independently validated sensitivity or specificity.', headProxy: null }
    };
    const reject = reason => { result.quality.reason = reason; return result; };
    if (!result.quality.faceDetected) return reject('no_face');
    if (!finite(videoWidth) || !finite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) return reject('invalid_video_dimensions');
    const needed = [33, 133, 159, 145, 158, 153, 362, 263, 386, 374, 385, 380, 468, 469, 471, 473, 474, 476];
    if (needed.some(index => !landmarks[index] || !finite(landmarks[index].x) || !finite(landmarks[index].y))) return reject('missing_or_nonfinite_landmarks');
    const point = index => ({ x: landmarks[index].x * videoWidth, y: landmarks[index].y * videoHeight });
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    function eye(cornerA, cornerB, upperA, lowerA, upperB, lowerB, centerIndex, irisA, irisB) {
      let a = point(cornerA), b = point(cornerB);
      if (b.x < a.x) [a, b] = [b, a];
      const width = distance(a, b), center = point(centerIndex);
      if (width < qualityThresholds.minEyeWidthPixels) return null;
      const ux = (b.x - a.x) / width, uy = (b.y - a.y) / width;
      const dx = center.x - (a.x + b.x) / 2, dy = center.y - (a.y + b.y) / 2;
      return {
        x: (dx * ux + dy * uy) / width,
        y: (-dx * uy + dy * ux) / width,
        ear: (distance(point(upperA), point(lowerA)) + distance(point(upperB), point(lowerB))) / (2 * width),
        irisRatio: distance(point(irisA), point(irisB)) / width,
        width, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      };
    }
    const left = eye(33, 133, 159, 145, 158, 153, 468, 469, 471);
    const right = eye(362, 263, 386, 374, 385, 380, 473, 474, 476);
    if (!left || !right) return reject('eye_geometry_too_small');
    result.quality.leftEAR = left.ear;
    result.quality.rightEAR = right.ear;
    result.quality.eyeOpen = left.ear > qualityThresholds.minEAR && right.ear > qualityThresholds.minEAR;
    result.iris = { leftRatio: left.irisRatio, rightRatio: right.irisRatio, meanRatio: (left.irisRatio + right.irisRatio) / 2 };
    if (!result.quality.eyeOpen) return reject('eye_closed_or_occluded');
    if ([left, right].some(e => ![e.x, e.y, e.ear, e.irisRatio].every(finite) || e.ear > qualityThresholds.maxEAR || e.irisRatio < qualityThresholds.minIrisRatio || e.irisRatio > qualityThresholds.maxIrisRatio || Math.abs(e.x) > qualityThresholds.maxAbsLocalX || Math.abs(e.y) > qualityThresholds.maxAbsLocalY)) return reject('implausible_eye_geometry');
    result.features = [left.x, left.y, right.x, right.y];
    result.quality.valid = true;
    result.diagnostics.headProxy = {
      centerX: (left.center.x + right.center.x) / (2 * videoWidth),
      centerY: (left.center.y + right.center.y) / (2 * videoHeight),
      eyeSeparationNorm: distance(left.center, right.center) / videoWidth,
      rollRadians: Math.atan2(right.center.y - left.center.y, right.center.x - left.center.x),
      note: '2D image geometry only; not a measured 3D head pose'
    };
    return result;
  }

  // Causal recovery gate: it only reads frame quality and a monotonic timestamp in ms.
  // Defaults are engineering candidates, not demonstrated improvements in gaze accuracy.
  function createTemporalQualityGate(options = {}) {
    const settings = Object.assign({ recoveryMs: 100, minStableFrames: 3, maxGapMs: 500 }, options);
    if (!finite(settings.recoveryMs) || settings.recoveryMs < 0 ||
        !Number.isInteger(settings.minStableFrames) || settings.minStableFrames < 1 ||
        !finite(settings.maxGapMs) || settings.maxGapMs <= 0) throw new RangeError('Invalid temporal quality gate options');
    let lastTimestamp, lastInvalidTimestamp, stableFrames, recoveryReason, needsRecoveryAnchor;
    function reset() {
      lastTimestamp = null; lastInvalidTimestamp = null; stableFrames = 0;
      recoveryReason = null; needsRecoveryAnchor = false;
    }
    reset();
    function update(quality, timestamp) {
      const rawValid = !!quality && quality.valid === true;
      function rejectTimestamp(reason) {
        // The bad timestamp cannot anchor a duration. Rebase on the next usable
        // timestamp, retaining the recovery requirement instead of trusting it as
        // the first healthy frame of a new stream.
        reset(); needsRecoveryAnchor = true; recoveryReason = 'temporal_recovery';
        return { valid: false, reason, rawValid, recovering: true, stableFrames: 0, msSinceInvalid: null };
      }
      if (!finite(timestamp) || timestamp < 0) return rejectTimestamp('invalid_timestamp');
      if (lastTimestamp !== null && timestamp <= lastTimestamp) return rejectTimestamp('nonmonotonic_timestamp');
      const gap = lastTimestamp !== null && timestamp - lastTimestamp > settings.maxGapMs;
      lastTimestamp = timestamp;
      if (needsRecoveryAnchor) { lastInvalidTimestamp = timestamp; needsRecoveryAnchor = false; }
      if (gap) { stableFrames = 0; recoveryReason = 'temporal_gap_recovery'; }
      if (!rawValid) {
        lastInvalidTimestamp = timestamp; stableFrames = 0; recoveryReason = 'temporal_recovery';
        const reason = quality && typeof quality.reason === 'string' && quality.reason ? quality.reason : 'invalid_quality';
        return { valid: false, reason, rawValid, recovering: true, stableFrames, msSinceInvalid: 0 };
      }
      stableFrames = Math.min(stableFrames + 1, settings.minStableFrames);
      const msSinceInvalid = lastInvalidTimestamp === null ? null : timestamp - lastInvalidTimestamp;
      if (recoveryReason && (stableFrames < settings.minStableFrames ||
          (msSinceInvalid !== null && msSinceInvalid < settings.recoveryMs))) {
        return { valid: false, reason: recoveryReason, rawValid, recovering: true, stableFrames, msSinceInvalid };
      }
      recoveryReason = null;
      return { valid: true, reason: null, rawValid, recovering: false, stableFrames, msSinceInvalid };
    }
    return { update, reset };
  }

  // Gaussian elimination with partial pivoting; ridge stabilizes correlated eyes.
  function solve(matrix, vector) {
    const n = vector.length, augmented = matrix.map((row, i) => row.slice().concat(vector[i]));
    let minPivot = Infinity, maxPivot = 0;
    for (let k = 0; k < n; k++) {
      let best = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(augmented[i][k]) > Math.abs(augmented[best][k])) best = i;
      [augmented[k], augmented[best]] = [augmented[best], augmented[k]];
      const pivot = Math.abs(augmented[k][k]);
      if (!finite(pivot) || pivot < 1e-12) return null;
      minPivot = Math.min(minPivot, pivot); maxPivot = Math.max(maxPivot, pivot);
      for (let i = k + 1; i < n; i++) {
        const factor = augmented[i][k] / augmented[k][k];
        for (let j = k; j <= n; j++) augmented[i][j] -= factor * augmented[k][j];
      }
    }
    const coefficients = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let value = augmented[i][n];
      for (let j = i + 1; j < n; j++) value -= augmented[i][j] * coefficients[j];
      coefficients[i] = value / augmented[i][i];
    }
    return coefficients.every(finite) ? { coefficients, pivotRatio: maxPivot / minPivot } : null;
  }

  const calibrationDefaults = {
    minTargetCount: 5, minSamplesPerTarget: 12, minTargetSpanX: 0.5, minTargetSpanY: 0.5,
    maxTargetCorrelation: 0.98,
    minRawSpanX: 0.008, minRawSpanY: 0.008, maxRawCorrelation: 0.995,
    minFeatureStd: 1e-6, ridgeLambda: 0.01, maxPivotRatio: 1e8
  };
  function createCalibration(samples, options = {}) {
    const settings = Object.assign({}, calibrationDefaults, options);
    const diagnostics = { settings, targetSummaries: [], rejectedSamples: 0, warnings: [], note: 'Calibration fit is not an accuracy validation. Independent held-out targets are required.' };
    const fail = reason => ({ ok: false, reason, model: null, diagnostics });
    if (!Array.isArray(samples) || !samples.length) return fail('no_calibration_samples');
    if (Object.keys(calibrationDefaults).some(key => !finite(settings[key]) || settings[key] < 0) || settings.ridgeLambda <= 0 || settings.minTargetCount < 3 || settings.minSamplesPerTarget < 2) return fail('invalid_calibration_options');
    if (settings.sampleWeightGroup !== undefined && (typeof settings.sampleWeightGroup !== 'string' || !settings.sampleWeightGroup)) return fail('invalid_sample_weight_group');
    const groups = new Map();
    let featureCount = null;
    for (const sample of samples) {
      if (!targetValid(sample) || !Array.isArray(sample.features) || sample.features.length < 2 || sample.features.length > 4 || !sample.features.every(finite)) { diagnostics.rejectedSamples++; continue; }
      if (featureCount === null) featureCount = sample.features.length;
      if (sample.features.length !== featureCount) { diagnostics.rejectedSamples++; continue; }
      const key = targetKey(sample.targetId);
      if (!groups.has(key)) groups.set(key, { targetId: key, targetX: sample.targetX, targetY: sample.targetY, samples: [] });
      const group = groups.get(key);
      if (!sameTarget(sample, group)) return fail('inconsistent_calibration_target');
      group.samples.push(sample);
    }
    if (Array.isArray(settings.expectedTargetIds) && settings.expectedTargetIds.some(id => !groups.has(targetKey(id)))) return fail('missing_calibration_target');
    const targets = Array.from(groups.values());
    diagnostics.targetSummaries = targets.map(t => ({ targetId: t.targetId, targetX: t.targetX, targetY: t.targetY, sampleCount: t.samples.length }));
    if (targets.length < settings.minTargetCount) return fail('insufficient_calibration_targets');
    if (targets.some(t => t.samples.length < settings.minSamplesPerTarget)) return fail('insufficient_samples_per_target');
    if (settings.sampleWeightGroup) for (const target of targets) {
      const segments = new Map();
      for (const sample of target.samples) {
        const key = targetKey(sample[settings.sampleWeightGroup]);
        if (key === null) return fail('missing_sample_weight_group');
        if (!segments.has(key)) segments.set(key, []);
        segments.get(key).push(sample);
      }
      target.weightGroups = Array.from(segments.values());
    }
    const targetAverage = (target, value) => target.weightGroups
      ? mean(target.weightGroups.map(segment => mean(segment.map(value)))) : mean(target.samples.map(value));
    if (span(targets.map(t => t.targetX)) < settings.minTargetSpanX || span(targets.map(t => t.targetY)) < settings.minTargetSpanY) return fail('insufficient_target_span');
    diagnostics.targetLayout = layoutDiagnostics(targets);
    if (diagnostics.targetLayout.uniquePositionCount < settings.minTargetCount || !finite(diagnostics.targetLayout.correlation) || Math.abs(diagnostics.targetLayout.correlation) > settings.maxTargetCorrelation) return fail('degenerate_target_layout');
    const centers = targets.map(t => Array.from({ length: featureCount }, (_, i) => targetAverage(t, s => s.features[i])));
    const rawX = centers.map(f => featureCount === 4 ? (f[0] + f[2]) / 2 : f[0]);
    const rawY = centers.map(f => featureCount === 4 ? (f[1] + f[3]) / 2 : f[1]);
    diagnostics.rawSpanX = span(rawX); diagnostics.rawSpanY = span(rawY);
    if (diagnostics.rawSpanX < settings.minRawSpanX || diagnostics.rawSpanY < settings.minRawSpanY) return fail('insufficient_eye_feature_span');
    const mx = mean(rawX), my = mean(rawY);
    const varianceX = mean(rawX.map(v => (v - mx) ** 2)), varianceY = mean(rawY.map(v => (v - my) ** 2));
    const covariance = mean(rawX.map((v, i) => (v - mx) * (rawY[i] - my)));
    diagnostics.rawCorrelation = covariance / Math.sqrt(varianceX * varianceY);
    if (!finite(diagnostics.rawCorrelation) || Math.abs(diagnostics.rawCorrelation) > settings.maxRawCorrelation) return fail('degenerate_two_dimensional_features');
    const featureMean = Array.from({ length: featureCount }, (_, i) => mean(centers.map(f => f[i])));
    const featureScale = featureMean.map((mu, i) => Math.sqrt(mean(targets.map(t => targetAverage(t, s => (s.features[i] - mu) ** 2)))));
    const activeFeatures = featureScale.map((scale, index) => scale >= settings.minFeatureStd ? index : -1).filter(i => i >= 0);
    if (activeFeatures.length < 2) return fail('degenerate_feature_variance');
    const dimension = activeFeatures.length + 1;
    const matrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
    const targetX = Array(dimension).fill(0), targetY = Array(dimension).fill(0);
    for (const group of targets) {
      const segments = group.weightGroups || [group.samples];
      for (const segment of segments) {
        const weight = 1 / (targets.length * segments.length * segment.length);
        for (const sample of segment) {
          const row = [1].concat(activeFeatures.map(i => (sample.features[i] - featureMean[i]) / featureScale[i]));
          for (let i = 0; i < dimension; i++) {
            targetX[i] += weight * row[i] * group.targetX; targetY[i] += weight * row[i] * group.targetY;
            for (let j = 0; j < dimension; j++) matrix[i][j] += weight * row[i] * row[j];
          }
        }
      }
    }
    for (let i = 1; i < dimension; i++) matrix[i][i] += settings.ridgeLambda;
    const x = solve(matrix, targetX), y = solve(matrix, targetY);
    if (!x || !y || x.pivotRatio > settings.maxPivotRatio || y.pivotRatio > settings.maxPivotRatio) return fail('unstable_calibration_matrix');
    diagnostics.pivotRatio = Math.max(x.pivotRatio, y.pivotRatio);
    diagnostics.parameterCountPerAxis = dimension;
    const model = { version, kind: 'standardized_affine_ridge', featureCount, activeFeatures, featureMean, featureScale,
      coefficientsX: x.coefficients, coefficientsY: y.coefficients, ridgeLambda: settings.ridgeLambda,
      calibrationTargetCount: targets.length, unclipped: true };
    const trainingErrors = targets.map(group => targetAverage(group, sample => {
      const point = predict(model, sample.features);
      return Math.hypot(point.x - group.targetX, point.y - group.targetY);
    }));
    diagnostics.trainingMeanErrorNorm = mean(trainingErrors);
    diagnostics.warnings.push('Training error must not be reported as measured gaze accuracy.');
    return { ok: true, reason: null, model, diagnostics };
  }

  function predict(model, features) {
    const fail = reason => ({ x: null, y: null, ok: false, reason });
    if (!model || model.kind !== 'standardized_affine_ridge' || !Number.isInteger(model.featureCount) || model.featureCount < 2 || model.featureCount > 4 || !Array.isArray(model.activeFeatures) || model.activeFeatures.length < 2 || new Set(model.activeFeatures).size !== model.activeFeatures.length || !Array.isArray(model.featureMean) || !Array.isArray(model.featureScale) || !Array.isArray(model.coefficientsX) || !Array.isArray(model.coefficientsY)) return fail('invalid_model');
    if (model.featureTransform !== undefined) {
      const transform = model.featureTransform;
      if (!transform || transform.kind !== 'binocular_mean' || transform.inputFeatureCount !== 4 || transform.outputFeatureCount !== 2 || model.featureCount !== 2 || model.inputFeatureCount !== 4) return fail('invalid_feature_transform');
      if (!Array.isArray(features) || features.length !== 4 || !features.every(finite)) return fail('invalid_features');
      features = [(features[0] + features[2]) / 2, (features[1] + features[3]) / 2];
    }
    if (!Array.isArray(features) || features.length !== model.featureCount || !features.every(finite)) return fail('invalid_features');
    if (model.featureMean.length !== model.featureCount || model.featureScale.length !== model.featureCount || !model.featureMean.every(finite) || model.activeFeatures.some(i => !Number.isInteger(i) || i < 0 || i >= model.featureCount || !finite(model.featureScale[i]) || model.featureScale[i] <= 0)) return fail('invalid_model');
    const row = [1].concat(model.activeFeatures.map(i => (features[i] - model.featureMean[i]) / model.featureScale[i]));
    if (model.coefficientsX.length !== row.length || model.coefficientsY.length !== row.length || !model.coefficientsX.every(finite) || !model.coefficientsY.every(finite)) return fail('invalid_model');
    const x = row.reduce((sum, value, i) => sum + value * model.coefficientsX[i], 0);
    const y = row.reduce((sum, value, i) => sum + value * model.coefficientsY[i], 0);
    return finite(x) && finite(y) ? { x, y, ok: true, reason: null } : fail('nonfinite_prediction');
  }

  const validationDefaults = {
    minCoverage: 0.8, minSamplesPerPoint: 12, minTargetCount: 5, minTargetSpanX: 0.4, minTargetSpanY: 0.4,
    maxTargetCorrelation: 0.98,
    maxMeanErrorNorm: 0.12, maxP95ErrorNorm: 0.25, maxMeanAbsErrorX: 0.10, maxMeanAbsErrorY: 0.10,
    maxP95AbsErrorX: 0.20, maxP95AbsErrorY: 0.20, maxPointMeanErrorNorm: 0.18, maxPointP95ErrorNorm: 0.30,
    maxSampleGapMs: 500, minDurationMs: 200, requireTimestamps: true
  };
  function errorSummary(samples, weights) {
    const average = values => weights && values.length ? values.reduce((sum, value, i) => sum + value * weights[i], 0) / weights.reduce((sum, w) => sum + w, 0) : mean(values);
    function percentile(values, p) {
      if (!weights || !values.length) return quantile(values, p);
      const sorted = values.map((value, i) => ({ value, weight: weights[i] })).sort((a, b) => a.value - b.value);
      const cutoff = weights.reduce((sum, w) => sum + w, 0) * p;
      let sum = 0;
      for (const entry of sorted) { sum += entry.weight; if (sum >= cutoff) return entry.value; }
      return sorted[sorted.length - 1].value;
    }
    const dx = samples.map(s => s.x - s.targetX), dy = samples.map(s => s.y - s.targetY);
    const ax = dx.map(Math.abs), ay = dy.map(Math.abs), norm = dx.map((x, i) => Math.hypot(x, dy[i]));
    return { meanErrorNorm: average(norm), medianErrorNorm: percentile(norm, 0.5), p95ErrorNorm: percentile(norm, 0.95),
      meanAbsErrorX: average(ax), meanAbsErrorY: average(ay), medianAbsErrorX: percentile(ax, 0.5), medianAbsErrorY: percentile(ay, 0.5),
      p95AbsErrorX: percentile(ax, 0.95), p95AbsErrorY: percentile(ay, 0.95), biasX: average(dx), biasY: average(dy) };
  }
  function spreadSummary(samples) {
    if (samples.length < 2) return { sdX: null, sdY: null, radialRmsAroundMean: null };
    const centerX = mean(samples.map(s => s.x)), centerY = mean(samples.map(s => s.y));
    const varianceX = mean(samples.map(s => (s.x - centerX) ** 2));
    const varianceY = mean(samples.map(s => (s.y - centerY) ** 2));
    return { sdX: Math.sqrt(varianceX), sdY: Math.sqrt(varianceY), radialRmsAroundMean: Math.sqrt(varianceX + varianceY) };
  }

  // Model comparison uses calibration rounds only. Neither this selection score
  // nor the final training residuals certify independent gaze accuracy.
  function createRepeatedCalibration(samples, options = {}) {
    const validOptions = options && typeof options === 'object' && !Array.isArray(options);
    if (!validOptions) options = {};
    const candidates = [
      { id: 'four_eye_affine', label: '双眼四特征仿射', ok: false, reason: 'not_evaluated', score: null, folds: [], perTarget: [] },
      { id: 'binocular_mean_affine', label: '双眼均值仿射', ok: false, reason: 'not_evaluated', score: null, folds: [], perTarget: [] }
    ];
    const diagnostics = {
      protocol: 'two_round_cross_validation_v1', expectedRoundCount: 2, expectedTargetCount: 9,
      candidates, selectedCandidateId: null,
      selectionRule: '仅使用校准数据：第1轮训练、第2轮测试，再反向检验；各目标等权、两轮等权。平均二维误差较小者入选，差值不超过1e-12时优先双眼四特征。固定岭系数0.01。',
      weighting: 'Each target receives equal weight; each presentation within a target receives equal weight; each valid frame within its presentation receives equal weight.',
      note: 'Training residuals and cross-round calibration errors are not independent accuracy validation. A new held-out validation is required after model selection.',
      minSamplesPerPresentation: options.minSamplesPerPresentation === undefined ? 12 : options.minSamplesPerPresentation,
      attemptCount: Array.isArray(samples) ? samples.length : 0, validCount: 0,
      integrityFailures: [], roundSummaries: [1, 2].map(roundIndex => ({ roundIndex, attemptCount: 0, validCount: 0, presentationCount: 0, targetCount: 0, invalidReasons: {}, presentations: [] })),
      perTargetFit: [], trainingMetrics: null
    };
    const fail = reason => {
      for (const candidate of candidates) if (candidate.reason === 'not_evaluated') candidate.reason = reason;
      return { ok: false, reason, model: null, diagnostics };
    };
    if (!validOptions) return fail('invalid_repeated_calibration_options');
    if (!Array.isArray(samples) || !samples.length) return fail('no_calibration_samples');
    if (!Number.isInteger(diagnostics.minSamplesPerPresentation) || diagnostics.minSamplesPerPresentation < 12) return fail('invalid_repeated_calibration_options');
    const expected = new Map();
    const suppliedTargets = options.expectedTargets === undefined
      ? samples.filter(targetValid).filter((sample, index, all) => all.findIndex(other => targetKey(other.targetId) === targetKey(sample.targetId)) === index)
      : options.expectedTargets;
    if (!Array.isArray(suppliedTargets)) return fail('invalid_expected_calibration_targets');
    for (const target of suppliedTargets) {
      if (!targetValid(target) || expected.has(targetKey(target.targetId))) return fail('invalid_expected_calibration_targets');
      expected.set(targetKey(target.targetId), { targetId: targetKey(target.targetId), targetX: target.targetX, targetY: target.targetY });
    }
    if (expected.size !== 9) return fail('expected_nine_calibration_targets');
    const presentations = new Map(), presentationIds = new Map();
    const addIntegrity = reason => { if (!diagnostics.integrityFailures.includes(reason)) diagnostics.integrityFailures.push(reason); };
    for (const sample of samples) {
      const roundIndex = sample && sample.roundIndex;
      const round = diagnostics.roundSummaries.find(item => item.roundIndex === roundIndex);
      const validFeatures = sample && sample.valid === true && Array.isArray(sample.features) && sample.features.length === 4 && sample.features.every(finite);
      if (round) {
        round.attemptCount++;
        if (validFeatures) { round.validCount++; diagnostics.validCount++; }
        else {
          const reason = sample && sample.valid !== true && typeof sample.reason === 'string' && sample.reason ? sample.reason : 'invalid_features';
          round.invalidReasons[reason] = (round.invalidReasons[reason] || 0) + 1;
        }
      }
      if (!round) { addIntegrity('unexpected_calibration_round'); continue; }
      if (!targetValid(sample) || !expected.has(targetKey(sample.targetId))) { addIntegrity('unexpected_calibration_target'); continue; }
      const target = expected.get(targetKey(sample.targetId));
      if (!sameTarget(sample, target)) { addIntegrity('inconsistent_calibration_target'); continue; }
      const presentationId = targetKey(sample.presentationId);
      if (presentationId === null) { addIntegrity('missing_presentation_id'); continue; }
      const key = JSON.stringify([roundIndex, target.targetId]);
      if (presentationIds.has(presentationId) && presentationIds.get(presentationId) !== key) { addIntegrity('presentation_id_reused'); continue; }
      presentationIds.set(presentationId, key);
      if (!presentations.has(key)) presentations.set(key, { ...target, roundIndex, presentationId, attempts: [], samples: [] });
      const presentation = presentations.get(key);
      if (presentation.presentationId !== presentationId) { addIntegrity('duplicate_target_presentation'); continue; }
      presentation.attempts.push(sample);
      if (validFeatures) presentation.samples.push(sample);
    }
    for (const round of diagnostics.roundSummaries) {
      const actual = Array.from(presentations.values()).filter(presentation => presentation.roundIndex === round.roundIndex);
      round.presentationCount = actual.length; round.targetCount = new Set(actual.map(presentation => presentation.targetId)).size;
      round.presentations = actual.map(presentation => ({ targetId: presentation.targetId, presentationId: presentation.presentationId,
        attemptCount: presentation.attempts.length, validCount: presentation.samples.length }));
      for (const target of expected.values()) {
        const presentation = presentations.get(JSON.stringify([round.roundIndex, target.targetId]));
        if (!presentation) addIntegrity('incomplete_calibration_round');
        else if (presentation.samples.length < diagnostics.minSamplesPerPresentation) addIntegrity('insufficient_samples_per_presentation');
      }
    }
    if (diagnostics.integrityFailures.length) return fail(diagnostics.integrityFailures[0]);
    const segments = Array.from(presentations.values());
    const transformed = (sample, candidate) => ({ ...sample, features: candidate.id === 'binocular_mean_affine'
      ? [(sample.features[0] + sample.features[2]) / 2, (sample.features[1] + sample.features[3]) / 2] : sample.features.slice() });
    function fitSegments(selected, candidate) {
      const result = createCalibration(selected.flatMap(segment => segment.samples.map(sample => transformed(sample, candidate))), {
        expectedTargetIds: Array.from(expected.keys()), minTargetCount: 9, minSamplesPerTarget: 12,
        ridgeLambda: 0.01, sampleWeightGroup: 'presentationId'
      });
      if (result.ok) {
        result.model.candidateId = candidate.id; result.model.inputFeatureCount = 4;
        if (candidate.id === 'binocular_mean_affine') result.model.featureTransform = { kind: 'binocular_mean', inputFeatureCount: 4, outputFeatureCount: 2 };
      }
      return result;
    }
    function predictedSegment(segment, model) {
      return segment.samples.map(sample => {
        const point = predict(model, sample.features);
        return { targetX: segment.targetX, targetY: segment.targetY, x: point.x, y: point.y };
      });
    }
    function aggregate(segmentSamples) {
      return errorSummary(segmentSamples.flat(), segmentSamples.flatMap(group => group.map(() => 1 / group.length)));
    }
    const candidateModels = new Map();
    for (const candidate of candidates) {
      const foldPoints = [];
      for (const trainRoundIndex of [1, 2]) {
        const testRoundIndex = 3 - trainRoundIndex;
        const result = fitSegments(segments.filter(segment => segment.roundIndex === trainRoundIndex), candidate);
        const fold = { trainRoundIndex, testRoundIndex, ok: result.ok, reason: result.reason, score: null, metrics: null, perTarget: [], fitDiagnostics: result.diagnostics };
        if (result.ok) {
          const testSegments = segments.filter(segment => segment.roundIndex === testRoundIndex);
          const points = testSegments.map(segment => ({ segment, samples: predictedSegment(segment, result.model) }));
          if (points.some(point => point.samples.some(sample => !finite(sample.x) || !finite(sample.y)))) {
            fold.ok = false; fold.reason = 'nonfinite_cross_round_prediction';
          } else {
            fold.metrics = aggregate(points.map(point => point.samples)); fold.score = fold.metrics.meanErrorNorm;
            fold.perTarget = points.map(point => ({ targetId: point.segment.targetId, targetX: point.segment.targetX, targetY: point.segment.targetY,
              validCount: point.samples.length, metrics: errorSummary(point.samples) }));
            foldPoints.push({ testRoundIndex, points });
          }
        }
        candidate.folds.push(fold);
      }
      candidate.ok = candidate.folds.every(fold => fold.ok);
      candidate.reason = candidate.ok ? null : 'cross_round_fit_failed';
      if (candidate.ok) {
        candidate.score = mean(candidate.folds.map(fold => fold.score));
        candidate.perTarget = Array.from(expected.values()).map(target => {
          const paired = foldPoints.map(fold => ({ testRoundIndex: fold.testRoundIndex, ...fold.points.find(point => point.segment.targetId === target.targetId) }));
          return { ...target, metrics: aggregate(paired.map(point => point.samples)),
            folds: paired.map(point => ({ testRoundIndex: point.testRoundIndex, metrics: errorSummary(point.samples) })) };
        });
        const finalFit = fitSegments(segments, candidate);
        candidate.finalFit = { ok: finalFit.ok, reason: finalFit.reason, diagnostics: finalFit.diagnostics };
        if (!finalFit.ok) { candidate.ok = false; candidate.reason = 'final_fit_failed:' + finalFit.reason; }
        else if (segments.some(segment => predictedSegment(segment, finalFit.model).some(point => !finite(point.x) || !finite(point.y)))) {
          candidate.ok = false; candidate.reason = 'nonfinite_final_prediction';
          candidate.finalFit.ok = false; candidate.finalFit.reason = candidate.reason;
        } else candidateModels.set(candidate.id, finalFit.model);
      }
    }
    // Eligibility is candidate-specific; an eligible model completes both folds
    // and the final fit. A failed candidate never becomes a single-round fallback.
    const eligible = candidates.filter(candidate => candidate.ok);
    if (!eligible.length) return fail('no_eligible_calibration_candidate');
    const selected = eligible.reduce((best, candidate) => candidate.score < best.score - 1e-12 ? candidate : best);
    diagnostics.selectedCandidateId = selected.id;
    const model = candidateModels.get(selected.id);
    diagnostics.finalFitDiagnostics = selected.finalFit.diagnostics;
    model.calibrationProtocol = diagnostics.protocol;
    model.calibrationRoundCount = 2;
    const predictions = segments.map(segment => ({ segment, samples: predictedSegment(segment, model) }));
    if (predictions.some(point => point.samples.some(sample => !finite(sample.x) || !finite(sample.y)))) return fail('nonfinite_final_prediction');
    diagnostics.trainingMetrics = aggregate(predictions.map(point => point.samples));
    diagnostics.perTargetFit = Array.from(expected.values()).map(target => {
      const paired = predictions.filter(point => point.segment.targetId === target.targetId).sort((a, b) => a.segment.roundIndex - b.segment.roundIndex);
      const roundMeans = paired.map(point => ({ roundIndex: point.segment.roundIndex, presentationId: point.segment.presentationId,
        attemptCount: point.segment.attempts.length, validCount: point.samples.length,
        x: mean(point.samples.map(sample => sample.x)), y: mean(point.samples.map(sample => sample.y)),
        features: [0, 1, 2, 3].map(index => mean(point.segment.samples.map(sample => sample.features[index]))),
        featureSD: [0, 1, 2, 3].map(index => {
          const values = point.segment.samples.map(sample => sample.features[index]), average = mean(values);
          return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
        }), metrics: errorSummary(point.samples), ...spreadSummary(point.samples) }));
      const centerX = mean(roundMeans.map(round => round.x)), centerY = mean(roundMeans.map(round => round.y));
      const varianceX = mean(paired.map(point => mean(point.samples.map(sample => (sample.x - centerX) ** 2))));
      const varianceY = mean(paired.map(point => mean(point.samples.map(sample => (sample.y - centerY) ** 2))));
      return { ...target, attemptCount: paired.reduce((sum, point) => sum + point.segment.attempts.length, 0),
        validCount: paired.reduce((sum, point) => sum + point.samples.length, 0), metrics: aggregate(paired.map(point => point.samples)),
        sdX: Math.sqrt(varianceX), sdY: Math.sqrt(varianceY), radialRmsAroundMean: Math.sqrt(varianceX + varianceY), roundMeans,
        roundMeanDelta: { x: roundMeans[1].x - roundMeans[0].x, y: roundMeans[1].y - roundMeans[0].y,
          features: roundMeans[0].features.map((value, index) => roundMeans[1].features[index] - value) } };
    });
    return { ok: true, reason: null, model, diagnostics };
  }

  function evaluateValidation(samples, options = {}) {
    const settings = Object.assign({}, validationDefaults, options);
    const failures = [], groups = new Map(), invalidReasons = {};
    const diagnostics = { settings, invalidReasons, aggregation: 'Equal weight per target; within each target equal weight per valid sample. Aggregate quantiles use the weighted empirical CDF; per-point quantiles interpolate.', note: 'Editable engineering gates, not certified accuracy. Errors use screen-width/screen-height fractions, not visual degrees or physical distance.', coverageDenominator: 'All logged attempts per expected target; missing targets contribute zero. Every failed/no-face attempt must be logged.' };
    diagnostics.precision = {
      definition: 'Within each target, sdX/sdY use squared deviations from the sample mean divided by N; radialRmsAroundMean is sqrt(mean(dx^2 + dy^2)) around that same mean. At least two valid samples are required.',
      aggregation: 'Each aggregate spread field is the arithmetic mean of the corresponding within-target field, with equal weight per target that has at least two valid samples; it is not pooled spread across target positions.',
      interpretation: 'Observed spread includes natural fixation instability, head movement, and tracking/model variation. It is not ground-truth hardware noise or an independently established precision guarantee.',
      passGate: false
    };
    const addFailure = code => { if (!failures.includes(code)) failures.push(code); };
    if (Object.keys(validationDefaults).some(key => key !== 'requireTimestamps' && (!finite(settings[key]) || settings[key] < 0)) || settings.minCoverage > 1 || settings.minTargetCount < 3 || settings.minSamplesPerPoint < 2) addFailure('invalid_validation_options');
    if (!Array.isArray(samples)) { samples = []; addFailure('invalid_validation_samples'); }
    if (Array.isArray(settings.expectedTargets)) {
      for (const target of settings.expectedTargets) {
        if (!targetValid(target)) { addFailure('invalid_expected_target'); continue; }
        const key = targetKey(target.targetId);
        if (groups.has(key)) { addFailure('duplicate_expected_target'); continue; }
        groups.set(key, { targetId: key, targetX: target.targetX, targetY: target.targetY, attempts: [], validSamples: [], failures: [] });
      }
    }
    let unassignedAttempts = 0;
    for (const sample of samples) {
      if (!targetValid(sample)) { unassignedAttempts++; addFailure('unassigned_or_invalid_target'); continue; }
      const key = targetKey(sample.targetId);
      if (!groups.has(key)) {
        if (Array.isArray(settings.expectedTargets)) { unassignedAttempts++; addFailure('unexpected_target'); continue; }
        groups.set(key, { targetId: key, targetX: sample.targetX, targetY: sample.targetY, attempts: [], validSamples: [], failures: [] });
      }
      const group = groups.get(key);
      group.attempts.push(sample);
      let reason = null;
      if (!sameTarget(sample, group)) { reason = 'inconsistent_target_coordinates'; addFailure(reason); }
      else if (!(sample.valid === true || sample.valid === 1)) reason = typeof sample.reason === 'string' && sample.reason ? sample.reason : 'invalid_tracking';
      else if (!finite(sample.x) || !finite(sample.y)) reason = 'nonfinite_prediction';
      else if (settings.requireTimestamps && !finite(sample.timestamp)) reason = 'invalid_timestamp';
      if (reason) invalidReasons[reason] = (invalidReasons[reason] || 0) + 1;
      else group.validSamples.push(sample);
    }
    const pointSummaries = Array.from(groups.values()).map(group => {
      const pointFailures = group.failures;
      const validCount = group.validSamples.length, attemptCount = group.attempts.length;
      const coverage = attemptCount ? validCount / attemptCount : 0;
      if (!attemptCount) pointFailures.push('missing_target');
      if (validCount < settings.minSamplesPerPoint) pointFailures.push('insufficient_valid_samples');
      if (coverage < settings.minCoverage) pointFailures.push('insufficient_coverage');
      let maxGapMs = null, durationMs = null;
      const timestamps = group.validSamples.map(s => s.timestamp);
      if (timestamps.length && timestamps.every(finite)) {
        const gaps = timestamps.slice(1).map((timestamp, i) => timestamp - timestamps[i]);
        durationMs = timestamps[timestamps.length - 1] - timestamps[0];
        maxGapMs = gaps.length ? Math.max(...gaps) : null;
        if (gaps.some(gap => gap <= 0)) pointFailures.push('nonmonotonic_timestamps');
        if (maxGapMs !== null && maxGapMs > settings.maxSampleGapMs) pointFailures.push('discontinuous_valid_samples');
        if (durationMs < settings.minDurationMs) pointFailures.push('insufficient_duration');
      } else if (settings.requireTimestamps) pointFailures.push('missing_valid_timestamps');
      if (settings.requireTimestamps && group.attempts.some(s => !finite(s.timestamp))) pointFailures.push('invalid_attempt_timestamp');
      const metrics = errorSummary(group.validSamples);
      if (metrics.meanErrorNorm !== null && metrics.meanErrorNorm > settings.maxPointMeanErrorNorm) pointFailures.push('point_mean_error');
      if (metrics.p95ErrorNorm !== null && metrics.p95ErrorNorm > settings.maxPointP95ErrorNorm) pointFailures.push('point_p95_error');
      if (metrics.meanAbsErrorX !== null && metrics.meanAbsErrorX > settings.maxMeanAbsErrorX) pointFailures.push('point_x_mean_error');
      if (metrics.meanAbsErrorY !== null && metrics.meanAbsErrorY > settings.maxMeanAbsErrorY) pointFailures.push('point_y_mean_error');
      if (metrics.p95AbsErrorX !== null && metrics.p95AbsErrorX > settings.maxP95AbsErrorX) pointFailures.push('point_x_p95_error');
      if (metrics.p95AbsErrorY !== null && metrics.p95AbsErrorY > settings.maxP95AbsErrorY) pointFailures.push('point_y_p95_error');
      if (pointFailures.length) addFailure('target_failed:' + group.targetId);
      return Object.assign({ targetId: group.targetId, targetX: group.targetX, targetY: group.targetY, attemptCount, validCount, coverage, durationMs, maxGapMs, passed: pointFailures.length === 0, failures: pointFailures }, metrics, spreadSummary(group.validSamples));
    });
    if (pointSummaries.length < settings.minTargetCount) addFailure('insufficient_validation_targets');
    if (span(pointSummaries.map(p => p.targetX)) < settings.minTargetSpanX || span(pointSummaries.map(p => p.targetY)) < settings.minTargetSpanY) addFailure('insufficient_validation_target_span');
    diagnostics.targetLayout = layoutDiagnostics(pointSummaries);
    if (diagnostics.targetLayout.uniquePositionCount < settings.minTargetCount || !finite(diagnostics.targetLayout.correlation) || Math.abs(diagnostics.targetLayout.correlation) > settings.maxTargetCorrelation) addFailure('degenerate_validation_target_layout');
    const validSamples = Array.from(groups.values()).flatMap(group => group.validSamples);
    const weights = Array.from(groups.values()).flatMap(group => group.validSamples.map(() => 1 / group.validSamples.length));
    const metrics = errorSummary(validSamples, weights);
    const spreadPoints = pointSummaries.filter(point => finite(point.radialRmsAroundMean));
    const spread = { sdX: mean(spreadPoints.map(point => point.sdX)), sdY: mean(spreadPoints.map(point => point.sdY)),
      radialRmsAroundMean: mean(spreadPoints.map(point => point.radialRmsAroundMean)), precisionPointCount: spreadPoints.length };
    const coverage = mean(pointSummaries.map(p => p.coverage)) || 0;
    if (!validSamples.length) addFailure('no_valid_samples');
    if (coverage < settings.minCoverage) addFailure('insufficient_coverage');
    const metricGates = { meanErrorNorm: 'maxMeanErrorNorm', p95ErrorNorm: 'maxP95ErrorNorm', meanAbsErrorX: 'maxMeanAbsErrorX', meanAbsErrorY: 'maxMeanAbsErrorY', p95AbsErrorX: 'maxP95AbsErrorX', p95AbsErrorY: 'maxP95AbsErrorY' };
    for (const [metric, threshold] of Object.entries(metricGates)) if (metrics[metric] !== null && metrics[metric] > settings[threshold]) addFailure(metric + '_exceeded');
    return Object.assign({ passed: failures.length === 0, failures, pointSummaries, coverage,
      sampleCoverage: samples.length ? validSamples.length / samples.length : 0,
      attemptCount: samples.length, validCount: validSamples.length, unassignedAttempts, diagnostics }, metrics, spread);
  }

  return { version, qualityThresholds, extractFeatures, createTemporalQualityGate, createCalibration, createRepeatedCalibration, predict, evaluateValidation };
}));
