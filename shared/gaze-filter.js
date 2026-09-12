/* Causal comparison filter; no target coordinates, fitting, DOM or missing-frame prediction. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GazeFilter = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const version = '2.3.0';
  const defaults = Object.freeze({ measurementStd: .04, accelerationStd: 1.5, initialVelocityStd: .5, maxGapMs: 150 });
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function createFilter(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new RangeError('Invalid gaze filter options');
    // Pick known fields: an attached target or other caller data is never read.
    const settings = Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, options[key] === undefined ? value : options[key]])));
    if (!finite(settings.measurementStd) || settings.measurementStd <= 0 ||
        !finite(settings.accelerationStd) || settings.accelerationStd < 0 ||
        !finite(settings.initialVelocityStd) || settings.initialVelocityStd < 0 ||
        !finite(settings.maxGapMs) || settings.maxGapMs <= 0) throw new RangeError('Invalid gaze filter options');
    const measurementVariance = settings.measurementStd ** 2;
    const accelerationVariance = settings.accelerationStd ** 2;
    const velocityVariance = settings.initialVelocityStd ** 2;
    if (![measurementVariance, accelerationVariance, velocityVariance].every(finite) || measurementVariance <= 0) throw new RangeError('Invalid gaze filter variances');
    let xState = null, yState = null, lastTimestamp = null;

    function reset() { xState = null; yState = null; lastTimestamp = null; }
    function result(timestamp, valid, reason, wasReset) {
      return { x: valid ? xState.position : null, y: valid ? yState.position : null,
        timestamp: finite(timestamp) && timestamp >= 0 ? timestamp : null,
        valid, reason, reset: wasReset,
        varianceX: valid ? xState.p00 : null, varianceY: valid ? yState.p00 : null };
    }
    function reject(timestamp, reason) { reset(); return result(timestamp, false, reason, true); }
    function initialAxis(position) { return { position, velocity: 0, p00: measurementVariance, p01: 0, p11: velocityVariance }; }
    function initialize(frame, reason) {
      xState = initialAxis(frame.x); yState = initialAxis(frame.y); lastTimestamp = frame.timestamp;
      return result(frame.timestamp, true, reason, true);
    }
    function updateAxis(state, observation, dt) {
      // F = [[1, dt], [0, 1]]. Discrete acceleration over this actual interval:
      // Q = accelerationVariance * [[dt^4/4, dt^3/2], [dt^3/2, dt^2]].
      const dt2 = dt * dt, q = accelerationVariance;
      const a = state.p00 + 2 * dt * state.p01 + dt2 * state.p11 + q * dt2 * dt2 / 4;
      const b = state.p01 + dt * state.p11 + q * dt2 * dt / 2;
      const c = state.p11 + q * dt2;
      const innovationVariance = a + measurementVariance;
      const k0 = a / innovationVariance, k1 = b / innovationVariance, residualScale = 1 - k0;
      const predictedPosition = state.position + dt * state.velocity;
      const innovation = observation - predictedPosition;
      // Joseph covariance update: (I-KH) P (I-KH)' + K R K'.
      const next = {
        position: predictedPosition + k0 * innovation,
        velocity: state.velocity + k1 * innovation,
        p00: residualScale * residualScale * a + k0 * k0 * measurementVariance,
        p01: residualScale * (b - k1 * a) + k0 * k1 * measurementVariance,
        p11: c - 2 * k1 * b + k1 * k1 * (a + measurementVariance)
      };
      if (!Object.values(next).every(finite) || next.p00 < 0 || next.p11 < 0) return null;
      return next;
    }
    function update(frame) {
      if (!frame || !finite(frame.timestamp) || frame.timestamp < 0) return reject(frame && frame.timestamp, 'invalid_timestamp');
      if (frame.valid !== true) return reject(frame.timestamp, 'invalid_frame');
      if (!finite(frame.x) || !finite(frame.y)) return reject(frame.timestamp, 'invalid_coordinates');
      if (lastTimestamp === null) return initialize(frame, 'initialized');
      const gapMs = frame.timestamp - lastTimestamp;
      if (gapMs <= 0) return initialize(frame, 'nonmonotonic_timestamp');
      if (gapMs > settings.maxGapMs) return initialize(frame, 'long_gap');
      const nextX = updateAxis(xState, frame.x, gapMs / 1000);
      const nextY = updateAxis(yState, frame.y, gapMs / 1000);
      // Extreme finite inputs can overflow floating-point arithmetic. Recover
      // from the current observation, never emit a nonfinite extrapolation.
      if (!nextX || !nextY) return initialize(frame, 'numerical_reset');
      xState = nextX; yState = nextY; lastTimestamp = frame.timestamp;
      return result(frame.timestamp, true, null, false);
    }
    return { update, reset, settings };
  }
  return { version, defaults, createFilter,
    definitions: Object.freeze({
      units: 'x and y are independently normalized by viewport width and height. Timestamps are milliseconds; velocity is normalized units/second.',
      process: 'Two independent constant-velocity Kalman axes with discrete white acceleration and the actual interval between observed frames.',
      missing: 'Invalid frames clear both axes. No extrapolated samples are emitted for missing observations.',
      variance: 'varianceX/Y are conditional filter state variances under fixed noise assumptions, not measured accuracy or empirical confidence intervals.',
      limitation: 'Engineering comparison defaults, not optimized against validation targets. Smoothing can introduce lag and cannot identify a stable calibration bias.'
    }) };
}));
