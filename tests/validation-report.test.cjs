'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GazeCore = require('../shared/gaze-core.js');
const { summarizeValidation } = require('../shared/validation-report.js');

const settings = { maxMeanAbsErrorX: .1, maxMeanAbsErrorY: .1, maxP95AbsErrorX: .2, maxP95AbsErrorY: .2,
  maxMeanErrorNorm: .12, maxP95ErrorNorm: .25, maxPointMeanErrorNorm: .18, maxPointP95ErrorNorm: .3,
  minCoverage: .8, minSamplesPerPoint: 12, maxSampleGapMs: 500, minDurationMs: 200 };
function base(overrides = {}) {
  return { passed: false, failures: [], meanAbsErrorX: .04, meanAbsErrorY: .07,
    p95AbsErrorX: .1, p95AbsErrorY: .18, meanErrorNorm: .1, p95ErrorNorm: .2,
    coverage: .995, validCount: 199, attemptCount: 200, diagnostics: { settings }, pointSummaries: [], ...overrides };
}
function point(overrides = {}) {
  return { targetId: 'v5', targetX: .52, targetY: .52, passed: false, failures: ['point_y_mean_error'],
    meanAbsErrorY: .181, p95AbsErrorY: .42, biasX: .02, biasY: -.181,
    validCount: 20, attemptCount: 20, coverage: 1, ...overrides };
}

test('small overall means still expose each failed target and measured directional bias', () => {
  const input = base({ failures: ['target_failed:v5'], pointSummaries: [point(), point({ targetId: 'v1', passed: true, failures: [] })] });
  const before = JSON.stringify(input);
  const report = summarizeValidation(input);
  assert.equal(report.headline, '独立验证未通过');
  assert.match(report.lines[0], /1\/2/);
  assert.equal(report.lines.length, 6);
  assert.ok(report.lines.some(line => /X 误差（屏宽）：平均绝对误差 4.0%（门槛 ≤ 10.0%）；P95 10.0%（门槛 ≤ 20.0%）/.test(line)));
  assert.match(report.points[0].details[0], /屏高 18.1%；门槛 ≤ 10.0%（此项未通过）/);
  assert.match(report.points[0].details.at(-1), /右偏屏宽 2.0%；Y 上偏屏高 18.1%/);
  assert.equal(report.points[0].label, '中心（v5）');
  assert.equal(report.points[0].passed, false);
  assert.equal(JSON.stringify(input), before);
});

test('tail errors use actual per-point P95 gates and never hide behind mean errors', () => {
  const report = summarizeValidation(base({ failures: ['meanAbsErrorX_exceeded', 'p95AbsErrorX_exceeded', 'meanAbsErrorY_exceeded',
    'p95AbsErrorY_exceeded', 'meanErrorNorm_exceeded', 'p95ErrorNorm_exceeded'], meanAbsErrorX: .122, p95AbsErrorX: .28,
    meanAbsErrorY: .181, p95AbsErrorY: .31, meanErrorNorm: .235, p95ErrorNorm: .471,
    pointSummaries: [point({ failures: ['point_y_p95_error', 'point_p95_error'], p95ErrorNorm: .471 })] }));
  assert.equal(report.lines.length, 6);
  assert.match(report.lines[1], /平均绝对误差 12.2%（未通过；门槛 ≤ 10.0%）；P95 28.0%（未通过；门槛 ≤ 20.0%）/);
  assert.match(report.lines[2], /Y 误差（屏高）：平均绝对误差 18.1%（未通过；门槛 ≤ 10.0%）；P95 31.0%（未通过；门槛 ≤ 20.0%）/);
  assert.match(report.lines[3], /平均 0.235（未通过；门槛 ≤ 0.120）；P95 0.471（未通过；门槛 ≤ 0.250）/);
  assert.match(report.points[0].details[0], /屏高 42.0%；门槛 ≤ 20.0%/);
  assert.match(report.points[0].details[1], /0.471；门槛 ≤ 0.300/);
});

