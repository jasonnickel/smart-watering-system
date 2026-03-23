import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSatelliteAnalysis, classifyNdvi } from '../../src/ai/satellite.js';

describe('Satellite analysis', () => {
  it('builds a stable facts-first summary from monthly NDVI stats', () => {
    const analysis = buildSatelliteAnalysis([
      {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-31T23:59:59Z',
        mean: 0.24,
        samples: 10,
      },
      {
        from: '2026-02-01T00:00:00Z',
        to: '2026-02-28T23:59:59Z',
        mean: 0.28,
        samples: 11,
      },
      {
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
        mean: 0.37,
        samples: 13,
      },
    ]);

    assert.equal(analysis.observationCount, 3);
    assert.equal(analysis.latest.monthLabel, 'Mar 2026');
    assert.equal(analysis.latest.categoryLabel, 'Moderate vegetation signal');
    assert.equal(analysis.monthOverMonth.direction, 'up');
    assert.equal(analysis.overall.direction, 'up');
    assert.equal(analysis.strongestMonth.mean, 0.37);
    assert.equal(analysis.weakestMonth.mean, 0.24);
    assert.match(analysis.headline, /improving/i);
    assert.match(analysis.findings[0], /Mar 2026/);
    assert.match(analysis.readingGuide[0], /fixed alignment image/i);
  });

  it('treats low winter NDVI as potentially dormant rather than automatically unhealthy', () => {
    const band = classifyNdvi(0.12, '2026-01-31T23:59:59Z');
    const analysis = buildSatelliteAnalysis([
      {
        from: '2025-12-01T00:00:00Z',
        to: '2025-12-31T23:59:59Z',
        mean: 0.15,
        samples: 8,
      },
      {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-31T23:59:59Z',
        mean: 0.12,
        samples: 7,
      },
    ]);

    assert.equal(band.label, 'Very low or dormant signal');
    assert.match(analysis.seasonalityNote, /Winter months often read weak/i);
    assert.match(analysis.findings[0], /very low or dormant signal/i);
  });
});
