// Deterministic satellite analysis for the monthly yard-health timeline.
// This keeps the page explanation grounded in the exact NDVI values on screen.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHANGE_THRESHOLD = 0.03;

function sortStats(rawStats = []) {
  return rawStats
    .filter(entry => Number.isFinite(entry?.mean))
    .map(entry => ({
      from: entry.from || '',
      to: entry.to || '',
      mean: Number(entry.mean),
      samples: Number(entry.samples) || 0,
    }))
    .sort((left, right) => String(left.from || left.to).localeCompare(String(right.from || right.to)));
}

function monthYearLabel(dateStr) {
  const date = new Date(`${String(dateStr || '').slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'Unknown month';
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function monthIndex(dateStr) {
  const date = new Date(`${String(dateStr || '').slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? -1 : date.getUTCMonth();
}

function signedValue(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function changeDirection(delta, threshold = CHANGE_THRESHOLD) {
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta >= threshold) return 'up';
  if (delta <= -threshold) return 'down';
  return 'flat';
}

function describeChange(delta, referenceLabel, threshold = CHANGE_THRESHOLD) {
  const direction = changeDirection(delta, threshold);
  if (direction === 'up') {
    return `up ${Math.abs(delta).toFixed(2)} versus ${referenceLabel}`;
  }
  if (direction === 'down') {
    return `down ${Math.abs(delta).toFixed(2)} versus ${referenceLabel}`;
  }
  return `essentially flat versus ${referenceLabel} (${signedValue(delta)})`;
}

function toneForBand(key) {
  if (key === 'very-low' || key === 'low') return 'warning';
  if (key === 'strong' || key === 'very-strong') return 'success';
  return 'neutral';
}

export function classifyNdvi(mean, dateStr = '') {
  if (!Number.isFinite(mean)) {
    return {
      key: 'unknown',
      tone: 'neutral',
      label: 'No usable vegetation signal',
      description: 'Clouds, masking, or missing observations prevented a reliable monthly reading.',
    };
  }

  const month = monthIndex(dateStr);
  const isWinter = month === 11 || month === 0 || month === 1;

  if (mean < 0.15) {
    return {
      key: 'very-low',
      tone: toneForBand('very-low'),
      label: isWinter ? 'Very low or dormant signal' : 'Very low vegetation signal',
      description: isWinter
        ? 'This footprint is dominated by dormant turf, bare ground, or hardscape in this month.'
        : 'This footprint is dominated by bare ground, hardscape, or heavily stressed vegetation in this month.',
    };
  }

  if (mean < 0.30) {
    return {
      key: 'low',
      tone: toneForBand('low'),
      label: isWinter ? 'Low winter vegetation signal' : 'Low vegetation signal',
      description: isWinter
        ? 'Thin or dormant vegetation is present, but dense green cover is limited.'
        : 'Vegetation is present, but the month reads thin, mixed, or stressed rather than lush.',
    };
  }

  if (mean < 0.45) {
    return {
      key: 'moderate',
      tone: toneForBand('moderate'),
      label: 'Moderate vegetation signal',
      description: 'This footprint looks mixed: some healthy cover, some soil, hardscape, or thinner turf.',
    };
  }

  if (mean < 0.60) {
    return {
      key: 'strong',
      tone: toneForBand('strong'),
      label: 'Strong vegetation signal',
      description: 'This footprint reads clearly green, with active vegetation making up a large share of the crop.',
    };
  }

  return {
    key: 'very-strong',
    tone: toneForBand('very-strong'),
    label: 'Very strong vegetation signal',
    description: 'Active vegetation dominates this footprint for the month.',
  };
}

function buildSeasonalityNote(dateStr) {
  switch (monthIndex(dateStr)) {
    case 11:
    case 0:
    case 1:
      return 'Winter months often read weak because dormant turf, bare soil, roofs, and pavement dominate the signal. A low winter value alone is not enough to diagnose an irrigation problem.';
    case 2:
    case 3:
    case 4:
      return 'Spring values can move quickly as turf wakes up, so compare the same footprint month to month instead of reacting to one isolated reading.';
    case 5:
    case 6:
    case 7:
      return 'Summer is usually the cleanest period for comparing irrigation performance because vegetation is active and heat stress is highest.';
    case 8:
    case 9:
    case 10:
      return 'Fall declines can be seasonal as daylight and temperatures drop, even when irrigation is adequate.';
    default:
      return 'Compare the same footprint over time; seasonal context matters as much as the absolute number.';
  }
}

function buildHeadline(overallDirection, latestBand) {
  const currentLabel = latestBand.label.toLowerCase();
  if (overallDirection === 'up') {
    return `Vegetation signal is improving and the latest month reads as ${currentLabel}.`;
  }
  if (overallDirection === 'down') {
    return `Vegetation signal is weakening and the latest month reads as ${currentLabel}.`;
  }
  return `Vegetation signal is relatively steady and the latest month reads as ${currentLabel}.`;
}

export function buildSatelliteAnalysis(rawStats = []) {
  const stats = sortStats(rawStats);
  if (stats.length === 0) {
    return {
      headline: 'No usable monthly vegetation observations were returned for this time window.',
      observationCount: 0,
      latest: null,
      monthOverMonth: null,
      overall: null,
      strongestMonth: null,
      weakestMonth: null,
      findings: ['Try a wider date range or check whether cloud filtering removed the available observations.'],
      readingGuide: [
        'The sharp aerial photo is the alignment image.',
        'The colored overlay is the monthly vegetation signal.',
      ],
      limitations: [
        'Sentinel vegetation pixels are much coarser than the orthophoto.',
      ],
      seasonalityNote: '',
    };
  }

  const first = stats[0];
  const latest = stats[stats.length - 1];
  const previous = stats.length > 1 ? stats[stats.length - 2] : null;
  const strongest = stats.reduce((best, entry) => (entry.mean > best.mean ? entry : best), stats[0]);
  const weakest = stats.reduce((worst, entry) => (entry.mean < worst.mean ? entry : worst), stats[0]);
  const latestBand = classifyNdvi(latest.mean, latest.to || latest.from);
  const previousLabel = previous ? monthYearLabel(previous.to || previous.from) : null;
  const latestLabel = monthYearLabel(latest.to || latest.from);
  const firstLabel = monthYearLabel(first.to || first.from);

  const monthDelta = previous ? latest.mean - previous.mean : null;
  const overallDelta = latest.mean - first.mean;
  const overallDirection = changeDirection(overallDelta);

  const findings = [
    `Latest usable month is ${latestLabel} at NDVI ${latest.mean.toFixed(2)}, which reads as ${latestBand.label.toLowerCase()} for this footprint.`,
    previous
      ? `Month over month, the signal is ${describeChange(monthDelta, previousLabel)}. Across this ${stats.length}-month window, it is ${describeChange(overallDelta, firstLabel)}.`
      : 'This is the first usable month in the current timeline, so month-over-month comparison is not available yet.',
    `The strongest month in this window was ${monthYearLabel(strongest.to || strongest.from)} (${strongest.mean.toFixed(2)}). The weakest was ${monthYearLabel(weakest.to || weakest.from)} (${weakest.mean.toFixed(2)}).`,
  ];

  return {
    headline: buildHeadline(overallDirection, latestBand),
    observationCount: stats.length,
    latest: {
      monthLabel: latestLabel,
      mean: latest.mean,
      categoryLabel: latestBand.label,
      description: latestBand.description,
      tone: latestBand.tone,
      samples: latest.samples,
    },
    monthOverMonth: previous ? {
      referenceLabel: previousLabel,
      delta: monthDelta,
      direction: changeDirection(monthDelta),
      summary: describeChange(monthDelta, previousLabel),
    } : null,
    overall: {
      referenceLabel: firstLabel,
      delta: overallDelta,
      direction: overallDirection,
      summary: describeChange(overallDelta, firstLabel),
    },
    strongestMonth: {
      monthLabel: monthYearLabel(strongest.to || strongest.from),
      mean: strongest.mean,
    },
    weakestMonth: {
      monthLabel: monthYearLabel(weakest.to || weakest.from),
      mean: weakest.mean,
    },
    findings,
    readingGuide: [
      'The sharp aerial photo is a fixed alignment image. It does not update every month; only the colored vegetation overlay changes.',
      'Greener overlay means a stronger vegetation signal. Yellow or brown means thinner, dormant, or weaker vegetation.',
      'Compare the same strip or zone month to month. Direction and consistency matter more than any single absolute NDVI target.',
    ],
    limitations: [
      'Sentinel vegetation pixels are about 10 meters wide, so this is best for directional trend spotting, not blade-level diagnosis.',
      'Roofs, driveways, trees, and bare soil inside the crop all affect the average. Use the same footprint over time instead of chasing one universal “good” number.',
    ],
    seasonalityNote: buildSeasonalityNote(latest.to || latest.from),
  };
}
