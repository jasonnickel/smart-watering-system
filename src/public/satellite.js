// Satellite NDVI timeline viewer
// Fetches images from /api/ndvi/image and NDVI stats from /api/ndvi
// Supports week-to-week, month-to-month, and year-to-year comparison
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('satellite-app');
    if (!container) return;
    initSatellite(container);
  });

  function initSatellite(container) {
    var viewSelect = document.getElementById('sat-view');
    var loadBtn = document.getElementById('sat-load');
    var gallery = document.getElementById('sat-gallery');
    var chart = document.getElementById('sat-chart');
    var status = document.getElementById('sat-status');

    if (!loadBtn || !gallery) return;

    loadBtn.addEventListener('click', function () {
      var view = viewSelect ? viewSelect.value : 'month';
      loadTimeline(view, gallery, chart, status, loadBtn);
    });
  }

  function loadTimeline(view, gallery, chart, status, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading satellite imagery...';
    status.textContent = '';
    gallery.innerHTML = '<p class="helper">Fetching satellite images from Copernicus Sentinel-2. This may take 30-60 seconds...</p>';
    chart.innerHTML = '';

    var dates = buildDateList(view);

    // Load NDVI stats in parallel for the chart
    var statsFrom = dates[0];
    var statsTo = dates[dates.length - 1];
    var interval = view === 'week' ? 'P7D' : view === 'month' ? 'P30D' : 'P90D';
    fetch('/api/ndvi?from=' + statsFrom + '&to=' + statsTo + '&interval=' + interval)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.stats && data.stats.length > 0) {
          renderChart(chart, data.stats, view);
        }
      })
      .catch(function () { /* chart is optional */ });

    // Load images sequentially (each is a separate API call)
    var loaded = 0;
    var total = dates.length;
    gallery.innerHTML = '';

    dates.forEach(function (date, index) {
      var card = document.createElement('div');
      card.className = 'sat-card';
      card.innerHTML = '<div class="sat-img-placeholder">Loading ' + date + '...</div><p class="sat-date">' + formatDateLabel(date, view) + '</p>';
      gallery.appendChild(card);

      var img = new Image();
      img.alt = 'NDVI ' + date;
      img.className = 'sat-img';
      img.onload = function () {
        card.querySelector('.sat-img-placeholder').replaceWith(img);
        loaded++;
        status.textContent = loaded + ' of ' + total + ' images loaded';
        if (loaded === total) {
          btn.disabled = false;
          btn.textContent = 'Refresh';
        }
      };
      img.onerror = function () {
        card.querySelector('.sat-img-placeholder').textContent = 'No clear image for ' + date;
        card.querySelector('.sat-img-placeholder').className = 'sat-img-empty';
        loaded++;
        status.textContent = loaded + ' of ' + total + ' images loaded';
        if (loaded === total) {
          btn.disabled = false;
          btn.textContent = 'Refresh';
        }
      };
      // Stagger requests to avoid hammering the API
      setTimeout(function () {
        img.src = '/api/ndvi/image?date=' + date;
      }, index * 800);
    });
  }

  function buildDateList(view) {
    var dates = [];
    var now = new Date();
    var intervalMs;
    var count;

    if (view === 'week') {
      intervalMs = 7 * 86400000;
      count = 12; // 12 weeks back
    } else if (view === 'year') {
      intervalMs = 90 * 86400000; // quarterly snapshots
      count = 8; // 2 years = 8 quarters
    } else {
      // month (default)
      intervalMs = 30 * 86400000;
      count = 12; // 12 months back
    }

    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(now.getTime() - i * intervalMs);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  function formatDateLabel(dateStr, view) {
    var d = new Date(dateStr + 'T12:00:00');
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (view === 'week') {
      return months[d.getMonth()] + ' ' + d.getDate();
    }
    if (view === 'year') {
      return months[d.getMonth()] + ' ' + d.getFullYear();
    }
    return months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function renderChart(container, stats, view) {
    // Simple text-based NDVI trend since we don't have Chart.js on this page
    var html = '<h3>NDVI Trend</h3><div class="sat-trend">';
    stats.forEach(function (s) {
      var pct = Math.max(0, Math.min(100, Math.round(s.mean * 100)));
      var color = s.mean < 0.2 ? 'var(--danger)' : s.mean < 0.4 ? 'var(--warning)' : 'var(--success)';
      var label = s.from ? s.from.slice(5, 10) : '?';
      html += '<div class="sat-trend-bar">';
      html += '<span class="sat-trend-label">' + label + '</span>';
      html += '<div class="meter-track"><div class="meter-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      html += '<span class="sat-trend-value">' + (s.mean ? s.mean.toFixed(2) : '?') + '</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<p class="small">NDVI: 0.0 = bare soil, 0.3 = sparse, 0.5 = moderate, 0.7+ = dense healthy vegetation</p>';
    container.innerHTML = html;
  }
})();