test('missing values and unknown codes remain diagnostic without fabricated zeros', () => {
  const report = summarizeValidation({ passed: false, failures: ['target_failed:v9', 'future_gate'],
    pointSummaries: [{ targetId: 'v1', passed: false, meanAbsErrorX: null, biasX: NaN,
      failures: ['point_x_mean_error', 'future_point<script>', 'missing_valid_timestamps', '__proto__'] }] });
  assert.match(report.points[0].details[0], /屏宽 未记录；门槛 ≤ 未记录/);
  assert.match(report.points[0].details[1], /未识别.*future_pointscript/);
  assert.match(report.points[0].details[2], /缺少可用时间戳/);
  assert.match(report.points[0].details[3], /未识别.*__proto__/);
  assert.ok(report.lines.some(line => /v9.*逐点详情缺失/.test(line)));
  assert.ok(report.lines.some(line => /future_gate/.test(line)));
  assert.doesNotMatch(JSON.stringify(report), /0\.0%|NaN|undefined|<script>/);
  assert.equal(summarizeValidation(null).headline, '独立验证结果未记录');
  assert.equal(summarizeValidation({ pointSummaries: [{}] }).points[0].passed, null);
});

test('coverage, gaps, duration and missing samples each show the recorded values and gates', () => {
  const report = summarizeValidation(base({ pointSummaries: [point({ failures: ['missing_target', 'insufficient_valid_samples',
    'insufficient_coverage', 'discontinuous_valid_samples', 'insufficient_duration', 'invalid_attempt_timestamp'],
    attemptCount: 0, validCount: 0, coverage: 0, maxGapMs: 750, durationMs: 120 })] }));
  const details = report.points[0].details.join('\n');
  assert.match(details, /记录数：0/);
  assert.match(details, /0 条；至少需要 12 条/);
  assert.match(details, /0.0%；门槛 ≥ 80.0%/);
  assert.match(details, /750 毫秒；门槛 ≤ 500 毫秒/);
  assert.match(details, /120 毫秒；门槛 ≥ 200 毫秒/);
  assert.ok(report.lines.some(line => /按点平均.*99.5%.*不是准确率/.test(line)));
});

test('the formatter preserves a recorded decision and flags inconsistent records', () => {
  const report = summarizeValidation(base({ passed: true, pointSummaries: [point({ passed: true })], failures: ['target_failed:v5'] }));
  assert.equal(report.headline, '独立验证通过');
  assert.equal(report.points[0].passed, true);
  assert.ok(report.points[0].details.some(line => /状态与失败项目不一致/.test(line)));
  assert.ok(report.lines.some(line => /总体与逐点状态不一致/.test(line)));
});

test('an actual GazeCore report uses its returned settings and distinguishes pooled counts', () => {
  const targets = [0.1, .5, .9].flatMap((x, i) => [0.1, .5, .9].map((y, j) => ({ targetId: `v${i * 3 + j + 1}`, targetX: x, targetY: y })));
  const samples = targets.flatMap((target, index) => Array.from({ length: index ? 16 : 8 }, (_, i) => ({ ...target,
    valid: index > 0, x: target.targetX, y: target.targetY, timestamp: index * 2000 + i * 40 })));
  const evaluation = GazeCore.evaluateValidation(samples, { expectedTargets: targets, minCoverage: .85 });
  const report = summarizeValidation(evaluation);
  assert.equal(report.points.filter(point => point.passed).length, 8);
  assert.ok(report.lines.some(line => /按点平均.*88.9%；门槛 ≥ 85.0%/.test(line)));
  assert.ok(report.lines.some(line => /128\/136/.test(line)));
  assert.ok(report.points[0].details.some(line => /0.0%；门槛 ≥ 85.0%/.test(line)));
  assert.ok(report.points[0].details.some(line => /X 未记录；Y 未记录/.test(line)));
});

test('UMD exposes the same browser API without a DOM', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/validation-report.js'), 'utf8'), context);
  assert.equal(typeof context.ValidationReport.summarizeValidation, 'function');
  assert.equal(context.ValidationReport.summarizeValidation({ passed: false }).headline, '独立验证未通过');
});
