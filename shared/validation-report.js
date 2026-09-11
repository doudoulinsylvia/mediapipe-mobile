/* Presentation only: never changes validation decisions, measurements or gates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ValidationReport = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = value => finite(value) ? String(value) : '未记录';
  const percent = value => finite(value) ? (value * 100).toFixed(1) + '%' : '未记录';
  const normalized = value => finite(value) ? value.toFixed(3) : '未记录';
  const milliseconds = value => finite(value) ? Math.round(value) + ' 毫秒' : '未记录';
  const codes = value => Array.isArray(value) ? [...new Set(value)] : [];
  // Text only. Keep a bounded diagnostic identifier without HTML/control characters.
  const identifier = value => typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 96) || '未记录' : '未记录';
  const metricDefinitions = {
    meanAbsErrorX: ['X 平均绝对误差', 'maxMeanAbsErrorX', percent, '屏宽'],
    meanAbsErrorY: ['Y 平均绝对误差', 'maxMeanAbsErrorY', percent, '屏高'],
    p95AbsErrorX: ['X 95%分位误差（P95）', 'maxP95AbsErrorX', percent, '屏宽'],
    p95AbsErrorY: ['Y 95%分位误差（P95）', 'maxP95AbsErrorY', percent, '屏高'],
    meanErrorNorm: ['二维平均归一化误差', 'maxMeanErrorNorm', normalized, ''],
    p95ErrorNorm: ['二维95%分位误差（P95）', 'maxP95ErrorNorm', normalized, '']
  };
  const pointMetricCodes = {
    point_x_mean_error: 'meanAbsErrorX', point_y_mean_error: 'meanAbsErrorY',
    point_x_p95_error: 'p95AbsErrorX', point_y_p95_error: 'p95AbsErrorY',
    point_mean_error: 'meanErrorNorm', point_p95_error: 'p95ErrorNorm'
  };

  function metricLine(metric, source, settings, perPoint, failed) {
    const [label, defaultGate, format, unit] = metricDefinitions[metric];
    const gate = perPoint && metric === 'meanErrorNorm' ? 'maxPointMeanErrorNorm'
      : perPoint && metric === 'p95ErrorNorm' ? 'maxPointP95ErrorNorm' : defaultGate;
    return `${label}：${unit ? unit + ' ' : ''}${format(source[metric])}；门槛 ≤ ${format(settings[gate])}${failed ? '（此项未通过）' : ''}。`;
  }

  function failureLine(code, source, settings, perPoint, evaluation) {
    const pointMetric = Object.prototype.hasOwnProperty.call(pointMetricCodes, code) ? pointMetricCodes[code] : null;
    const overallMetric = typeof code === 'string' && code.endsWith('_exceeded') ? code.slice(0, -9) : '';
    if (perPoint && pointMetric) return metricLine(pointMetric, source, settings, true, true);
    if (!perPoint && Object.prototype.hasOwnProperty.call(metricDefinitions, overallMetric)) {
      return metricLine(overallMetric, source, settings, false, true);
    }
    switch (code) {
      case 'missing_target': return `没有采集到这个验证点的记录（记录数：${number(source.attemptCount)}）。`;
      case 'insufficient_valid_samples': return `有效记录不足：${number(source.validCount)} 条；至少需要 ${number(settings.minSamplesPerPoint)} 条。`;
      case 'insufficient_coverage': return `有效采样比例不足${perPoint ? '' : '（按点平均）'}：${percent(source.coverage)}；门槛 ≥ ${percent(settings.minCoverage)}。`;
      case 'discontinuous_valid_samples': return `有效记录间隔过长：最长 ${milliseconds(source.maxGapMs)}；门槛 ≤ ${milliseconds(settings.maxSampleGapMs)}。`;
      case 'insufficient_duration': return `有效采样时段过短：${milliseconds(source.durationMs)}；门槛 ≥ ${milliseconds(settings.minDurationMs)}。`;
      case 'nonmonotonic_timestamps': return '有效记录时间重复或倒序，无法作为连续采样时序。';
      case 'missing_valid_timestamps': return '有效记录缺少可用时间戳，无法检查采样时长及间隔。';
      case 'invalid_attempt_timestamp': return '部分采样记录缺少有效时间戳。';
      case 'no_valid_samples': return `没有可用的有效记录（有效数：${number(source.validCount)}）。`;
      case 'invalid_validation_options': return '验证设置无效，需要检查诊断备份中的设置。';
      case 'invalid_validation_samples': return '验证记录格式无效。';
      case 'invalid_expected_target': return '预设验证点的坐标或编号无效。';
      case 'duplicate_expected_target': return '预设验证点编号重复。';
      case 'unexpected_target': return '部分记录属于预设范围以外的验证点。';
      case 'unassigned_or_invalid_target': return `部分记录无法归入有效验证点（未归入记录：${number(evaluation.unassignedAttempts)} 条）。`;
      case 'inconsistent_target_coordinates': return '同一验证点的目标坐标不一致。';
      case 'insufficient_validation_targets': return `验证点数量不足：${Array.isArray(evaluation.pointSummaries) ? evaluation.pointSummaries.length : '未记录'} 个；至少需要 ${number(settings.minTargetCount)} 个。`;
      case 'insufficient_validation_target_span': return `验证点覆盖的屏幕范围不足；X 范围需 ≥ 屏宽 ${percent(settings.minTargetSpanX)}，Y 范围需 ≥ 屏高 ${percent(settings.minTargetSpanY)}。`;
      case 'degenerate_validation_target_layout': return '验证点布局不足以独立检验二维位置；请保留诊断备份检查坐标分布。';
      default: return `有未识别的检查项未通过（诊断代码：${identifier(code)}），请保留诊断备份。`;
    }
  }

  function positionLabel(point) {
    const id = identifier(point.targetId);
    if (!finite(point.targetX) || !finite(point.targetY)) return `验证点 ${id}（位置未记录）`;
    const column = point.targetX < 1 / 3 ? '左' : point.targetX > 2 / 3 ? '右' : '中';
    const row = point.targetY < 1 / 3 ? '上' : point.targetY > 2 / 3 ? '下' : '中';
    const position = column === '中' && row === '中' ? '中心' : column + row;
    return `${position}（${id}）`;
  }

  function biasLine(point) {
    function axis(value, negative, positive, unit) {
      if (!finite(value)) return '未记录';
      if (value === 0) return '平均偏差为 0';
      return `${value < 0 ? negative : positive}偏${unit} ${percent(Math.abs(value))}`;
    }
    return `平均有向偏差：X ${axis(point.biasX, '左', '右', '屏宽')}；Y ${axis(point.biasY, '上', '下', '屏高')}。相反方向的误差可能抵消，不能替代绝对误差。`;
  }

  function summarizeValidation(input) {
    const evaluation = object(input);
    const settings = object(object(evaluation.diagnostics).settings);
    const rawPoints = Array.isArray(evaluation.pointSummaries) ? evaluation.pointSummaries : [];
    const overallFailures = codes(evaluation.failures);
    const points = rawPoints.map(raw => {
      const point = object(raw), failures = codes(point.failures);
      const details = failures.map(code => failureLine(code, point, settings, true, evaluation));
      if (point.passed === false && !failures.length) details.push('此点未通过，但具体失败项目未记录；请保留诊断备份。');
      if (point.passed !== true && point.passed !== false) details.push('此点的通过状态未记录，不能据此判定达标。');
      if (point.passed === true && failures.length) details.push('记录中的通过状态与失败项目不一致，请保留诊断备份检查。');
      details.push(biasLine(point));
      const status = point.passed === true ? '通过' : point.passed === false ? '未通过' : '状态未记录';
      return {
        targetId: point.targetId == null ? null : point.targetId,
        label: positionLabel(point), passed: point.passed === true ? true : point.passed === false ? false : null,
        summary: `${status}；有效记录 ${number(point.validCount)}/${number(point.attemptCount)} 条；有效采样比例 ${percent(point.coverage)}。`,
        details
      };
    });
    const passedCount = points.filter(point => point.passed === true).length;
    const status = evaluation.passed === true ? '独立验证通过' : evaluation.passed === false ? '独立验证未通过' : '独立验证结果未记录';
    const lines = [rawPoints.length ? `逐点通过：${passedCount}/${rawPoints.length} 个点。各点均须达标。` : '逐点结果未记录，无法确认各点是否达标。'];
    function compactMetric(metric, label) {
      const [, gate, format] = metricDefinitions[metric];
      const failed = overallFailures.includes(metric + '_exceeded');
      return `${label} ${format(evaluation[metric])}（${failed ? '未通过；' : ''}门槛 ≤ ${format(settings[gate])}）`;
    }
    lines.push(`X 误差（屏宽）：${compactMetric('meanAbsErrorX', '平均绝对误差')}；${compactMetric('p95AbsErrorX', 'P95')}。`);
    lines.push(`Y 误差（屏高）：${compactMetric('meanAbsErrorY', '平均绝对误差')}；${compactMetric('p95AbsErrorY', 'P95')}。`);
    lines.push(`二维归一化误差：${compactMetric('meanErrorNorm', '平均')}；${compactMetric('p95ErrorNorm', 'P95')}。`);
    lines.push(`有效采样比例（按点平均）：${percent(evaluation.coverage)}；门槛 ≥ ${percent(settings.minCoverage)}。有效记录合计 ${number(evaluation.validCount)}/${number(evaluation.attemptCount)} 条。有效比例不是准确率。`);
    lines.push('P95 为误差的95%分位数；二维误差按屏宽、屏高归一化，不是视角度数。');
    for (const code of overallFailures) {
      if (typeof code === 'string' && code.startsWith('target_failed:')) {
        const id = code.slice('target_failed:'.length);
        const matching = points.filter(point => String(point.targetId) === id);
        if (!matching.length) lines.push(`验证点 ${identifier(id)} 未通过，但逐点详情缺失；请保留诊断备份。`);
        else if (matching.some(point => point.passed !== false)) lines.push(`验证点 ${identifier(id)} 的总体与逐点状态不一致；请保留诊断备份。`);
      } else if (!(typeof code === 'string' && code.endsWith('_exceeded') && Object.prototype.hasOwnProperty.call(metricDefinitions, code.slice(0, -9)))) {
        lines.push(failureLine(code, evaluation, settings, false, evaluation));
      }
    }
    return { headline: status, lines, points };
  }

  return { summarizeValidation };
}));
