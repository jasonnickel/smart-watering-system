import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initDB,
  closeDB,
  logFlowAudit,
  logPrecipitationAudit,
  logWeatherDiscrepancy,
} from '../../src/db/state.js';
import {
  collectAdvisorInsights,
  generateSummaryNarrative,
} from '../../src/ai/advisor.js';

const tempDirs = [];

function makeTempDBPath() {
  const dir = mkdtempSync(join(tmpdir(), 'smart-water-advisor-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

afterEach(() => {
  closeDB();
  delete process.env.AI_API_KEY;
  delete process.env.AI_API_BASE_URL;
  delete process.env.AI_MODEL;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Advisor insights', () => {
  it('surfaces weather, rain-gauge, and flow anomalies from stored data', () => {
    initDB(makeTempDBPath());

    for (let index = 0; index < 3; index += 1) {
      logWeatherDiscrepancy(
        'precipitation',
        0.4,
        0.1,
        0.1,
        `Discrepancy ${index + 1}`
      );
    }

    logPrecipitationAudit('2026-03-20', 0.42, 0.10, 0.10);
    logPrecipitationAudit('2026-03-21', 0.35, 0.09, 0.09);
    logPrecipitationAudit('2026-03-22', 0.38, 0.11, 0.11);

    for (let index = 0; index < 5; index += 1) {
      logFlowAudit('zone-3', 3, 10, 13);
    }

    const insights = collectAdvisorInsights({ maxInsights: 6 });

    assert.ok(insights.some(insight => insight.kind === 'forecast-confidence'));
    assert.ok(insights.some(insight => insight.kind === 'rain-gauge-bias'));
    assert.ok(insights.some(insight => insight.kind === 'flow-calibration' && /Zone 3/.test(insight.title)));
  });

  it('calls the configured OpenAI-compatible provider for a summary narrative', async () => {
    initDB(makeTempDBPath());
    process.env.AI_API_KEY = 'test-key';

    const originalFetch = globalThis.fetch;
    let request = null;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Conditions look stable overall. Keep an eye on the weather-source disagreement before trusting a rain skip.',
                reasoning_content: 'The user has one discrepancy and rain in the forecast. Sources disagree so rain skip confidence is low.',
              },
            },
          ],
        }),
      };
    };

    try {
      const narrative = await generateSummaryNarrative({
        overnightSummary: 'Skipped: Recent Rain',
        weatherStatus: 'Ambient Weather (12 min ago)',
        forecastText: 'High 74F, Low 48F, 0.10" rain expected',
        yesterdayUsage: { gallons: 0, cost: 0 },
        monthlyUsage: { gallons: 1200, cost: 8.4 },
        discrepancies: [{ reason: 'Mismatch 1' }],
        advisorInsights: [{
          title: 'Forecast confidence is reduced',
          summary: 'Sources disagreed about rainfall.',
        }],
      });

      assert.equal(narrative, 'Conditions look stable overall. Keep an eye on the weather-source disagreement before trusting a rain skip.');
      assert.equal(request.url, 'https://api.moonshot.ai/v1/chat/completions');

      const body = JSON.parse(request.options.body);
      assert.equal(body.model, 'kimi-k2-thinking');
      assert.equal(body.temperature, 0.2);
      assert.match(request.options.headers.Authorization, /^Bearer test-key$/);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'user');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
