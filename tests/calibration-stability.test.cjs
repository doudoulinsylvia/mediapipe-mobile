'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Stability = require('../shared/calibration-stability.js');
const frame = (timestamp, features = [.01, -.02, .015, -.025]) => ({ timestamp, valid: true, features });
function fill(gate, start = 0, end = 660, interval = 33, features) {
  let result;
  for (let timestamp = start; timestamp <= end; timestamp += interval) result = gate.update(frame(timestamp, features ? features(timestamp) : undefined));
  return result;
}

test('a causal 600 ms window reaches readiness at a 33 ms cadence and remains bounded by its anchor', () => {
  const gate = Stability.createGate();
  assert.equal(fill(gate, 0, 594).stable, false);
  const ready = gate.update(frame(627));
  assert.equal(ready.stable, true); assert.equal(ready.frameCount, 20); assert.equal(ready.durationMs, 627);
  assert.deepEqual(ready.spread, [0, 0, 0, 0]); assert.deepEqual(ready.drift, [0, 0, 0, 0]);
  for (let timestamp = 660; timestamp < 12000; timestamp += 33) {
    const current = gate.update(frame(timestamp));
    assert.equal(current.stable, true); assert.ok(current.frameCount <= 20);
    assert.ok(current.durationMs >= 600 && current.durationMs < 750);
  }
  assert.equal(ready.settings, gate.settings); assert.equal(Object.isFrozen(gate.settings), true);
  assert.deepEqual(gate.settings, { windowMs: 600, minFrames: 12, maxGapMs: 150, maxSpread: .06, maxDrift: .025, maxStep: .08 });
});

test('duration and minimum frame count must both be satisfied', () => {
  const sparse = Stability.createGate();
  assert.equal(fill(sparse, 0, 600, 100).frameCount, 7);
  assert.equal(sparse.update(frame(700)).stable, false);
  const fast = Stability.createGate();
  assert.equal(fill(fast, 0, 220, 20).frameCount, 12);
  assert.equal(fast.update(frame(240)).stable, false);
});

test('slow drift is rejected and the 1400 ms collection window catches cumulative drift missed by 600 ms', () => {
  const slope = timestamp => [timestamp * .00004, 0, timestamp * .00004, 0];
  const short = fill(Stability.createGate(), 0, 1400, 50, slope);
  const long = fill(Stability.createGate({ windowMs: 1400 }), 0, 1400, 50, slope);
  assert.equal(short.stable, true);
  assert.equal(long.stable, false); assert.equal(long.reason, 'feature_drift_exceeded');
  assert.ok(long.spread[0] < .06 && long.drift[0] > .025);
  const quicker = fill(Stability.createGate(), 0, 600, 50, timestamp => [0, timestamp * .0001, 0, 0]);
  assert.equal(quicker.reason, 'feature_drift_exceeded');
});

test('feature range and an isolated step are independently rejected without reading future frames', () => {
  const spread = fill(Stability.createGate(), 0, 600, 50, timestamp => [timestamp % 100 ? .039 : -.039, 0, 0, 0]);
  assert.equal(spread.reason, 'feature_spread_exceeded'); assert.ok(spread.step[0] < .08);
  const gate = Stability.createGate(); fill(gate);
  const jump = gate.update(frame(693, [.0911, -.02, .015, -.025]));
  assert.equal(jump.stable, false); assert.equal(jump.reason, 'feature_jump');
  assert.ok(jump.step[0] > .08); assert.equal(jump.frameCount, 0); assert.equal(jump.durationMs, 0);
  assert.equal(gate.update(frame(726)).stable, false);
  assert.equal(fill(gate, 759, 1386).stable, true);
});

test('invalid quality, nonfinite features, bad times and reverse times clear history', () => {
  for (const [bad, reason] of [
    [{ ...frame(693), valid: false }, 'invalid_frame'],
    [frame(693, [0, NaN, 0, 0]), 'invalid_features'],
    [frame(693, [0, Infinity, 0, 0]), 'invalid_features'],
    [frame(693, [0, 0]), 'invalid_features'],
    [frame(NaN), 'invalid_timestamp'], [frame(-1), 'invalid_timestamp'],
    [frame(660), 'nonmonotonic_timestamp'], [frame(659), 'nonmonotonic_timestamp']
  ]) {
    const gate = Stability.createGate(); assert.equal(fill(gate).stable, true);
    const result = gate.update(bad);
    assert.equal(result.stable, false); assert.equal(result.reason, reason); assert.equal(result.frameCount, 0);
    assert.equal(gate.update(frame(800)).frameCount, 1);
  }
});

test('gaps over 150 ms restart the window and explicit reset starts a new clock', () => {
  const gate = Stability.createGate(); fill(gate);
  assert.notEqual(gate.update(frame(810)).reason, 'long_gap');
  const gap = gate.update(frame(961));
  assert.equal(gap.stable, false); assert.equal(gap.reason, 'long_gap'); assert.equal(gap.frameCount, 1);
  assert.equal(fill(gate, 994, 1588).stable, true);
  gate.reset(); const fresh = gate.update(frame(0));
  assert.equal(fresh.frameCount, 1); assert.equal(fresh.step, null); assert.equal(fresh.stable, false);
});

test('target and prediction fields are not accessed and callers cannot mutate retained feature history', () => {
  const gate = Stability.createGate();
  const guarded = frame(0);
  for (const key of ['targetX', 'targetY', 'prediction', 'gazeX', 'gazeY']) Object.defineProperty(guarded, key, { get() { throw Error('Target leakage'); } });
  gate.update(guarded); guarded.features[0] = 100;
  const result = fill(gate, 33, 660);
  assert.equal(result.stable, true); assert.equal(result.spread[0], 0);
});

test('invalid settings are rejected and browser UMD exports the same pure API', () => {
  for (const options of [null, { windowMs: 0 }, { minFrames: 1 }, { minFrames: 1.5 },
    { maxGapMs: Infinity }, { maxSpread: -1 }, { maxDrift: NaN }, { maxStep: -1 }]) {
    assert.throws(() => Stability.createGate(options), RangeError);
  }
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/calibration-stability.js'), 'utf8'), context);
  assert.equal(context.CalibrationStability.version, Stability.version);
  assert.equal(typeof context.CalibrationStability.createGate, 'function');
  assert.equal(context.CalibrationStability.createGate().settings.windowMs, 600);
});
