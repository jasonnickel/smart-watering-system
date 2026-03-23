// Historical chart data endpoints and page renderer
// Uses Chart.js via CDN for client-side rendering

import {
  getDB, getRunsSince,
  getRecentPrecipitationAudits,
} from './db/state.js';

/**
 * Get moisture history from soil_moisture table updates.
 * Reconstructs daily snapshots from runs log.
 *
 * @param {number} days - Number of days to look back
 * @returns {object} { labels: string[], datasets: {zoneNumber, zoneName, data}[] }
 */
export function getMoistureHistory(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Get daily usage records which track zone activity
  const usageRows = getDB().prepare(
    'SELECT * FROM daily_usage WHERE date >= ? ORDER BY date ASC'
  ).all(since);

  // Get current moisture for latest snapshot
  const currentMoisture = getDB().prepare(
    'SELECT * FROM soil_moisture ORDER BY zone_number'
  ).all();

  // Get all DECIDE runs for decision frequency
  const runs = getRunsSince(new Date(Date.now() - days * 86400000).toISOString());
  const decisions = runs.filter(r => r.phase === 'DECIDE');

  return {
    moisture: currentMoisture.map(z => ({
      zone: z.zone_number,
      name: z.zone_name,
      pct: z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0,
      inches: z.balance_inches,
      capacity: z.total_capacity,
    })),
    dailyUsage: usageRows.map(r => ({
      date: r.date,
      gallons: r.gallons,
      cost: r.cost,
    })),
    decisions: decisions.map(r => ({
      date: r.timestamp?.slice(0, 10),
      decision: r.decision,
      reason: r.reason,
      gallons: r.total_gallons,
    })),
    precipAudits: getRecentPrecipitationAudits(days),
  };
}

function renderRangeOptions(selectedDays) {
  return [7, 14, 30, 60, 90]
    .map(days => `<option value="${days}"${days === selectedDays ? ' selected' : ''}>Last ${days} days</option>`)
    .join('');
}

function renderChartHeader(title, selectId, selectedDays) {
  return `<div class="chart-card-header">
    <h2>${title}</h2>
    <label class="chart-control" for="${selectId}">
      <span>Range</span>
      <select id="${selectId}">
        ${renderRangeOptions(selectedDays)}
      </select>
    </label>
  </div>`;
}

/**
 * Render the charts page HTML.
 */
