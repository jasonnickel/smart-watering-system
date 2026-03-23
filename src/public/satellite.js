// Monthly yard-health timeline
// Renders a sharp orthophoto base image with a monthly vegetation overlay.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('satellite-app');
    if (!container) return;
    initSatellite(container);
  });

  function initSatellite(container) {
    var monthsSelect = document.getElementById('sat-months');
    var opacityInput = document.getElementById('sat-opacity');
    var opacityLabel = document.getElementById('sat-opacity-label');
    var loadBtn = document.getElementById('sat-load');
    var analysis = document.getElementById('sat-analysis');
    var gallery = document.getElementById('sat-gallery');
    var chart = document.getElementById('sat-chart');
    var status = document.getElementById('sat-status');

    if (!loadBtn || !gallery || !chart || !status) return;

    if (opacityInput && opacityLabel) {
      updateOpacityLabel(opacityInput, opacityLabel);
      opacityInput.addEventListener('input', function () {
        updateOpacityLabel(opacityInput, opacityLabel);
        updateOverlayOpacity(opacityInput.value);
      });
    }

    loadBtn.addEventListener('click', function () {
      var months = monthsSelect ? parseInt(monthsSelect.value || '12', 10) : 12;
      var opacity = opacityInput ? parseInt(opacityInput.value || '55', 10) / 100 : 0.55;
      loadMonthlyTimeline(months, opacity, analysis, gallery, chart, status, loadBtn);
    });

    if (!loadBtn.disabled) {
      loadBtn.click();
    }
  }

  function updateOpacityLabel(input, label) {
    label.textContent = input.value + '% overlay strength';
  }

  function updateOverlayOpacity(value) {
    var opacity = Math.max(0.2, Math.min(0.8, parseInt(value || '55', 10) / 100));
    document.querySelectorAll('.sat-overlay').forEach(function (img) {
      img.style.opacity = String(opacity);
    });
  }

  function buildMonthlyRange(months) {
    var now = new Date();
    var end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    var start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1));
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    };
  }

  function loadMonthlyTimeline(months, overlayOpacity, analysis, gallery, chart, status, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading Monthly View...';
    status.textContent = 'Loading base orthophoto and monthly vegetation history...';
    if (analysis) {
      analysis.innerHTML = '<div class="card sat-analysis-card"><h3>Automatic Analysis</h3><p class="helper" style="margin-top:0">Loading a facts-first explanation from the monthly vegetation history...</p></div>';
    }
    gallery.innerHTML = '<p class="helper">Building a monthly yard-health timeline. This can take a little while because each overlay is generated from satellite data.</p>';
    chart.innerHTML = '';

    var range = buildMonthlyRange(months);
    var statsUrl = '/api/satellite/analysis?from=' + encodeURIComponent(range.from)
      + '&to=' + encodeURIComponent(range.to)
      + '&interval=P1M&max_cloud_pct=35';

    fetch(statsUrl).then(function (r) {
      if (!r.ok) throw new Error('Monthly NDVI analysis unavailable');
      return r.json();
    }).then(function (payload) {
      var baseSrc = '/api/ndvi/image?mode=truecolor&size_meters=100&v=monthly-hybrid-v2';
      var stats = (payload.stats || []).slice().sort(function (a, b) {
        return String(a.from).localeCompare(String(b.from));
      }).slice(-months);

      if (stats.length === 0) {
        throw new Error('No monthly vegetation observations were returned');
      }

      renderAnalysis(analysis, payload.analysis, stats.length);
      renderTrend(chart, stats);
      renderGallery(gallery, status, stats, baseSrc, overlayOpacity, btn);
    }).catch(function (err) {
      status.textContent = '';
      if (analysis) {
        analysis.innerHTML = '<div class="notice notice-warning card"><p>' + escapeHtml(err.message || 'Automatic analysis failed to load') + '</p></div>';
      }
      gallery.innerHTML = '<div class="notice notice-warning card"><p>' + escapeHtml(err.message || 'Satellite view failed to load') + '</p></div>';
      btn.disabled = false;
      btn.textContent = 'Retry Monthly View';
    });
  }

  function renderAnalysis(container, analysis, statCount) {
    if (!container || !analysis) return;

    var latest = analysis.latest || null;
    var monthOverMonth = analysis.monthOverMonth || null;
    var overall = analysis.overall || null;
    var strongest = analysis.strongestMonth || null;
    var weakest = analysis.weakestMonth || null;

    var html = '<div class="card sat-analysis-card">';
    html += '<h3>Automatic Analysis</h3>';
    html += '<p class="helper" style="margin-top:0">' + escapeHtml(analysis.headline || 'Monthly analysis unavailable.') + '</p>';

    if (latest) {
      html += '<div class="sat-analysis-grid">';
      html += buildAnalysisMetric(
        latest.monthLabel,
        'Latest month',
        'NDVI ' + latest.mean.toFixed(2),
        latest.categoryLabel,
        latest.tone
      );
      html += buildAnalysisMetric(
        monthOverMonth ? signedDelta(monthOverMonth.delta) : 'n/a',
        'Vs prior month',
        monthOverMonth ? trendLabel(monthOverMonth.direction) : 'Need one more month',
        monthOverMonth ? monthOverMonth.summary : 'Only one usable monthly observation so far',
        monthOverMonth ? toneForDirection(monthOverMonth.direction) : 'neutral'
      );
      html += buildAnalysisMetric(
        overall ? signedDelta(overall.delta) : 'n/a',
        'Timeline change',
        overall ? trendLabel(overall.direction) : 'n/a',
        overall ? overall.summary : 'No timeline comparison available',
        overall ? toneForDirection(overall.direction) : 'neutral'
      );
      html += buildAnalysisMetric(
        strongest ? strongest.mean.toFixed(2) : 'n/a',
        'Best month',
        strongest ? strongest.monthLabel : 'n/a',
        weakest ? 'Weakest: ' + weakest.monthLabel + ' (' + weakest.mean.toFixed(2) + ')' : 'n/a',
        'neutral'
      );
      html += '</div>';
    }

    html += '<div class="sat-analysis-copy">';
    html += '<h4>What The Data Says</h4>';
    html += '<ul class="sat-analysis-list">';
    (analysis.findings || []).forEach(function (line) {
      html += '<li>' + escapeHtml(line) + '</li>';
    });
    html += '</ul>';
    html += '<p class="sat-helper">Built from ' + escapeHtml(String(analysis.observationCount || statCount || 0)) + ' usable monthly observations in the current view.</p>';
    html += '</div>';

    html += '<div class="sat-analysis-columns">';
    html += '<div>';
    html += '<h4>How To Read It</h4>';
    html += '<ul class="sat-analysis-list">';
    (analysis.readingGuide || []).forEach(function (line) {
      html += '<li>' + escapeHtml(line) + '</li>';
    });
    html += '</ul>';
    html += '</div>';
    html += '<div>';
    html += '<h4>Limits</h4>';
    html += '<ul class="sat-analysis-list">';
    (analysis.limitations || []).forEach(function (line) {
      html += '<li>' + escapeHtml(line) + '</li>';
    });
    if (analysis.seasonalityNote) {
      html += '<li>' + escapeHtml(analysis.seasonalityNote) + '</li>';
    }
    html += '</ul>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;
  }

  function buildAnalysisMetric(value, label, title, detail, tone) {
    return '' +
      '<div class="sat-analysis-metric sat-analysis-metric-' + escapeHtml(tone || 'neutral') + '">' +
      '  <p class="sat-analysis-value">' + escapeHtml(String(value || 'n/a')) + '</p>' +
      '  <p class="sat-analysis-label">' + escapeHtml(label || '') + '</p>' +
      '  <p class="sat-analysis-title">' + escapeHtml(title || '') + '</p>' +
      '  <p class="sat-analysis-detail">' + escapeHtml(detail || '') + '</p>' +
      '</div>';
  }

  function renderGallery(gallery, status, stats, baseSrc, overlayOpacity, btn) {
    var resolved = 0;
    var total = stats.length;
    gallery.innerHTML = '';

    stats.forEach(function (entry, index) {
      var card = document.createElement('article');
      card.className = 'sat-card';

      var delta = index > 0 && Number.isFinite(stats[index - 1].mean)
        ? entry.mean - stats[index - 1].mean
        : null;
      var deltaText = delta == null ? 'First month in timeline'
        : (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' vs previous';

      card.innerHTML = '' +
        '<div class="sat-stack">' +
        '  <div class="sat-img-placeholder">Loading ' + escapeHtml(monthYearLabel(entry.to || entry.from)) + '...</div>' +
        '</div>' +
        '<div class="sat-card-body">' +
        '  <p class="sat-date">' + escapeHtml(monthYearLabel(entry.to || entry.from)) + '</p>' +
        '  <p class="sat-metric">NDVI ' + (entry.mean != null ? entry.mean.toFixed(2) : '?') + '</p>' +
        '  <p class="sat-helper">' + escapeHtml(deltaText) + '</p>' +
        '</div>';

      gallery.appendChild(card);

      var stack = card.querySelector('.sat-stack');
      var placeholder = card.querySelector('.sat-img-placeholder');

      var baseImg = new Image();
      baseImg.alt = 'Base orthophoto for yard alignment';
      baseImg.className = 'sat-img sat-base';
      baseImg.src = baseSrc;

      var overlayImg = new Image();
      overlayImg.alt = 'Monthly vegetation overlay for ' + monthYearLabel(entry.to || entry.from);
      overlayImg.className = 'sat-img sat-overlay';
      overlayImg.style.opacity = String(overlayOpacity);
      overlayImg.src = '/api/ndvi/image?mode=overlay'
        + '&date=' + encodeURIComponent((entry.to || '').slice(0, 10))
        + '&size_meters=100'
        + '&v=monthly-hybrid-v1';

      var baseReady = false;
      var overlayResolved = false;

      function finishCard(message, tone) {
        if (!overlayResolved || !baseReady) return;
        if (placeholder && placeholder.parentNode) {
          placeholder.remove();
        }
        if (message) {
          var note = document.createElement('div');
          note.className = 'sat-overlay-note sat-overlay-note-' + tone;
          note.textContent = message;
          stack.appendChild(note);
        }
        resolved++;
        status.textContent = resolved + ' of ' + total + ' months loaded';
        if (resolved === total) {
          btn.disabled = false;
          btn.textContent = 'Refresh Monthly View';
        }
      }

      baseImg.onload = function () {
        if (!stack.contains(baseImg)) stack.appendChild(baseImg);
        baseReady = true;
        finishCard('', 'info');
      };
      baseImg.onerror = function () {
        if (placeholder) {
          placeholder.textContent = 'Base orthophoto failed to load';
          placeholder.className = 'sat-img-empty';
        }
        baseReady = false;
        overlayResolved = true;
        resolved++;
        status.textContent = resolved + ' of ' + total + ' months loaded';
        if (resolved === total) {
          btn.disabled = false;
          btn.textContent = 'Refresh Monthly View';
        }
      };

      overlayImg.onload = function () {
        if (!stack.contains(overlayImg)) stack.appendChild(overlayImg);
        overlayResolved = true;
        finishCard('', 'info');
      };
      overlayImg.onerror = function () {
        overlayResolved = true;
        finishCard('No usable monthly vegetation overlay', 'muted');
      };
    });
  }

  function renderTrend(container, stats) {
    var latest = stats[stats.length - 1];
    var previous = stats.length > 1 ? stats[stats.length - 2] : null;
    var summary = latest && previous && previous.mean
      ? ((latest.mean - previous.mean) >= 0 ? 'Up ' : 'Down ') + Math.abs(latest.mean - previous.mean).toFixed(2) + ' from last month'
      : 'Building first monthly baseline';

    var html = '<div class="sat-summary card">';
    html += '<h3>Monthly Health Trend</h3>';
    html += '<p class="helper" style="margin-top:0">Latest month: <strong>' + (latest.mean != null ? latest.mean.toFixed(2) : '?') + '</strong>. ' + escapeHtml(summary) + '.</p>';
    html += '<div class="sat-trend">';
    stats.forEach(function (s, index) {
      var pct = Math.max(0, Math.min(100, Math.round((s.mean || 0) * 100)));
      var color = s.mean < 0.2 ? 'var(--danger)' : s.mean < 0.4 ? 'var(--warning)' : 'var(--success)';
      var delta = index > 0 && Number.isFinite(stats[index - 1].mean) ? s.mean - stats[index - 1].mean : null;
      var deltaLabel = delta == null ? '' : ' <span class="sat-delta ' + (delta >= 0 ? 'sat-delta-up' : 'sat-delta-down') + '">' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + '</span>';
      html += '<div class="sat-trend-bar">';
      html += '<span class="sat-trend-label">' + escapeHtml(monthYearLabel(s.to || s.from)) + '</span>';
      html += '<div class="meter-track"><div class="meter-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      html += '<span class="sat-trend-value">' + (s.mean != null ? s.mean.toFixed(2) : '?') + deltaLabel + '</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<p class="small">Monthly values are based on calendar-month Sentinel vegetation signal, aligned visually to the same high-resolution yard image each month.</p>';
    html += '</div>';
    container.innerHTML = html;
  }

  function monthYearLabel(dateStr) {
    var d = new Date((dateStr || '').slice(0, 10) + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return 'Unknown';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function signedDelta(value) {
    return (value >= 0 ? '+' : '') + value.toFixed(2);
  }

  function trendLabel(direction) {
    if (direction === 'up') return 'Improving';
    if (direction === 'down') return 'Weakening';
    return 'Mostly steady';
  }

  function toneForDirection(direction) {
    if (direction === 'up') return 'success';
    if (direction === 'down') return 'warning';
    return 'neutral';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
