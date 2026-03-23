// Client-side AI interactions: chat and narrative expansion
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    // -- Secret field toggle (data-action) ------------------------------------
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var field = btn.closest('.secret-field');
      if (!field) return;
      var action = btn.getAttribute('data-action');
      if (action === 'secret-edit') {
        field.classList.add('secret-editing');
        var input = field.querySelector('input');
        if (input) input.focus();
      } else if (action === 'secret-cancel') {
        field.classList.remove('secret-editing');
        var input = field.querySelector('input');
        if (input) input.value = '';
      }
    });

    // -- Confirm dialog on forms (data-confirm) --------------------------------
    document.addEventListener('submit', function (e) {
      var form = e.target.closest('[data-confirm]');
      if (!form) return;
      var message = form.getAttribute('data-confirm');
      if (message && !confirm(message)) {
        e.preventDefault();
      }
    });

    initChat();
    initNarratives();
    initBriefing();
    initLocationLookup();
  });

  // -- Ask Your Yard chat ---------------------------------------------------

  function initChat() {
    var form = document.getElementById('chat-form');
    if (!form) return;

    var input = document.getElementById('chat-input');
    var output = document.getElementById('chat-output');
    var btn = form.querySelector('button[type="submit"]');
    var csrf = form.querySelector('input[name="_csrf"]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var question = input.value.trim();
      if (!question) return;

      btn.disabled = true;
      btn.textContent = 'Thinking...';
      output.innerHTML = '<p class="helper">Asking your yard...</p>';

      var body = new URLSearchParams();
      body.set('question', question);
      if (csrf) body.set('_csrf', csrf.value);

      fetch('/api/ai/chat', { method: 'POST', body: body })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) {
            output.innerHTML = '<p class="helper" style="color:var(--danger)">' + escapeHtml(data.error) + '</p>';
          } else {
            var html = '<div class="chat-answer">' + escapeHtml(data.answer) + '</div>';
            if (data.reasoning) {
              html += '<details class="chat-reasoning"><summary>View reasoning</summary><p class="small">' + escapeHtml(data.reasoning) + '</p></details>';
            }
            output.innerHTML = html;
          }
        })
        .catch(function () {
          output.innerHTML = '<p class="helper" style="color:var(--danger)">Request failed. Check your connection.</p>';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Ask';
        });
    });
  }

  // -- Decision narrative expansion -----------------------------------------

  function initNarratives() {
    var buttons = document.querySelectorAll('[data-narrative-run]');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var runId = btn.getAttribute('data-narrative-run');
        var container = document.getElementById('narrative-' + runId);
        if (!container) return;

        if (container.dataset.loaded === 'true') {
          container.style.display = container.style.display === 'none' ? 'block' : 'none';
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Thinking...';
        container.innerHTML = '<p class="helper">Generating explanation...</p>';
        container.style.display = 'block';

        var csrf = document.querySelector('input[name="_csrf"]');
        var body = new URLSearchParams();
        body.set('run_id', runId);
        if (csrf) body.set('_csrf', csrf.value);

        fetch('/api/ai/narrative', { method: 'POST', body: body })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) {
              container.innerHTML = '<p class="small" style="color:var(--danger)">' + escapeHtml(data.error) + '</p>';
            } else if (data.narrative) {
              var html = '<div class="narrative-text">' + escapeHtml(data.narrative) + '</div>';
              if (data.reasoning) {
                html += '<details><summary class="small">View reasoning</summary><p class="small">' + escapeHtml(data.reasoning) + '</p></details>';
              }
              container.innerHTML = html;
              container.dataset.loaded = 'true';
            } else {
              container.innerHTML = '<p class="small">No narrative available for this entry.</p>';
            }
          })
          .catch(function () {
            container.innerHTML = '<p class="small" style="color:var(--danger)">Request failed.</p>';
          })
          .finally(function () {
            btn.disabled = false;
            btn.textContent = 'Explain';
          });
      });
    });
  }

  // -- Weekly briefing -------------------------------------------------------

  function initBriefing() {
    var btn = document.getElementById('generate-briefing');
    if (!btn) return;

    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Analyzing trends...';
      var output = document.getElementById('briefing-output');
      output.innerHTML = '<p class="helper">Pulling data from all time periods and generating AI analysis. This takes 15-30 seconds...</p>';

      var csrf = document.querySelector('input[name="_csrf"]');
      var body = new URLSearchParams();
      if (csrf) body.set('_csrf', csrf.value);

      fetch('/api/ai/briefing', { method: 'POST', body: body })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            output.innerHTML = '<p class="helper" style="color:var(--danger)">' + escapeHtml(data.error) + '</p>';
            return;
          }
          var html = '';
          if (data.narrative) {
            html += '<div class="chat-answer" style="margin-bottom:16px">' + escapeHtml(data.narrative).replace(/\n/g, '<br>') + '</div>';
          }
          if (data.context) {
            var p = data.context.periods;
            var trend = data.context.weekTrend;
            var arrows = { increasing: '\u25B2', decreasing: '\u25BC', stable: '\u25AC' };
            html += '<div class="card"><h3>Usage Trend ' + (arrows[trend.direction] || '') + ' ' + trend.direction + '</h3>';
            html += '<p>This week: ' + trend.thisWeekGallons.toFixed(0) + ' gal | Last week: ' + trend.lastWeekGallons.toFixed(0) + ' gal</p></div>';
            html += '<div class="table-wrapper"><table><thead><tr><th>Period</th><th>Gallons</th><th>Cost</th><th>Decisions</th><th>Skip %</th><th>Rain</th></tr></thead><tbody>';
            [p.week, p.month, p.quarter, p.season].forEach(function (period) {
              html += '<tr><td>' + period.label + '</td><td>' + period.gallons.toFixed(0) + '</td><td>$' + period.cost.toFixed(2) + '</td><td>' + period.waterDecisions + 'W / ' + period.skipDecisions + 'S</td><td>' + period.skipRate + '%</td><td>' + period.totalRainInches.toFixed(2) + '"</td></tr>';
            });
            html += '</tbody></table></div>';
            var yoy = data.context.yoyComparison;
            if (yoy && yoy.lastYear && yoy.lastYear.totalDecisions > 0) {
              html += '<div class="card"><h3>Year Over Year</h3>';
              html += '<p>Last year same period: ' + yoy.lastYear.gallons.toFixed(0) + ' gal / $' + yoy.lastYear.cost.toFixed(2) + '</p>';
              html += '<p>Delta: ' + (yoy.gallonsDelta > 0 ? '+' : '') + yoy.gallonsDelta.toFixed(0) + ' gal / ' + (yoy.costDelta > 0 ? '+' : '') + '$' + yoy.costDelta.toFixed(2) + '</p></div>';
            }
          }
          if (data.reasoning) {
            html += '<details class="chat-reasoning"><summary>View AI reasoning</summary><p class="small">' + escapeHtml(data.reasoning) + '</p></details>';
          }
          output.innerHTML = html;
        })
        .catch(function () {
          output.innerHTML = '<p class="helper" style="color:var(--danger)">Request failed. Check your connection.</p>';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Generate Briefing Now';
        });
    });
  }

  function initLocationLookup() {
    var button = document.getElementById('location-lookup');
    if (!button) return;

    var address = document.getElementById('location-address');
    var lat = document.getElementById('lat');
    var lon = document.getElementById('lon');
    var timezone = document.getElementById('location-timezone');
    var status = document.getElementById('location-lookup-status');

    button.addEventListener('click', function () {
      var query = address && address.value ? address.value.trim() : '';
      if (query.length < 3) {
        if (status) {
          status.textContent = 'Enter a fuller address or ZIP code first.';
          status.style.color = 'var(--danger)';
        }
        return;
      }

      button.disabled = true;
      button.textContent = 'Looking Up...';
      if (status) {
        status.textContent = 'Searching for the best location match...';
        status.style.color = '';
      }

      fetch('/api/location-search?q=' + encodeURIComponent(query))
        .then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (!result.ok || result.data.error) {
            throw new Error(result.data.error || 'Location lookup failed.');
          }

          var location = result.data.location || {};
          if (lat) lat.value = Number(location.latitude).toFixed(5);
          if (lon) lon.value = Number(location.longitude).toFixed(5);
          if (timezone && location.timezone) timezone.value = location.timezone;

          if (status) {
            status.textContent = 'Matched: ' + (location.displayName || query);
            status.style.color = 'var(--success)';
          }
        })
        .catch(function (err) {
          if (status) {
            status.textContent = err.message || 'Location lookup failed.';
            status.style.color = 'var(--danger)';
          }
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = 'Look Up Address';
        });
    });
  }

  // -- Shared ---------------------------------------------------------------

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }
})();
