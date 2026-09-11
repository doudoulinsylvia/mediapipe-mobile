/* Causal eye-feature stability only; no gaze target, prediction or DOM access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalibrationStability = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const version = '2.2.0';
  const defaults = Object.freeze({ windowMs: 600, minFrames: 12, maxGapMs: 150, maxSpread: .06, maxDrift: .025, maxStep: .08 });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function quantile(values, fraction) {
    const sorted = values.slice().sort((a, b) => a - b), index = (sorted.length - 1) * fraction;
    return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index - Math.floor(index));
  }
  function createGate(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new RangeError('Invalid stability options');
    const settings = Object.freeze({ ...defaults, ...options });
    if (!finite(settings.windowMs) || settings.windowMs <= 0 || !Number.isInteger(settings.minFrames) || settings.minFrames < 2 ||
        !finite(settings.maxGapMs) || settings.maxGapMs <= 0 || !finite(settings.maxSpread) || settings.maxSpread < 0 ||
        !finite(settings.maxDrift) || settings.maxDrift < 0 || !finite(settings.maxStep) || settings.maxStep < 0) throw new RangeError('Invalid stability options');
    let frames = [], lastTimestamp = null;
    function reset() { frames = []; lastTimestamp = null; }
    function result(stable, reason, spread = null, drift = null, step = null) {
      return { stable, reason, frameCount: frames.length,
        durationMs: frames.length > 1 ? frames[frames.length - 1].timestamp - frames[0].timestamp : 0,
        spread, drift, step, settings };
    }
    function reject(reason, step = null) { reset(); return result(false, reason, null, null, step); }
    function update(frame) {
      if (!frame || !finite(frame.timestamp) || frame.timestamp < 0) return reject('invalid_timestamp');
      if (lastTimestamp !== null && frame.timestamp <= lastTimestamp) return reject('nonmonotonic_timestamp');
      if (frame.valid !== true) return reject('invalid_frame');
      if (!Array.isArray(frame.features) || frame.features.length !== 4 || !frame.features.every(finite)) return reject('invalid_features');
      const longGap = lastTimestamp !== null && frame.timestamp - lastTimestamp > settings.maxGapMs;
      if (longGap) reset();
      const previous = frames[frames.length - 1];
      const step = previous ? frame.features.map((value, index) => Math.abs(value - previous.features[index])) : null;
      if (step && !step.every(finite)) return reject('nonfinite_stability_metric');
      if (step && step.some(value => value > settings.maxStep)) return reject('feature_jump', step);
      lastTimestamp = frame.timestamp;
      // Copy only timestamp/features. Target coordinates and predictions cannot
      // influence this gate, even if callers attach those fields to the frame.
      frames.push({ timestamp: frame.timestamp, features: frame.features.slice() });
      const cutoff = frame.timestamp - settings.windowMs;
      // Retain one anchor at/before the window boundary so a 33 ms cadence can
      // reach 600 ms rather than being perpetually clipped to a 594 ms span.
      while (frames.length > 1 && frames[1].timestamp <= cutoff) frames.shift();
      if (longGap) return result(false, 'long_gap', null, null, step);
      if (frames.length < settings.minFrames || frame.timestamp - frames[0].timestamp < settings.windowMs) return result(false, 'collecting_stable_window', null, null, step);
      const midpoint = (frames[0].timestamp + frame.timestamp) / 2;
      const before = frames.filter(sample => sample.timestamp <= midpoint), after = frames.filter(sample => sample.timestamp > midpoint);
      const spread = [0, 1, 2, 3].map(index => {
        const values = frames.map(sample => sample.features[index]);
        return quantile(values, .9) - quantile(values, .1);
      });
      const drift = [0, 1, 2, 3].map(index => Math.abs(quantile(after.map(sample => sample.features[index]), .5) - quantile(before.map(sample => sample.features[index]), .5)));
      if (!spread.every(finite) || !drift.every(finite)) return reject('nonfinite_stability_metric');
      if (spread.some(value => value > settings.maxSpread)) return result(false, 'feature_spread_exceeded', spread, drift, step);
      if (drift.some(value => value > settings.maxDrift)) return result(false, 'feature_drift_exceeded', spread, drift, step);
      return result(true, null, spread, drift, step);
    }
    return { update, reset, settings };
  }
  return { version, defaults, createGate,
    definitions: Object.freeze({ units: 'Eye-corner-width fractions from the original four eye-local features.',
      spread: 'Per feature, interpolated P90 minus P10 within the causal trailing window.',
      drift: 'Per feature, absolute difference between median values in the later and earlier temporal halves.',
      step: 'Per feature, absolute difference from the previous consecutive valid frame; a step above maxStep rejects the new frame and clears the window.',
      window: 'A trailing window retains one boundary anchor; evaluated duration is at least windowMs and less than windowMs + maxGapMs.',
      limitation: 'Engineering candidates, not established measurement-accuracy guarantees. Drift below these window thresholds can still accumulate across longer durations.' }) };
}));
