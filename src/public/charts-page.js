// Charts page renderer. Loaded as an external script so CSP (script-src 'self')
// doesn't block it. Chart.js is bundled at /chart.umd.min.js and loaded via a
// <script> tag before this file.

(function () {
  const colors = {
    blue: 'rgba(11, 95, 255, 0.7)',
    green: 'rgba(15, 123, 62, 0.7)',
    orange: 'rgba(161, 92, 0, 0.7)',
    red: 'rgba(180, 35, 24, 0.7)',
    purple: 'rgba(120, 60, 200, 0.7)',
    lightGreen: 'rgba(15, 123, 62, 0.15)',
    lightBlue: 'rgba(11, 95, 255, 0.15)',
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
    const rows = data.dailyUsage || [];
    if (rows.length === 0) return;
    chartInstances.usage = new Chart(document.getElementById('usageChart'), {
      type: 'bar',
      data: {
        labels: rows.map(day => day.date.slice(5)),
        datasets: [{
          label: 'Gallons (AquaHawk)',
          data: rows.map(day => day.gallons),
          backgroundColor: colors.blue,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Gallons' } } },
      },
    });
  }

  function renderCostChart(data) {
    destroyChart('cost');
    const rows = data.dailyUsage || [];
    if (rows.length === 0) return;
    chartInstances.cost = new Chart(document.getElementById('costChart'), {
      type: 'line',
      data: {
        labels: rows.map(day => day.date.slice(5)),
        datasets: [{
          label: 'Cost ($)',
          data: rows.map(day => day.cost),
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

  function renderBillsChart(data) {
    destroyChart('bills');
    const bills = data.bills || [];
    if (bills.length === 0) return;
    chartInstances.bills = new Chart(document.getElementById('billsChart'), {
      type: 'bar',
      data: {
        labels: bills.map(b => b.period_end),
        datasets: [
          { label: 'Water Service', data: bills.map(b => b.water_service || 0), backgroundColor: colors.blue, stack: 'cost' },
          { label: 'Base Fee',      data: bills.map(b => b.water_base_fee || 0), backgroundColor: colors.green, stack: 'cost' },
          { label: 'Wastewater',    data: bills.map(b => b.wastewater || 0), backgroundColor: colors.orange, stack: 'cost' },
          { label: 'Drainage',      data: bills.map(b => b.drainage || 0), backgroundColor: colors.purple, stack: 'cost' },
        ],
      },
      options: {
        responsive: true,
        scales: {
          x: { stacked: true, title: { display: true, text: 'Bill period end' } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: '$' } },
        },
      },
    });
  }

  function renderPredVsActualChart(data) {
    destroyChart('predVsActual');
    const rows = (data.dailyUsage || []).filter(r => r.actual_gallons != null || r.predicted_gallons != null);
    if (rows.length === 0) return;
    chartInstances.predVsActual = new Chart(document.getElementById('predVsActualChart'), {
      type: 'line',
      data: {
        labels: rows.map(r => r.date.slice(5)),
        datasets: [
          { label: 'Actual (AquaHawk)', data: rows.map(r => r.actual_gallons), borderColor: colors.blue, backgroundColor: colors.lightBlue, fill: false, tension: 0.2 },
          { label: 'Predicted (Taproot model)', data: rows.map(r => r.predicted_gallons), borderColor: colors.orange, backgroundColor: 'transparent', fill: false, borderDash: [5, 3], tension: 0.2 },
        ],
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Gallons' } } },
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
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
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
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Inches' } } },
      },
    });
  }

  function renderWeatherChart(data) {
    destroyChart('weather');
    const rows = data.weatherHistory || [];
    if (rows.length === 0) return;
    const seen = new Set();
    const unique = rows.filter(r => (seen.has(r.date) ? false : (seen.add(r.date), true)));
    chartInstances.weather = new Chart(document.getElementById('weatherChart'), {
      data: {
        labels: unique.map(r => r.date.slice(5)),
        datasets: [
          { type: 'line', label: 'High', data: unique.map(r => r.temp_max), borderColor: colors.red, backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3 },
          { type: 'line', label: 'Low', data: unique.map(r => r.temp_min), borderColor: colors.blue, backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3 },
          { type: 'bar', label: 'Rain (in)', data: unique.map(r => r.precipitation || 0), backgroundColor: colors.lightBlue, yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: { type: 'linear', position: 'left', title: { display: true, text: 'F' } },
          y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'inches' }, beginAtZero: true },
        },
      },
    });
  }

  function renderEtChart(data) {
    destroyChart('et');
    const rows = data.referenceET || [];
    if (rows.length === 0) return;
    chartInstances.et = new Chart(document.getElementById('etChart'), {
      type: 'line',
      data: {
        labels: rows.map(r => r.date.slice(5)),
        datasets: [{
          label: 'Reference ETo (inches)',
          data: rows.map(r => r.reference_eto),
          borderColor: colors.green,
          backgroundColor: colors.lightGreen,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'inches/day' } } },
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
        scales: { x: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } },
      },
    });
  }

  async function refreshRangeChart(kind, days) {
    const data = await fetchChartData(days);
    const dispatch = {
      usage: renderUsageChart,
      cost: renderCostChart,
      decision: renderDecisionChart,
      precip: renderPrecipChart,
      predvsactual: renderPredVsActualChart,
      weather: renderWeatherChart,
      et: renderEtChart,
    };
    if (dispatch[kind]) dispatch[kind](data);
  }

  function attachRangeListener(id, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', event => {
      refreshRangeChart(kind, Number(event.target.value)).catch(err => console.error(kind + ' chart load failed:', err));
    });
  }

  function init() {
    attachRangeListener('usage-days', 'usage');
    attachRangeListener('cost-days', 'cost');
    attachRangeListener('decision-days', 'decision');
    attachRangeListener('precip-days', 'precip');
    attachRangeListener('predvsactual-days', 'predvsactual');
    attachRangeListener('weather-days', 'weather');
    attachRangeListener('et-days', 'et');

    Promise.all([fetchChartData(14), fetchChartData(7), fetchChartData(30)])
      .then(([defaultData, precipData, thirtyDayData]) => {
        renderUsageChart(defaultData);
        renderCostChart(defaultData);
        renderBillsChart(defaultData);
        renderPredVsActualChart(defaultData);
        renderDecisionChart(defaultData);
        renderPrecipChart(precipData);
        renderWeatherChart(thirtyDayData);
        renderEtChart(thirtyDayData);
        renderMoistureChart(defaultData);
      })
      .catch(err => console.error('Chart data load failed:', err));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