export function chartsPageContent() {
  return `
    <div class="card">
      ${renderChartHeader('Water Usage', 'usage-days', 14)}
      <canvas id="usageChart" height="200"></canvas>
    </div>

    <div class="card">
      ${renderChartHeader('Daily Cost', 'cost-days', 14)}
      <canvas id="costChart" height="200"></canvas>
    </div>

    <div class="card">
      ${renderChartHeader('Decisions', 'decision-days', 14)}
      <canvas id="decisionChart" height="150"></canvas>
    </div>

    <div class="card">
      ${renderChartHeader('Precipitation: Station vs Forecast', 'precip-days', 7)}
      <canvas id="precipChart" height="200"></canvas>
    </div>

    <div class="card">
      <h2>Current Soil Moisture</h2>
      <canvas id="moistureChart" height="250"></canvas>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      const colors = {
        blue: 'rgba(11, 95, 255, 0.7)',
        green: 'rgba(15, 123, 62, 0.7)',
        orange: 'rgba(161, 92, 0, 0.7)',
        red: 'rgba(180, 35, 24, 0.7)',
        lightGreen: 'rgba(15, 123, 62, 0.15)',
      };
      const chartCache = new Map();
      const chartInstances = {};

      async function fetchChartData(days) {
        const cacheKey = String(days);
        if (!chartCache.has(cacheKey)) {
          chartCache.set(cacheKey, fetch('/api/charts?days=' + encodeURIComponent(days))
            .then(response => {
              if (!response.ok) {
                throw new Error('Chart data request failed with status ' + response.status);
              }
              return response.json();
            }));
        }
        return chartCache.get(cacheKey);
      }

      function destroyChart(key) {
        if (chartInstances[key]) {
          chartInstances[key].destroy();
          delete chartInstances[key];
        }
      }

      function renderUsageChart(data) {
        destroyChart('usage');
        if (data.dailyUsage.length === 0) return;

        chartInstances.usage = new Chart(document.getElementById('usageChart'), {
          type: 'bar',
          data: {
            labels: data.dailyUsage.map(day => day.date.slice(5)),
            datasets: [{
              label: 'Gallons',
              data: data.dailyUsage.map(day => day.gallons),
              backgroundColor: colors.blue,
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } },
          },
        });
      }

      function renderCostChart(data) {
        destroyChart('cost');
        if (data.dailyUsage.length === 0) return;

        chartInstances.cost = new Chart(document.getElementById('costChart'), {
          type: 'line',
          data: {
            labels: data.dailyUsage.map(day => day.date.slice(5)),
            datasets: [{
              label: 'Cost ($)',
              data: data.dailyUsage.map(day => day.cost),
              borderColor: colors.green,
              backgroundColor: colors.lightGreen,
              fill: true,
              tension: 0.3,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } },
          },
        });
      }

      function renderDecisionChart(data) {
        destroyChart('decision');
        if (data.decisions.length === 0) return;

        const dateCounts = {};
        for (const decision of data.decisions) {
          const key = decision.date;
          if (!dateCounts[key]) dateCounts[key] = { water: 0, skip: 0 };
          dateCounts[key][decision.decision === 'WATER' ? 'water' : 'skip']++;
        }

        const dates = Object.keys(dateCounts).sort();
        chartInstances.decision = new Chart(document.getElementById('decisionChart'), {
          type: 'bar',
          data: {
            labels: dates.map(date => date.slice(5)),
            datasets: [
              { label: 'Water', data: dates.map(date => dateCounts[date].water), backgroundColor: colors.blue, borderRadius: 4 },
              { label: 'Skip', data: dates.map(date => dateCounts[date].skip), backgroundColor: colors.orange, borderRadius: 4 },
            ],
          },
          options: {
            responsive: true,
            scales: {
              x: { stacked: true },
              y: { stacked: true, beginAtZero: true },
            },
          },
        });
      }

      function renderPrecipChart(data) {
        destroyChart('precip');
        if (data.precipAudits.length === 0) return;

        const audits = [...data.precipAudits].reverse();
        chartInstances.precip = new Chart(document.getElementById('precipChart'), {
          type: 'bar',
          data: {
            labels: audits.map(day => day.date.slice(5)),
            datasets: [
              { label: 'Your Station', data: audits.map(day => day.ambient_inches), backgroundColor: colors.blue, borderRadius: 4 },
              { label: 'OpenMeteo', data: audits.map(day => day.openmeteo_inches), backgroundColor: colors.orange, borderRadius: 4 },
            ],
          },
          options: {
            responsive: true,
            scales: {
              y: {
                beginAtZero: true,
                title: { display: true, text: 'Inches' },
              },
            },
          },
        });
      }

      function renderMoistureChart(data) {
        destroyChart('moisture');
        if (data.moisture.length === 0) return;

        chartInstances.moisture = new Chart(document.getElementById('moistureChart'), {
          type: 'bar',
          data: {
            labels: data.moisture.map(zone => 'Zone ' + zone.zone),
            datasets: [{
              label: 'Moisture %',
              data: data.moisture.map(zone => zone.pct),
              backgroundColor: data.moisture.map(zone =>
                zone.pct < 40 ? colors.red : zone.pct < 60 ? colors.orange : colors.green
              ),
              borderRadius: 4,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              x: {
                beginAtZero: true,
                max: 100,
                title: { display: true, text: '%' },
              },
            },
          },
        });
      }

      async function refreshRangeChart(kind, days) {
        const data = await fetchChartData(days);
        switch (kind) {
          case 'usage':
            renderUsageChart(data);
            break;
          case 'cost':
            renderCostChart(data);
            break;
          case 'decision':
            renderDecisionChart(data);
            break;
          case 'precip':
            renderPrecipChart(data);
            break;
          default:
            break;
        }
      }

      document.getElementById('usage-days').addEventListener('change', event => {
        refreshRangeChart('usage', Number(event.target.value)).catch(err => console.error('Usage chart load failed:', err));
      });
      document.getElementById('cost-days').addEventListener('change', event => {
        refreshRangeChart('cost', Number(event.target.value)).catch(err => console.error('Cost chart load failed:', err));
      });
      document.getElementById('decision-days').addEventListener('change', event => {
        refreshRangeChart('decision', Number(event.target.value)).catch(err => console.error('Decision chart load failed:', err));
      });
      document.getElementById('precip-days').addEventListener('change', event => {
        refreshRangeChart('precip', Number(event.target.value)).catch(err => console.error('Precipitation chart load failed:', err));
      });

      Promise.all([fetchChartData(14), fetchChartData(7)])
        .then(([defaultData, precipData]) => {
          renderUsageChart(defaultData);
          renderCostChart(defaultData);
          renderDecisionChart(defaultData);
          renderPrecipChart(precipData);
          renderMoistureChart(defaultData);
        })
        .catch(err => console.error('Chart data load failed:', err));
    </script>
  `;
}
