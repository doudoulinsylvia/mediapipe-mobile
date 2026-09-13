/* Personal calibration for frozen image-network outputs. Independently implemented.
 * No validation observations or clipping are used to fit/select the model. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImageCalibration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'image-ridge-v1';
  const OUTPUT_LENGTH = 258;
  const CANDIDATES = Object.freeze([
    { id: 'network_xy_ridge_0.01', representation: 'network_xy', lambda: .01 },
    { id: 'embedding_ridge_0.01', representation: 'embedding', lambda: .01 },
    { id: 'embedding_ridge_0.1', representation: 'embedding', lambda: .1 },
    { id: 'embedding_ridge_1', representation: 'embedding', lambda: 1 }
  ].map(Object.freeze));
  const finite = Number.isFinite;
  const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(finite);
  const representationLength = name => name === 'network_xy' ? 2 : name === 'embedding' ? 256 : null;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  function median(a) {
    const b = a.slice().sort((x, y) => x - y), i = (b.length - 1) / 2;
    return (b[Math.floor(i)] + b[Math.ceil(i)]) / 2;
  }
  function extract(output, representation) {
    return representation === 'network_xy' ? output.slice(0, 2) : output.slice(2);
  }
  function solveSPD(matrix, rhs) {
    if (!Array.isArray(matrix) || matrix.length < 1 || !vector(rhs, matrix.length) ||
        !matrix.every(row => vector(row, matrix.length)) ||
        matrix.some((row, i) => row.some((value, j) => Math.abs(value - matrix[j][i]) > 1e-10))) throw Error('invalid_linear_system');
    const n = matrix.length, l = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let x = matrix[i][j];
      for (let k = 0; k < j; k++) x -= l[i][k] * l[j][k];
      if (i === j) { if (!finite(x) || x <= 1e-12) throw Error('ill_conditioned_model'); l[i][j] = Math.sqrt(x); }
      else l[i][j] = x / l[j][j];
    }
    const z = Array(n).fill(0), result = Array(n).fill(0);
    for (let i = 0; i < n; i++) { let x = rhs[i]; for (let j = 0; j < i; j++) x -= l[i][j] * z[j]; z[i] = x / l[i][i]; }
    for (let i = n - 1; i >= 0; i--) { let x = z[i]; for (let j = i + 1; j < n; j++) x -= l[j][i] * result[j]; result[i] = x / l[i][i]; }
    if (!result.every(finite)) throw Error('nonfinite_model');
    return result;
  }
  function fitRepresentatives(reps, candidate) {
    if (!candidate || representationLength(candidate.representation) === null || !finite(candidate.lambda) || candidate.lambda <= 0) throw Error('invalid_calibration_candidate');
    if (!Array.isArray(reps) || reps.length < 2 || !reps.every(p => p && vector(p.output, OUTPUT_LENGTH) &&
        [p.targetX,p.targetY].every(v => finite(v) && v >= 0 && v <= 1))) throw Error('invalid_calibration_representatives');
    const x = reps.map(p => extract(p.output, candidate.representation));
    const mu = x[0].map((_, j) => mean(x.map(r => r[j])));
    const scale = mu.map((m, j) => Math.sqrt(mean(x.map(r => (r[j] - m) ** 2))));
    const active = scale.map((s, j) => s >= 1e-6 ? j : -1).filter(j => j >= 0);
    if (active.length < 2) throw Error('insufficient_feature_variation');
    const z = x.map(r => active.map(j => (r[j] - mu[j]) / scale[j]));
    const kernel = (a, b) => a.reduce((s, v, j) => s + v * b[j], 0) / active.length;
    const matrix = z.map((a, i) => z.map((b, j) => kernel(a, b) + (i === j ? reps.length * candidate.lambda : 0)));
    const targetMean = [mean(reps.map(p => p.targetX)), mean(reps.map(p => p.targetY))];
    return {
      version: VERSION, candidateId: candidate.id, representation: candidate.representation,
      lambda: candidate.lambda, outputLength: OUTPUT_LENGTH, mean: mu, scale, active,
      anchors: z, alphaX: solveSPD(matrix, reps.map(p => p.targetX - targetMean[0])),
      alphaY: solveSPD(matrix, reps.map(p => p.targetY - targetMean[1])), targetMean,
      trainingPresentationIds: reps.map(p => p.presentationId), unclipped: true
    };
  }
  function predict(model, output) {
    const dimension = model && representationLength(model.representation);
    if (!model || model.version !== VERSION || model.outputLength !== OUTPUT_LENGTH || dimension === null ||
        !vector(output, OUTPUT_LENGTH) || !vector(model.mean, dimension) || !vector(model.scale, dimension) ||
        !Array.isArray(model.active) || model.active.length < 2 || new Set(model.active).size !== model.active.length ||
        !model.active.every(j => Number.isInteger(j) && j >= 0 && j < dimension && model.scale[j] >= 1e-6) ||
        !Array.isArray(model.anchors) || model.anchors.length < 2 || !model.anchors.every(a => vector(a, model.active.length)) ||
        !vector(model.alphaX, model.anchors.length) || !vector(model.alphaY, model.anchors.length) || !vector(model.targetMean, 2))
      return { valid: false, x: null, y: null, reason: 'invalid_model_input' };
    const f = extract(output, model.representation);
    const z = model.active.map(j => (f[j] - model.mean[j]) / model.scale[j]);
    const k = model.anchors.map(a => mean(a.map((v, j) => v * z[j])));
    const x = model.targetMean[0] + k.reduce((s, v, i) => s + v * model.alphaX[i], 0);
    const y = model.targetMean[1] + k.reduce((s, v, i) => s + v * model.alphaY[i], 0);
    return finite(x) && finite(y) ? { valid: true, x, y } : { valid: false, x: null, y: null, reason: 'nonfinite_prediction' };
  }
  function fitCalibration(presentations, options = {}) {
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('invalid_calibration_options');
      const minSamples = options.minSamples === undefined ? 12 : options.minSamples;
      if (!Number.isInteger(minSamples) || minSamples < 12) throw Error('invalid_min_samples');
      if (!Array.isArray(presentations) || presentations.length !== 18) throw Error('expected_18_calibration_presentations');
      const seen = new Set(), ids = new Set(), targetMap = new Map(), sampleIds = new Set();
      const groups = presentations.map(p => {
        if (!p || p.kind !== 'calibration' || ![1, 2].includes(p.roundIndex) || typeof p.presentationId !== 'string' || !p.presentationId || ids.has(p.presentationId))
          throw Error('invalid_calibration_identity');
        ids.add(p.presentationId);
        if (typeof p.targetId !== 'string' || !p.targetId || ![p.targetX, p.targetY].every(v => finite(v) && v >= 0 && v <= 1)) throw Error('invalid_calibration_target');
        const key = p.roundIndex + ':' + p.targetId;
        if (seen.has(key)) throw Error('duplicate_calibration_target');
        seen.add(key);
        if (targetMap.has(p.targetId) && targetMap.get(p.targetId).some((v, i) => v !== [p.targetX, p.targetY][i])) throw Error('inconsistent_calibration_target');
        targetMap.set(p.targetId, [p.targetX, p.targetY]);
        if (!Array.isArray(p.attempts)) throw Error('invalid_calibration_attempts');
        const hasWindow = p.collectStart !== undefined || p.collectEnd !== undefined;
        if (hasWindow && (!finite(p.collectStart) || !finite(p.collectEnd) || p.collectStart < 0 || p.collectEnd <= p.collectStart)) throw Error('invalid_calibration_window');
        let last = -Infinity;
        for (const a of p.attempts) {
          if (!a || typeof a.valid !== 'boolean') throw Error('invalid_calibration_attempt');
          if (!finite(a.timestamp) || a.timestamp < 0 || a.timestamp <= last) throw Error('invalid_calibration_timestamps');
          last = a.timestamp;
          if ((a.kind !== undefined && a.kind !== 'calibration') || (a.phase !== undefined && a.phase !== 'calibration') ||
              (a.presentationId !== undefined && a.presentationId !== p.presentationId) || (a.targetId !== undefined && a.targetId !== p.targetId) ||
              (a.roundIndex !== undefined && a.roundIndex !== p.roundIndex) || (a.targetX !== undefined && a.targetX !== p.targetX) ||
              (a.targetY !== undefined && a.targetY !== p.targetY)) throw Error('inconsistent_sample_identity');
          if (a.sampleId !== undefined) {
            if ((!Number.isSafeInteger(a.sampleId) || a.sampleId <= 0) && (typeof a.sampleId !== 'string' || !a.sampleId)) throw Error('invalid_sample_id');
            if (sampleIds.has(String(a.sampleId))) throw Error('duplicate_sample_id');
            sampleIds.add(String(a.sampleId));
          }
          const completedAt = a.completedAt === undefined ? a.timestamp : a.completedAt;
          if (!finite(completedAt) || completedAt < a.timestamp ||
              (a.capturedAt !== undefined && (!finite(a.capturedAt) || a.capturedAt < 0 || a.capturedAt > a.timestamp))) throw Error('invalid_capture_timestamp');
          // Captured-in-window frames that finish late remain in the diagnostic
          // denominator as invalid attempts. Only admitted frames must also
          // complete inside the window; never discard late attempts to fit.
          if (hasWindow && (!finite(a.capturedAt) || a.capturedAt < p.collectStart || a.capturedAt > p.collectEnd ||
              (a.valid && completedAt > p.collectEnd))) throw Error('sample_outside_calibration_window');
          if (a.valid && !vector(a.output, OUTPUT_LENGTH)) throw Error('expected_258_network_outputs');
        }
        const samples = p.attempts.filter(a => a.valid);
        if (samples.length < minSamples) throw Error('insufficient_calibration_samples:' + p.targetId);
        return { ...p, samples, output: Array.from({ length: OUTPUT_LENGTH }, (_, j) => median(samples.map(a => a.output[j]))) };
      });
      if (targetMap.size !== 9 || [1, 2].some(r => groups.filter(p => p.roundIndex === r).length !== 9)) throw Error('incomplete_calibration_grid');
      const positions = [...targetMap.values()];
      if (new Set(positions.map(p => p.join(','))).size !== 9 || [0, 1].some(j => Math.max(...positions.map(p => p[j])) - Math.min(...positions.map(p => p[j])) < .5)) throw Error('degenerate_calibration_grid');
      const mx = mean(positions.map(p => p[0])), my = mean(positions.map(p => p[1]));
      const vx = mean(positions.map(p => (p[0]-mx)**2)), vy = mean(positions.map(p => (p[1]-my)**2));
      const covariance = mean(positions.map(p => (p[0]-mx)*(p[1]-my)));
      if (vx*vy-covariance**2 <= 1e-12) throw Error('degenerate_calibration_grid');
      const candidates = CANDIDATES.map(c => {
        try {
          const folds = [1, 2].map(trainRound => {
            const m = fitRepresentatives(groups.filter(p => p.roundIndex === trainRound), c);
            const perTarget = groups.filter(p => p.roundIndex !== trainRound).map(p => {
              const errors = p.samples.map(a => {
                const q = predict(m, a.output);
                if (!q.valid) throw Error('invalid_cv_prediction');
                return { x: Math.abs(q.x - p.targetX), y: Math.abs(q.y - p.targetY), radial: Math.hypot(q.x - p.targetX, q.y - p.targetY) };
              });
              return { targetId: p.targetId, sampleCount: errors.length, meanAbsErrorX: mean(errors.map(e => e.x)), meanAbsErrorY: mean(errors.map(e => e.y)), meanErrorNorm: mean(errors.map(e => e.radial)) };
            });
            return { trainRound, testRound: 3 - trainRound, score: mean(perTarget.map(p => p.meanErrorNorm)), perTarget };
          });
          return { ...c, ok: true, score: mean(folds.map(f => f.score)), folds, model: fitRepresentatives(groups, c) };
        } catch (e) { return { ...c, ok: false, reason: e.message }; }
      });
      const eligible = candidates.filter(c => c.ok);
      if (!eligible.length) throw Error('no_eligible_calibration_model');
      const selected = eligible.reduce((best, c) => c.score < best.score - 1e-12 ? c : best);
      return { ok: true, model: selected.model, selectedCandidateId: selected.id,
        candidates: candidates.map(({ model, ...c }) => c),
        representatives: groups.map(({ presentationId, targetId, targetX, targetY, roundIndex, output, samples }) => ({ presentationId, targetId, targetX, targetY, roundIndex, sampleCount: samples.length, output })),
        protocol: { version: VERSION, weighting: 'Equal presentation; held-out frames evaluated equally within each target; equal folds.',
          selection: 'Minimum two-round held-out mean normalized error, fixed candidate order for ties.',
          regularization: 'Linear kernel after training-only feature standardization, K = Z Z^T / activeFeatureCount; diagonal = n * lambda.',
          limitation: 'Cross-round calibration is not independent validation. Network coordinates are uncalibrated inputs, not screen gaze.' } };
    } catch (e) { return { ok: false, reason: e.message, model: null }; }
  }
  return { VERSION, OUTPUT_LENGTH, CANDIDATES, fitCalibration, predict, fitRepresentatives, solveSPD };
});
