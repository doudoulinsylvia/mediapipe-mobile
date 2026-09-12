'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GazeCore = require('../shared/gaze-core.js');
const { summarizeCalibration } = require('../shared/calibration-report.js');

const metrics = { meanAbsErrorX: .02, meanAbsErrorY: .03, p95AbsErrorX: .07, p95AbsErrorY: .08,
  meanErrorNorm: .04, p95ErrorNorm: .11, biasX: .012, biasY: -.025 };
function candidate(id, score) {
  return { id, ok: true, score, folds: [{ trainRoundIndex: 1, testRoundIndex: 2, ok: true, score: score + .01, metrics },
    { trainRoundIndex: 2, testRoundIndex: 1, ok: true, score: score - .01, metrics }],
    perTarget: [{ targetId: 'c5', metrics: { ...metrics, meanErrorNorm: .18, p95ErrorNorm: .41 } }] };
}
function input() {
  return { ok: true, reason: null, diagnostics: { protocol: 'two_round_cross_validation_v1', expectedRoundCount: 2,
    expectedTargetCount: 9, roundSummaries: [1, 2].map(roundIndex => ({ roundIndex, targetCount: 9, presentationCount: 9,
      validCount: 180, attemptCount: 185 })), candidates: [candidate('four_eye_affine', .12), candidate('binocular_mean_affine', .10)],
    selectedCandidateId: 'binocular_mean_affine', selectionRule: '选择整轮交叉检验误差较小的候选', trainingMetrics: metrics,
    perTargetFit: [{ targetId: 'c5', targetX: .5, targetY: .5, validCount: 40, attemptCount: 42, metrics,
      sdX: .015, sdY: .02, radialRmsAroundMean: .025, roundMeans: [1, 2].map(roundIndex => ({ roundIndex,
        presentationId: `r${roundIndex}-c5`, validCount: 20, attemptCount: 21, x: .5, y: .48 })),
      roundMeanDelta: { x: -.04, y: .05, features: [.001, -.002, .003, -.004] } }] } };
}

test('complete repeated calibration reports selection and diagnostics without an accuracy pass label', () => {
  const fit = input(), before = JSON.stringify(fit);
  const report = summarizeCalibration(fit);
  assert.equal(report.headline, '校准诊断：拟合已生成');
  assert.match(report.lines[0], /两轮九点采集已完成.*第 1 轮 9 点.*第 2 轮 9 点/);
  assert.match(report.lines[1], /双眼四特征.*0.120.*1→2轮 0.130.*2→1轮 0.110/);
  assert.match(report.lines[2], /双眼均值.*0.100/);
  assert.match(report.lines[3], /所选候选：双眼均值/);
  assert.match(report.lines[5], /不是独立精度验证.*不代表精度合格/);
  assert.equal(report.lines.length, 7);
  assert.equal('passed' in report.points[0], false);
  assert.equal(JSON.stringify(fit), before);
});

test('reported selection is not recomputed from smaller candidate scores', () => {
  const fit = input();
  fit.diagnostics.selectedCandidateId = 'four_eye_affine';
  const report = summarizeCalibration(fit);
  assert.match(report.lines[3], /所选候选：双眼四特征/);
});

test('training residuals, cross-round errors and within-point spread retain distinct values', () => {
  const report = summarizeCalibration(input());
  assert.match(report.lines[4], /训练残差.*二维平均 0.040、P95 0.110/);
  const details = report.points[0].details.join('\n');
  assert.match(details, /拟合残差 X（屏宽）：平均绝对误差 2.0%；P95 7.0%/);
  assert.match(details, /拟合残差 Y（屏高）：平均绝对误差 3.0%；P95 8.0%/);
  assert.match(details, /X 标准差 1.5% 屏宽；Y 标准差 2.0% 屏高/);
  assert.match(details, /整轮交叉检验.*二维平均 0.180、P95 0.410/);
});

