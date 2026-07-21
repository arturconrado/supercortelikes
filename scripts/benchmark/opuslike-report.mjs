import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputArgument = process.argv[2] ?? 'benchmarks/opuslike-results.json';
const inputPath = inputArgument === '-' ? '-' : resolve(inputArgument);
const outputPath = resolve(process.argv[3] ?? 'reports/opuslike-benchmark.md');
const input = JSON.parse(inputPath === '-' ? await readStdin() : await readFile(inputPath, 'utf8'));

const expectedCategories = { solo: 4, interview: 4, grid: 2, difficult: 2 };
const reports = [];
for (const plan of ['cpu', 'hybrid']) {
  const samples = input.plans?.[plan];
  if (samples === undefined) {
    reports.push({ plan, status: 'NOT_RUN' });
    continue;
  }
  validateSuite(plan, samples);
  reports.push(evaluate(plan, samples));
}
const cpuReport = reports.find((report) => report.plan === 'cpu');
const hybridReport = reports.find((report) => report.plan === 'hybrid');
if (hybridReport?.status !== 'NOT_RUN') {
  const sourceHours = sum(input.plans.hybrid, 'sourceDurationSeconds') / 3600;
  const variableCost = sum(input.plans.hybrid, 'variableCostUsd');
  const costPerSourceHour = sourceHours > 0 ? variableCost / sourceHours : Number.POSITIVE_INFINITY;
  hybridReport.metrics.variableCostUsd = variableCost;
  hybridReport.metrics.costPerSourceHour = costPerSourceHour;
  hybridReport.checks.push(check('Custo variável por hora-fonte', costPerSourceHour, '<=', input.costs?.limitUsdPerSourceHour ?? 1, 'currency'));
  if (cpuReport?.status !== 'NOT_RUN') {
    hybridReport.checks.push(
      check(
        'Qualidade híbrida superior à CPU',
        qualityScore(hybridReport.metrics),
        '>',
        qualityScore(cpuReport.metrics),
        'score',
      ),
    );
  }
  hybridReport.status = hybridReport.checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
}

const markdown = renderReport(input, reports);
await writeFile(outputPath, markdown, 'utf8');
process.stdout.write(`${outputPath}\n`);
if (reports.some((report) => report.status === 'FAIL')) process.exitCode = 1;

function validateSuite(plan, samples) {
  if (!Array.isArray(samples) || samples.length !== 12) {
    throw new Error(`Plano ${plan}: o benchmark exige exatamente 12 vídeos.`);
  }
  const ids = new Set(samples.map((sample) => sample.id));
  if (ids.size !== samples.length) throw new Error(`Plano ${plan}: IDs de vídeo duplicados.`);
  for (const [category, count] of Object.entries(expectedCategories)) {
    const actual = samples.filter((sample) => sample.category === category).length;
    if (actual !== count) {
      throw new Error(`Plano ${plan}: categoria ${category} exige ${count} vídeos; recebeu ${actual}.`);
    }
  }
  for (const sample of samples) {
    for (const field of [
      'pipelineToCompositionSeconds',
      'renderSeconds',
      'soloSpokenFrames',
      'soloSafeFrames',
      'speakerDecisions',
      'correctSpeakerDecisions',
      'maxOffSceneJumpWidthRatio',
      'captionMeanErrorMs',
      'peakMemoryPercent',
      'vpsCpuP95Percent',
      'restarts',
      'dlq',
    ]) {
      if (!Number.isFinite(sample[field]) || sample[field] < 0) {
        throw new Error(`Plano ${plan}, vídeo ${sample.id}: campo ${field} inválido.`);
      }
    }
    if (plan === 'hybrid') {
      for (const field of ['allFinalsAvailableSeconds', 'variableCostUsd']) {
        if (!Number.isFinite(sample[field]) || sample[field] < 0) {
          throw new Error(`Plano ${plan}, vídeo ${sample.id}: campo ${field} inválido.`);
        }
      }
    }
    for (const field of ['sourceDurationSeconds', 'clipDurationSeconds']) {
      if (!Number.isFinite(sample[field]) || sample[field] <= 0) {
        throw new Error(`Plano ${plan}, vídeo ${sample.id}: campo ${field} deve ser maior que zero.`);
      }
    }
    if (!['PICASHORTS', 'TIE', 'OPUSCLIP'].includes(sample.preference)) {
      throw new Error(`Plano ${plan}, vídeo ${sample.id}: preference inválida.`);
    }
  }
}

