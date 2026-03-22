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

/**
 * Render the charts page HTML.
 */
export function chartsPageContent() {
  return `
    <div class="card">
      <h2>Water Usage (Last 14 Days)</h2>
      <canvas id="usageChart" height="200"></canvas>
    </div>

    <div class="card">
      <h2>Daily Cost (Last 14 Days)</h2>
      <canvas id="costChart" height="200"></canvas>
    </div>

    <div class="card">
      <h2>Decisions (Last 14 Days)</h2>
      <canvas id="decisionChart" height="150"></canvas>
    </div>

    <div class="card">
      <h2>Precipitation: Station vs Forecast (Last 7 Days)</h2>
      <canvas id="precipChart" height="200"></canvas>
    </div>

    <div class="card">
      <h2>Current Soil Moisture</h2>
      <canvas id="moistureChart" height="250"></canvas>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      fetch('/api/charts')
        .then(r => r.json())
        .then(data => {
          const colors = {
            blue: 'rgba(11, 95, 255, 0.7)',
            green: 'rgba(15, 123, 62, 0.7)',
            orange: 'rgba(161, 92, 0, 0.7)',
            red: 'rgba(180, 35, 24, 0.7)',
            lightBlue: 'rgba(11, 95, 255, 0.15)',
            lightGreen: 'rgba(15, 123, 62, 0.15)',
          };

          // Usage chart
          if (data.dailyUsage.length > 0) {
            new Chart(document.getElementById('usageChart'), {
              type: 'bar',
              data: {
                labels: data.dailyUsage.map(d => d.date.slice(5)),
                datasets: [{
                  label: 'Gallons',
                  data: data.dailyUsage.map(d => d.gallons),
                  backgroundColor: colors.blue,
                  borderRadius: 4,
                }]
              },
              options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
          }

          // Cost chart
          if (data.dailyUsage.length > 0) {
            new Chart(document.getElementById('costChart'), {
              type: 'line',
              data: {
                labels: data.dailyUsage.map(d => d.date.slice(5)),
                datasets: [{
                  label: 'Cost ($)',
                  data: data.dailyUsage.map(d => d.cost),
                  borderColor: colors.green,
                  backgroundColor: colors.lightGreen,
                  fill: true,
                  tension: 0.3,
                }]
              },
              options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
          }

          // Decision chart
          if (data.decisions.length > 0) {
            const dateCounts = {};
            for (const d of data.decisions) {
              const key = d.date;
              if (!dateCounts[key]) dateCounts[key] = { water: 0, skip: 0 };
              dateCounts[key][d.decision === 'WATER' ? 'water' : 'skip']++;
            }
            const dates = Object.keys(dateCounts).sort();
            new Chart(document.getElementById('decisionChart'), {
              type: 'bar',
              data: {
                labels: dates.map(d => d.slice(5)),
                datasets: [
                  { label: 'Water', data: dates.map(d => dateCounts[d].water), backgroundColor: colors.blue, borderRadius: 4 },
                  { label: 'Skip', data: dates.map(d => dateCounts[d].skip), backgroundColor: colors.orange, borderRadius: 4 },
                ]
              },
              options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
            });
          }

          // Precipitation comparison
          if (data.precipAudits.length > 0) {
            new Chart(document.getElementById('precipChart'), {
              type: 'bar',
              data: {
                labels: data.precipAudits.map(d => d.date.slice(5)),
                datasets: [
                  { label: 'Your Station', data: data.precipAudits.map(d => d.ambient_inches), backgroundColor: colors.blue, borderRadius: 4 },
                  { label: 'OpenMeteo', data: data.precipAudits.map(d => d.openmeteo_inches), backgroundColor: colors.orange, borderRadius: 4 },
                ]
              },
              options: { responsive: true, scales: { y: { beginAtZero: true, title: { display: true, text: 'Inches' } } } }
            });
          }

          // Moisture bar chart
          if (data.moisture.length > 0) {
            new Chart(document.getElementById('moistureChart'), {
              type: 'bar',
              data: {
                labels: data.moisture.map(z => 'Zone ' + z.zone),
                datasets: [{
                  label: 'Moisture %',
                  data: data.moisture.map(z => z.pct),
                  backgroundColor: data.moisture.map(z =>
                    z.pct < 40 ? colors.red : z.pct < 60 ? colors.orange : colors.green
                  ),
                  borderRadius: 4,
                }]
              },
              options: {
                indexAxis: 'y',
                responsive: true,
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } }
              }
            });
          }
        })
        .catch(err => console.error('Chart data load failed:', err));
    </script>
  `;
}
