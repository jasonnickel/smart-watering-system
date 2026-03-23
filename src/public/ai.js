// Client-side AI interactions: chat and narrative expansion
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    initChat();
    initNarratives();
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

  // -- Shared ---------------------------------------------------------------

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }
})();