function evaluate(plan, samples) {
  const soloFrames = sum(samples, 'soloSpokenFrames');
  const speakerDecisions = sum(samples, 'speakerDecisions');
  const metrics = {
    soloSafeRate: ratio(sum(samples, 'soloSafeFrames'), soloFrames),
    correctSpeakerRate: ratio(sum(samples, 'correctSpeakerDecisions'), speakerDecisions),
    maxJumpRate: Math.max(...samples.map((sample) => sample.maxOffSceneJumpWidthRatio)),
    captionMeanErrorMs: weightedMean(samples, 'captionMeanErrorMs', 'clipDurationSeconds'),
    opusParityRate: samples.filter((sample) => sample.preference !== 'OPUSCLIP').length / samples.length,
    pipelineP95Ratio: percentile95(samples.map((sample) => sample.pipelineToCompositionSeconds / sample.sourceDurationSeconds)),
    renderP95Ratio: percentile95(samples.map((sample) => sample.renderSeconds / sample.clipDurationSeconds)),
    allFinalsP95BudgetRatio: percentile95(samples.map((sample) =>
      Number(sample.allFinalsAvailableSeconds ?? 0) / (sample.sourceDurationSeconds * 0.5 + 180)
    )),
    vpsCpuP95Percent: Math.max(...samples.map((sample) => sample.vpsCpuP95Percent)),
    peakMemoryPercent: Math.max(...samples.map((sample) => sample.peakMemoryPercent)),
    restarts: sum(samples, 'restarts'),
    dlq: sum(samples, 'dlq'),
  };
  const checks = [
    check('Sujeito em área segura', metrics.soloSafeRate, '>=', 0.95, 'percent'),
    check('Falante correto', metrics.correctSpeakerRate, '>=', plan === 'hybrid' ? 0.92 : 0.85, 'percent'),
    check('Maior salto fora de corte de cena', metrics.maxJumpRate, '<=', 0.08, 'percent'),
    check('Erro médio de captions', metrics.captionMeanErrorMs, '<=', 120, 'milliseconds'),
    check('Igual ou melhor que OpusClip', metrics.opusParityRate, '>=', 0.8, 'percent'),
    ...(plan === 'cpu'
      ? [
          check('p95 pipeline/composição', metrics.pipelineP95Ratio, '<=', 1, 'ratio'),
          check('p95 render final', metrics.renderP95Ratio, '<=', 2, 'ratio'),
        ]
      : [check('Todos os finais no prazo p95', metrics.allFinalsP95BudgetRatio, '<=', 1, 'ratio')]),
    check('CPU p95 da VPS', metrics.vpsCpuP95Percent, '<', 50, 'percent-number'),
    check('Pico de memória', metrics.peakMemoryPercent, '<', 70, 'percent-number'),
    check('Restarts', metrics.restarts, '<=', 0, 'integer'),
    check('DLQ', metrics.dlq, '<=', 0, 'integer'),
  ];
  return {
    plan,
    status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
    metrics,
    checks,
  };
}

function check(label, value, operator, threshold, format) {
  const valid = Number.isFinite(value) && Number.isFinite(threshold);
  const pass = valid && (operator === '>=' ? value >= threshold : operator === '>' ? value > threshold : operator === '<' ? value < threshold : value <= threshold);
  return { label, value, operator, threshold, format, pass };
}

function renderReport(input, reports) {
  const lines = [
    '# Benchmark Opus-like — CPU local e IA/GPU serverless',
    '',
    `Data: ${input.date ?? new Date().toISOString().slice(0, 10)}`,
    '',
    'A comparação usa os mesmos 12 vídeos e a mesma conta QA do OpusClip. `TIE` conta como qualidade igual ao OpusClip.',
    '',
  ];
  for (const report of reports) {
    lines.push(`## Plano ${report.plan.toUpperCase()} — ${report.status}`, '');
    if (report.status === 'NOT_RUN') {
      lines.push('Ainda não executado.', '');
      continue;
    }
    lines.push('| Critério | Medido | Limite | Resultado |', '| --- | ---: | ---: | --- |');
    for (const item of report.checks) {
      lines.push(`| ${item.label} | ${format(item.value, item.format)} | ${item.operator} ${format(item.threshold, item.format)} | ${item.pass ? 'PASS' : 'FAIL'} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Custo e decisão',
    '',
    `- CPU mensal total: ${input.costs?.cpuMonthlyTotal ?? 'não informado'}`,
    `- Limite variável por hora-fonte: US$ ${Number(input.costs?.limitUsdPerSourceHour ?? 1).toFixed(2)}`,
    `- Custo híbrido medido: ${hybridReport?.metrics?.variableCostUsd === undefined ? 'não informado' : `US$ ${hybridReport.metrics.variableCostUsd.toFixed(4)}`}`,
    '',
    'O modo híbrido somente pode ser ativado se o benchmark for PASS, superar a CPU e respeitar US$1 por hora-fonte. Este relatório não provisiona infraestrutura.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function sum(samples, field) {
  return samples.reduce((total, sample) => total + sample[field], 0);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function weightedMean(samples, field, weightField) {
  const weight = sum(samples, weightField);
  return weight > 0
    ? samples.reduce((total, sample) => total + sample[field] * sample[weightField], 0) / weight
    : 0;
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function qualityScore(metrics) {
  const captionScore = 1 - Math.min(1, metrics.captionMeanErrorMs / 120);
  const jumpScore = 1 - Math.min(1, metrics.maxJumpRate / 0.08);
  return (
    metrics.soloSafeRate * 25
    + metrics.correctSpeakerRate * 35
    + metrics.opusParityRate * 25
    + captionScore * 10
    + jumpScore * 5
  );
}

function format(value, type) {
  if (type === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (type === 'percent-number') return `${value.toFixed(1)}%`;
  if (type === 'milliseconds') return `${value.toFixed(1)} ms`;
  if (type === 'ratio') return `${value.toFixed(2)}x`;
  if (type === 'currency') return Number.isFinite(value) ? `US$ ${value.toFixed(2)}` : 'não informado';
  if (type === 'score') return value.toFixed(2);
  return String(value);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
