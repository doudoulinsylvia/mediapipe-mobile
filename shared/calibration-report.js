/* Pure text presentation of calibration diagnostics; no fitting or pass decisions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalibrationReport = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = value => Array.isArray(value) ? value : [];
  const number = value => finite(value) ? String(value) : '未记录';
  const percent = value => finite(value) ? (value * 100).toFixed(1) + '%' : '未记录';
  const norm = value => finite(value) ? value.toFixed(3) : '未记录';
  const comparisonScore = value => finite(value) ? value.toFixed(6) : '未记录';
  const signedFeature = value => finite(value) ? (value > 0 ? '+' : '') + value.toFixed(4) : '未记录';
  const text = value => typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, 240) || '未记录' : '未记录';
  const candidateLabels = { four_eye_affine: '双眼四特征', binocular_mean_affine: '双眼均值' };
  const reasonLabels = {
    no_calibration_samples: '没有校准记录', invalid_calibration_options: '校准设置无效',
    no_eligible_calibration_candidate: '所有候选均无法生成可用模型',
    inconsistent_calibration_target: '同一目标坐标不一致', missing_calibration_target: '缺少校准目标',
    insufficient_calibration_targets: '校准目标数量不足', insufficient_samples_per_target: '部分目标的有效样本不足',
    insufficient_target_span: '目标覆盖范围不足', degenerate_target_layout: '目标布局不足以拟合二维位置',
    insufficient_eye_feature_span: '眼部特征变化范围不足', degenerate_two_dimensional_features: '两个方向的特征难以区分',
    degenerate_feature_variance: '可用特征的变化不足', unstable_calibration_matrix: '拟合计算不稳定',
    invalid_model: '模型记录无效', invalid_features: '特征记录无效', nonfinite_prediction: '预测数值无效',
    invalid_repeated_calibration_options: '两轮校准设置无效', invalid_expected_calibration_targets: '预设校准目标无效',
    expected_nine_calibration_targets: '预设校准目标必须为九点', unexpected_calibration_round: '记录的校准轮次无效',
    unexpected_calibration_target: '记录不属于预设校准目标', missing_presentation_id: '缺少呈现编号',
    presentation_id_reused: '呈现编号被用于不同轮次或目标', duplicate_target_presentation: '同轮同点出现多个呈现编号',
    incomplete_calibration_round: '校准轮次的目标记录不完整', insufficient_samples_per_presentation: '某次目标呈现的有效样本不足',
    nonfinite_cross_round_prediction: '整轮交叉检验产生无效预测数值', cross_round_fit_failed: '整轮交叉检验未完成',
    nonfinite_final_prediction: '最终拟合产生无效预测数值', not_evaluated: '尚未评估'
  };
  function reason(code) {
    if (typeof code === 'string' && code.startsWith('final_fit_failed:')) {
      const nested = code.slice('final_fit_failed:'.length);
      return `最终拟合失败：${Object.prototype.hasOwnProperty.call(reasonLabels, nested) ? reasonLabels[nested] : '原因未识别'}（${text(code)}）`;
    }
    return Object.prototype.hasOwnProperty.call(reasonLabels, code)
      ? `${reasonLabels[code]}（${text(code)}）` : `诊断原因：${text(code)}`;
  }
  function candidateLabel(candidate) {
    return Object.prototype.hasOwnProperty.call(candidateLabels, candidate.id) ? candidateLabels[candidate.id]
      : `${text(candidate.label)}（${text(candidate.id)}）`;
  }
  function positionLabel(point) {
    if (!finite(point.targetX) || !finite(point.targetY)) return `校准点 ${text(point.targetId)}（位置未记录）`;
    const x = point.targetX < 1 / 3 ? '左' : point.targetX > 2 / 3 ? '右' : '中';
    const y = point.targetY < 1 / 3 ? '上' : point.targetY > 2 / 3 ? '下' : '中';
    return `${x === '中' && y === '中' ? '中心' : x + y}（${text(point.targetId)}）`;
  }
  function direction(value, negative, positive, unit) {
    if (!finite(value)) return '未记录';
    return value === 0 ? '0' : `${value < 0 ? negative : positive}${unit} ${percent(Math.abs(value))}`;
  }
  function residualLines(metrics) {
    return [
      `拟合残差 X（屏宽）：平均绝对误差 ${percent(metrics.meanAbsErrorX)}；P95 ${percent(metrics.p95AbsErrorX)}。`,
      `拟合残差 Y（屏高）：平均绝对误差 ${percent(metrics.meanAbsErrorY)}；P95 ${percent(metrics.p95AbsErrorY)}。`,
      `二维拟合残差：平均 ${norm(metrics.meanErrorNorm)}；P95 ${norm(metrics.p95ErrorNorm)}。`,
      `相对目标的平均偏差：X ${direction(metrics.biasX, '左偏', '右偏', '屏宽')}；Y ${direction(metrics.biasY, '上偏', '下偏', '屏高')}。`
    ];
  }
  function summarizeCalibration(input) {
    const fit = object(input), diagnostics = object(fit.diagnostics);
    const candidates = array(diagnostics.candidates).map(object);
    const roundSummaries = array(diagnostics.roundSummaries).map(object);
    const expectedRounds = diagnostics.expectedRoundCount, expectedTargets = diagnostics.expectedTargetCount;
    const complete = fit.ok === true && expectedRounds === 2 && expectedTargets === 9 &&
      roundSummaries.length === 2 && [1, 2].every(index => roundSummaries.some(round =>
        round.roundIndex === index && round.targetCount === 9 && round.presentationCount === 9));
    const roundDescription = roundSummaries.length ? roundSummaries.map(round =>
      `第 ${number(round.roundIndex)} 轮 ${number(round.targetCount)} 点，有效 ${number(round.validCount)}/${number(round.attemptCount)} 条`).join('；') : '逐轮记录未记录';
    const lines = [`${complete ? '两轮九点采集已完成' : '两轮校准记录'}：${roundDescription}。${complete ? '' : `预设 ${number(expectedRounds)} 轮、每轮 ${number(expectedTargets)} 点。`}`];
    for (const candidate of candidates) {
      const folds = array(candidate.folds).map(object);
      const foldDescription = folds.length ? folds.map(fold => {
        const outcome = fold.ok === true ? comparisonScore(fold.score) : fold.ok === false ? `未完成：${reason(fold.reason)}` : '状态未记录';
        return `${number(fold.trainRoundIndex)}→${number(fold.testRoundIndex)}轮 ${outcome}`;
      }).join('；') : '逐轮检验未记录';
      const state = candidate.ok === true ? `整轮交叉检验均值 ${comparisonScore(candidate.score)}`
        : candidate.ok === false ? `候选未生成：${reason(candidate.reason)}；检验分数 ${norm(candidate.score)}` : `候选状态未记录；检验分数 ${norm(candidate.score)}`;
      lines.push(`${candidateLabel(candidate)}：${state}（${foldDescription}）。`);
    }
    if (!candidates.length) lines.push('双眼四特征与双眼均值的候选比较未记录。');
    const selectedId = diagnostics.selectedCandidateId;
    const selected = candidates.find(candidate => candidate.id === selectedId && selectedId != null);
    const rule = diagnostics.protocol === 'two_round_cross_validation_v1'
      ? '仅按校准交叉检验的未四舍五入误差选择；数值相同时优先双眼四特征'
      : text(diagnostics.selectionRule).replace(/[。.]$/, '');
    lines.push(`所选候选：${selected ? candidateLabel(selected) : text(selectedId)}。${rule}。`);
    const training = object(diagnostics.trainingMetrics);
    lines.push(`训练残差：X 平均 ${percent(training.meanAbsErrorX)} 屏宽，Y 平均 ${percent(training.meanAbsErrorY)} 屏高；二维平均 ${norm(training.meanErrorNorm)}、P95 ${norm(training.p95ErrorNorm)}。`);
    lines.push('训练残差与整轮交叉检验均来自校准数据，不是独立精度验证。交叉检验较小而被选中，不代表精度合格；仍须完成独立验证。');
    lines.push('整轮检验的“1→2”指第1轮拟合、第2轮检验，反向同理。X/Y 分别按屏宽/屏高归一化；P95 为95%分位误差，不是视角度数或准确率。');
    if (fit.ok === false) lines.push(`本次拟合未生成：${reason(fit.reason)}。请保留诊断备份。`);
    for (const failure of [...new Set(array(diagnostics.integrityFailures))]) {
      if (failure !== fit.reason) lines.push(`记录完整性检查：${reason(failure)}。`);
    }
    if (diagnostics.protocol !== 'two_round_cross_validation_v1') lines.push(`校准协议${diagnostics.protocol == null ? '未记录' : '未识别'}：${text(diagnostics.protocol)}。`);
    if (selected && selected.ok !== true) lines.push('所选候选状态与选择记录不一致，请保留诊断备份。');

    const points = array(diagnostics.perTargetFit).map(raw => {
      const point = object(raw), metrics = object(point.metrics);
      const details = residualLines(metrics);
      details.push(`同点预测波动：X 标准差 ${percent(point.sdX)} 屏宽；Y 标准差 ${percent(point.sdY)} 屏高；二维均方根波动 ${norm(point.radialRmsAroundMean)}。波动含注视变化与模型变化，不能当作硬件噪声。`);
      const rounds = array(point.roundMeans).map(object);
      if (!rounds.length) details.push('两轮同点预测均值未记录。');
      for (const round of rounds) {
        details.push(`第 ${number(round.roundIndex)} 轮：预测均值 X ${percent(round.x)} 屏宽、Y ${percent(round.y)} 屏高；有效 ${number(round.validCount)}/${number(round.attemptCount)} 条。`);
      }
      const delta = object(point.roundMeanDelta);
      details.push(`两轮同点预测均值变化（第2轮－第1轮）：X ${direction(delta.x, '向左', '向右', '屏宽')}；Y ${direction(delta.y, '向上', '向下', '屏高')}。这是轮间重复性诊断，不能单独归因于头动。`);
      const features = array(delta.features);
      details.push(`原始特征均值差（第2轮－第1轮）：左眼 X ${signedFeature(features[0])}、Y ${signedFeature(features[1])}；右眼 X ${signedFeature(features[2])}、Y ${signedFeature(features[3])}。单位为各眼眼宽比例，不是屏幕位置误差。`);
      const cvPoint = selected && array(selected.perTarget).map(object).find(entry => entry.targetId === point.targetId);
      if (cvPoint) {
        const cvMetrics = object(cvPoint.metrics);
        details.push(`所选候选的同点整轮交叉检验：X 平均 ${percent(cvMetrics.meanAbsErrorX)}、P95 ${percent(cvMetrics.p95AbsErrorX)}（屏宽）；Y 平均 ${percent(cvMetrics.meanAbsErrorY)}、P95 ${percent(cvMetrics.p95AbsErrorY)}（屏高）；二维平均 ${norm(cvMetrics.meanErrorNorm)}、P95 ${norm(cvMetrics.p95ErrorNorm)}。仍是校准诊断。`);
      }
      if (point.reason != null) details.push(reason(point.reason));
      for (const failure of array(point.failures)) details.push(reason(failure));
      return { targetId: point.targetId == null ? null : point.targetId, label: positionLabel(point),
        summary: `有效 ${number(point.validCount)}/${number(point.attemptCount)} 条；拟合平均残差 X ${percent(metrics.meanAbsErrorX)}、Y ${percent(metrics.meanAbsErrorY)}。`, details };
    });
    return { headline: fit.ok === true ? '校准诊断：拟合已生成' : fit.ok === false ? '校准诊断：拟合暂未生成' : '校准诊断：拟合状态未记录', lines, points };
  }
  return { summarizeCalibration };
}));
