'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const GazeFilter = require('../shared/gaze-filter.js');
const frame = (timestamp, x = .5, y = .4) => ({ timestamp, x, y, valid: true });
const mse = values => values.reduce((sum, value) => sum + value * value, 0) / values.length;

test('initial observation, fixed points and state variance retain their documented meaning', () => {
  const filter = GazeFilter.createFilter();
  const first = filter.update(frame(0));
  assert.deepEqual(first, { x: .5, y: .4, timestamp: 0, valid: true, reason: 'initialized', reset: true, varianceX: .0016, varianceY: .0016 });
  let result;
  for (let i = 1; i <= 300; i++) result = filter.update(frame(i * 33));
  assert.equal(result.x, .5); assert.equal(result.y, .4); assert.equal(result.reset, false); assert.equal(result.reason, null);
  assert.ok(result.varianceX > 0 && result.varianceX < first.varianceX);
  assert.match(GazeFilter.definitions.variance, /not measured accuracy/);
});

test('stationary zero-mean measurement noise is reduced but a fixed location bias remains', () => {
  const filter = GazeFilter.createFilter(), noisyErrors = [], filteredErrors = [];
  for (let i = 0; i < 300; i++) {
    const noise = i % 2 === 0 ? .04 : -.04;
    const result = filter.update(frame(i * 33, .5 + noise, .4 - noise));
    if (i > 60) { noisyErrors.push(noise); filteredErrors.push(result.x - .5); }
  }
  assert.ok(mse(filteredErrors) < mse(noisyErrors) / 4);
  const biased = GazeFilter.createFilter();
  for (let i = 0; i < 300; i++) {
    const result = biased.update(frame(i * 33, .7, .6));
    assert.equal(result.x, .7); assert.equal(result.y, .6);
  }
});

test('actual irregular intervals are used, with independent axes and finite state through long runs', () => {
  const irregular = GazeFilter.createFilter(), uniform = GazeFilter.createFilter();
  irregular.update(frame(0, 0, .4)); uniform.update(frame(0, 0, .4));
  const short = irregular.update(frame(10, .1, .4)), long = uniform.update(frame(100, .1, .4));
  assert.ok(long.x > short.x);
  let time = 10, result;
  const intervals = [4, 16, 33, 67, 149, 25];
  for (let i = 0; i < 10000; i++) {
    time += intervals[i % intervals.length];
    result = irregular.update(frame(time, Math.sin(time / 5000), .4));
    assert.equal(result.valid, true); assert.equal(result.reset, false); assert.equal(result.y, .4);
    for (const key of ['x', 'y', 'varianceX', 'varianceY']) assert.ok(Number.isFinite(result[key]));
    assert.ok(result.varianceX >= 0 && result.varianceY >= 0);
  }
});

test('invalid quality, missing eyes and nonfinite input clear history without filling gaps', () => {
  for (const [bad, reason] of [
    [{ ...frame(33), valid: false }, 'invalid_frame'], [{ ...frame(33), valid: undefined }, 'invalid_frame'],
    [frame(33, NaN), 'invalid_coordinates'], [frame(33, 0, Infinity), 'invalid_coordinates'], [frame(33, null), 'invalid_coordinates'],
    [frame(NaN), 'invalid_timestamp'], [frame(Infinity), 'invalid_timestamp'], [frame(-1), 'invalid_timestamp'], [null, 'invalid_timestamp']
  ]) {
    const filter = GazeFilter.createFilter(); filter.update(frame(0));
    const rejected = filter.update(bad);
    assert.equal(rejected.valid, false); assert.equal(rejected.reason, reason); assert.equal(rejected.reset, true);
    assert.equal(rejected.x, null); assert.equal(rejected.y, null); assert.equal(rejected.varianceX, null);
    const fresh = filter.update(frame(66, .8, .9));
    assert.equal(fresh.reason, 'initialized'); assert.equal(fresh.x, .8); assert.equal(fresh.y, .9);
  }
});

test('long gaps, duplicate and reversed times restart at the current observation; reset clears both axes', () => {
  const filter = GazeFilter.createFilter(); filter.update(frame(100));
  assert.equal(filter.update(frame(250)).reset, false);
  const gap = filter.update(frame(401, -.2, 1.2));
  assert.equal(gap.reason, 'long_gap'); assert.equal(gap.reset, true); assert.equal(gap.x, -.2); assert.equal(gap.y, 1.2);
  for (const timestamp of [401, 400]) {
    const result = filter.update(frame(timestamp, .8, .1));
    assert.equal(result.reason, 'nonmonotonic_timestamp'); assert.equal(result.x, .8); assert.equal(result.y, .1);
  }
  filter.reset(); assert.equal(filter.update(frame(0, .2)).reason, 'initialized');
});

test('step response is causal and exposes lag, without clipping or target leakage', () => {
  const filter = GazeFilter.createFilter();
  const prior = [];
  for (let i = 0; i < 60; i++) prior.push(filter.update(frame(i * 33, .2, 1.2)));
  const saved = JSON.stringify(prior);
  const guarded = frame(60 * 33, .8, 1.2);
  for (const key of ['targetX', 'targetY', 'target', 'truth', 'prediction']) Object.defineProperty(guarded, key, { get() { throw Error('Target leakage'); } });
  const step = filter.update(guarded);
  assert.ok(step.x > .2 && step.x < .8); assert.equal(step.y, 1.2);
  let current;
  for (let i = 61; i <= 120; i++) current = filter.update(frame(i * 33, .8, 1.2));
  assert.ok(Math.abs(current.x - .8) < .005);
  assert.equal(JSON.stringify(prior), saved);
});

test('caller mutation and other filters cannot alter retained values or immutable settings', () => {
  const options = { measurementStd: .04 }, filter = GazeFilter.createFilter(options), reference = GazeFilter.createFilter();
  const firstInput = frame(0), firstOutput = filter.update(firstInput); reference.update(frame(0));
  options.measurementStd = 100; firstInput.x = 100; firstOutput.x = -100; firstOutput.varianceX = 100;
  const other = GazeFilter.createFilter(); other.update(frame(0, 100)); other.reset();
  assert.deepEqual(filter.update(frame(33, .6)), reference.update(frame(33, .6)));
  assert.equal(filter.settings.measurementStd, .04); assert.equal(Object.isFrozen(filter.settings), true);
  assert.equal(Object.isFrozen(GazeFilter.defaults), true);
});

test('invalid configuration is rejected; extreme finite observations never produce nonfinite outputs', () => {
  for (const options of [null, [], { measurementStd: 0 }, { measurementStd: 1e-300 }, { measurementStd: Infinity },
    { accelerationStd: -1 }, { accelerationStd: 1e300 }, { initialVelocityStd: NaN }, { maxGapMs: 0 }]) {
    assert.throws(() => GazeFilter.createFilter(options), RangeError);
  }
  const filter = GazeFilter.createFilter(); filter.update(frame(0, Number.MAX_VALUE));
  const result = filter.update(frame(33, -Number.MAX_VALUE));
  assert.equal(result.reason, 'numerical_reset'); assert.equal(result.x, -Number.MAX_VALUE); assert.equal(result.valid, true);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/gaze-filter.js'), 'utf8'), context);
  assert.equal(context.GazeFilter.version, GazeFilter.version);
  assert.equal(context.GazeFilter.createFilter().update(frame(0)).x, .5);
});