test('bias and second-minus-first differences use different directional explanations', () => {
  const report = summarizeCalibration(input());
  const details = report.points[0].details.join('\n');
  assert.match(details, /相对目标的平均偏差：X 右偏屏宽 1.2%；Y 上偏屏高 2.5%/);
  assert.match(details, /第2轮－第1轮.*X 向左屏宽 4.0%；Y 向下屏高 5.0%/);
  assert.match(details, /左眼 X \+0.0010、Y -0.0020；右眼 X \+0.0030、Y -0.0040/);
  assert.match(details, /不是屏幕位置误差/);
  assert.equal(report.points[0].label, '中心（c5）');
});

test('missing numbers remain unrecorded and do not manufacture a completed protocol', () => {
  const report = summarizeCalibration({ diagnostics: { perTargetFit: [{ targetId: 'c1', metrics: { meanAbsErrorX: null }, sdX: NaN }] } });
  assert.equal(report.headline, '校准诊断：拟合状态未记录');
  assert.match(report.lines[0], /逐轮记录未记录/);
  assert.match(report.points[0].details[0], /平均绝对误差 未记录；P95 未记录/);
  assert.doesNotMatch(JSON.stringify(report), /0\.000|0\.0%|NaN|undefined|已完成/);
  assert.equal(summarizeCalibration(null).points.length, 0);
  const incomplete = input();
  incomplete.diagnostics.roundSummaries[1].targetCount = 8;
  assert.doesNotMatch(summarizeCalibration(incomplete).lines[0], /采集已完成/);
});

test('failed candidates and folds preserve safe unknown diagnostic codes', () => {
  const fit = input();
  fit.ok = false; fit.reason = 'future_failure<script>';
  fit.diagnostics.selectedCandidateId = null;
  fit.diagnostics.candidates = [{ id: '__proto__', label: '<new>', ok: false, reason: '__proto__', score: null,
    folds: [{ trainRoundIndex: 1, testRoundIndex: 2, ok: false, reason: 'missing_calibration_target' }] }];
  fit.diagnostics.perTargetFit[0].failures = ['future_point'];
  fit.diagnostics.integrityFailures = ['incomplete_calibration_round', 'future_integrity'];
  const report = summarizeCalibration(fit), rendered = JSON.stringify(report);
  assert.equal(report.headline, '校准诊断：拟合暂未生成');
  assert.match(rendered, /future_failurescript/);
  assert.match(rendered, /诊断原因：__proto__/);
  assert.match(rendered, /缺少校准目标（missing_calibration_target）/);
  assert.match(rendered, /future_point/);
  assert.match(rendered, /目标记录不完整（incomplete_calibration_round）/);
  assert.match(rendered, /future_integrity/);
  assert.doesNotMatch(rendered, /<script>|<new>/);
});

test('real repeated-calibration output follows the complete formatter contract', () => {
  const targets = [.08, .5, .92].flatMap((y, row) => [.08, .5, .92].map((x, column) =>
    ({ targetId: `c${row * 3 + column + 1}`, targetX: x, targetY: y })));
  const samples = [1, 2].flatMap(roundIndex => targets.flatMap(target => Array.from({ length: 16 }, (_, index) => {
    const x = target.targetX - .5, y = target.targetY - .5, jitter = index % 2 ? .001 : -.001;
    return { ...target, roundIndex, presentationId: `r${roundIndex}-${target.targetId}`, valid: true,
      features: [.1 * x + .02 * y + jitter, -.01 * x + .12 * y, .11 * x - .02 * y, .005 * x + .13 * y - jitter] };
  })));
  const fit = GazeCore.createRepeatedCalibration(samples, { expectedTargets: targets });
  assert.equal(fit.ok, true, fit.reason);
  const report = summarizeCalibration(fit);
  assert.equal(report.points.length, 9);
  assert.match(report.lines[0], /两轮九点采集已完成/);
  assert.match(report.lines[3], /所选候选：双眼/);
  assert.doesNotMatch(report.lines.join('\n'), /未记录/);
  assert.doesNotMatch(report.points.flatMap(point => point.details).join('\n'), /未记录/);
  assert.ok(report.points.every(point => !('passed' in point)));
});

test('UMD exports the calibration formatter in the browser without a DOM', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/calibration-report.js'), 'utf8'), context);
  assert.equal(typeof context.CalibrationReport.summarizeCalibration, 'function');
  assert.equal(context.CalibrationReport.summarizeCalibration({ ok: true }).headline, '校准诊断：拟合已生成');
});
