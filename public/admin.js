(function () {
  "use strict";

  var root = document.getElementById("admin-app");
  var toastNode = document.getElementById("admin-toast");
  var modalRoot = document.getElementById("admin-modal-root");
  var state = {
    authenticated: false,
    overview: null,
    questions: [],
    tab: ["overview", "questions", "results"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview",
    questionQuery: "",
    questionStatus: "all",
    resultQuery: "",
    resultStatus: "all",
    editor: null,
    toastTimer: null,
    polling: false
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function safeNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function formatTime(seconds) {
    if (seconds == null) return "—";
    var safe = Math.max(0, Math.ceil(Number(seconds) || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var remainder = safe % 60;
    return [hours, minutes, remainder].map(function (part) { return String(part).padStart(2, "0"); }).join(":");
  }

  function notify(message, isError) {
    clearTimeout(state.toastTimer);
    toastNode.textContent = message;
    toastNode.className = "toast show" + (isError ? " error" : "");
    state.toastTimer = setTimeout(function () { toastNode.className = "toast"; }, 3900);
  }

  async function api(url, method, body) {
    var response = await fetch(url, {
      method: method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function brand() {
    return '<a class="brand" href="/admin" aria-label="Admin console home">' +
      '<span class="brand-symbol" aria-hidden="true"><span></span><span></span><span></span><span></span></span>' +
      '<span><strong>Technology Operations</strong><small>Admin console</small></span></a>';
  }

  function statusText(status) {
    return {
      waiting: "Waiting",
      open: "Open",
      paused: "Paused",
      closed: "Closed",
      registered: "Registered",
      active: "In progress",
      submitted: "Submitted",
      expired: "Time ended",
      finished_by_admin: "Admin finished"
    }[status] || status || "Unknown";
  }

  function statusPill(status) {
    return '<span class="status-pill ' + escapeHtml(status) + '">' + escapeHtml(statusText(status)) + '</span>';
  }

  function resultBadge(status) {
    var kind = status === "submitted" ? "success" : status === "expired" || status === "finished_by_admin" ? "warning" : "";
    return '<span class="mini-badge ' + kind + '">' + escapeHtml(statusText(status)) + '</span>';
  }

  function scoreCell(result) {
    if (result.score == null || result.questionCount == null || result.percentage == null) return '<span class="muted">—</span>';
    var scoreClass = result.pass === true ? "pass" : result.pass === false ? "fail" : "";
    return '<span class="result-score ' + scoreClass + '">' + escapeHtml(result.score) + '/' + escapeHtml(result.questionCount) +
      ' <span class="table-sub">' + escapeHtml(result.percentage) + '% · ' + (result.pass === true ? "Pass" : result.pass === false ? "Below pass mark" : "Scored") + '</span></span>';
  }

  function renderLogin() {
    state.authenticated = false;
    modalRoot.replaceChildren();
    root.innerHTML = '<div class="admin-login">' +
      '<section class="admin-login-info"><div>' + brand() + '</div>' +
      '<div><p class="eyebrow eyebrow-light">Assessment operations</p><h1>Run a fair, focused exam.</h1>' +
      '<p>Control the assessment window, manage the question bank and review applicant results from one place.</p></div>' +
      '<div class="tiny">Restricted access · Administrator credentials required</div></section>' +
      '<section class="admin-login-form-wrap"><form id="admin-login-form" class="admin-login-form">' +
      '<p class="panel-kicker">Administrator access</p><h2>Welcome back.</h2>' +
      '<p>Enter the password configured when the exam server was started.</p>' +
      '<div class="field"><label for="admin-password">Admin password</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required autofocus></div>' +
      '<button class="btn btn-block" type="submit">Sign in to console →</button>' +
      '<p class="fine-print">Applicant exam: <a href="/exam">/exam</a><br>Admin console: <a href="/admin">/admin</a></p>' +
      '</form></section></div>';
    document.getElementById("admin-login-form").addEventListener("submit", login);
    document.getElementById("admin-password").focus();
  }

  async function login(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var password = form.elements.password.value;
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      await api("/api/admin/login", "POST", { password: password });
      form.elements.password.value = "";
      await loadDashboard();
    } catch (error) {
      notify(error.message, true);
      button.disabled = false;
      button.textContent = "Sign in to console →";
    }
  }

  async function logout() {
    try {
      await api("/api/admin/logout", "POST", {});
    } catch (error) {
      notify(error.message, true);
    }
    state.overview = null;
    state.questions = [];
    renderLogin();
  }

  async function loadDashboard() {
    try {
      var overview = await api("/api/admin/overview");
      var questions = await api("/api/admin/questions");
      state.overview = overview;
      state.questions = questions.questions || [];
      state.authenticated = true;
      renderShell();
    } catch (error) {
      if (error.status === 401 || error.status === 403) renderLogin();
      else {
        root.innerHTML = '<div class="loading-state"><h2>Unable to load the admin console.</h2><p>' + escapeHtml(error.message) + '</p><button id="admin-retry" class="btn" type="button">Try again</button></div>';
        document.getElementById("admin-retry").addEventListener("click", loadDashboard);
      }
    }
  }

  function renderShell() {
    root.innerHTML = '<div class="admin-shell">' +
      '<aside class="admin-sidebar">' + brand() +
      '<p class="nav-caption">Workspace</p>' +
      '<nav class="admin-nav" aria-label="Admin sections">' +
      '<button type="button" data-tab="overview"><span class="nav-icon" aria-hidden="true">▦</span> Overview</button>' +
      '<button type="button" data-tab="questions"><span class="nav-icon" aria-hidden="true">◫</span> Question bank</button>' +
      '<button type="button" data-tab="results"><span class="nav-icon" aria-hidden="true">▤</span> Results</button>' +
      '</nav><div class="sidebar-footer"><strong>Candidate access</strong>Share the <a href="/exam">/exam</a> link with applicants.</div></aside>' +
      '<div class="admin-workspace"><header class="admin-topbar"><div class="breadcrumb">Admin console / <strong id="admin-breadcrumb">Overview</strong></div>' +
      '<div class="button-row"><a class="btn btn-quiet btn-small" href="/exam" target="_blank" rel="noopener">Candidate view ↗</a>' +
      '<button id="admin-signout" class="btn btn-secondary btn-small" type="button">Sign out</button></div></header>' +
      '<main id="admin-content" class="admin-content"></main></div></div>';
    root.querySelectorAll("[data-tab]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.tab = button.dataset.tab;
        location.hash = state.tab;
        renderCurrentTab();
      });
    });
    document.getElementById("admin-signout").addEventListener("click", logout);
    renderCurrentTab();
  }

  function renderCurrentTab() {
    var labels = { overview: "Overview", questions: "Question bank", results: "Results" };
    var breadcrumb = document.getElementById("admin-breadcrumb");
    if (!breadcrumb) return;
    breadcrumb.textContent = labels[state.tab];
    root.querySelectorAll("[data-tab]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.tab === state.tab);
      if (button.dataset.tab === state.tab) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (state.tab === "questions") renderQuestions();
    else if (state.tab === "results") renderResults();
    else renderOverview();
  }

  function metric(label, number, note) {
    return '<div class="stat-card"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(number) + '</strong><small>' + escapeHtml(note) + '</small></div>';
  }

  function controlButtons(status) {
    var buttons = [];
    if (status === "waiting") buttons.push('<button class="btn" data-control="open" type="button">Start exam</button>');
    if (status === "closed") buttons.push('<button class="btn" data-control="open" type="button">Reopen exam</button>');
    if (status === "open") buttons.push('<button class="btn btn-secondary" data-control="pause" type="button">Pause timer</button>');
    if (status === "paused") buttons.push('<button class="btn" data-control="resume" type="button">Resume timer</button>');
    if (status === "open" || status === "paused") buttons.push('<button class="btn btn-danger" data-control="finish" type="button">Finish exam</button>');
    return buttons.join("");
  }

  function resultRows(results, limit) {
    var items = limit ? results.slice(0, limit) : results;
    if (!items.length) {
      return '<tr><td colspan="7"><div class="empty-state"><strong>No applicants yet</strong>Results will appear here after candidates register.</div></td></tr>';
    }
    return items.map(function (result) {
      return '<tr><td><span class="table-name">' + escapeHtml(result.name) + '</span><span class="table-sub">IC ' + escapeHtml(result.ic || "—") + '</span></td>' +
        '<td>' + resultBadge(result.status) + '</td>' +
        '<td>' + scoreCell(result) + '</td>' +
        '<td class="nowrap">' + escapeHtml(formatDate(result.startedAtUtc)) + '</td>' +
        '<td class="nowrap">' + escapeHtml(formatDate(result.submittedAtUtc)) + '</td>' +
        '<td class="nowrap">' + escapeHtml(result.status === "active" ? formatTime(result.secondsRemaining) : "—") + '</td>' +
        '<td><button class="table-action" type="button" data-result="' + escapeHtml(result.id) + '">View details →</button></td></tr>';
    }).join("");
  }

  function resultsTable(results, limit) {
    return '<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Status</th><th>Score</th><th>Started</th><th>Submitted</th><th>Time left</th><th></th></tr></thead>' +
      '<tbody>' + resultRows(results, limit) + '</tbody></table></div>';
  }

  function bindResultButtons(scope) {
    scope.querySelectorAll("[data-result]").forEach(function (button) {
      button.addEventListener("click", function () { openResultDetail(button.dataset.result); });
    });
  }

  function renderOverview() {
    var overview = state.overview || {};
    var status = overview.status || "waiting";
    var results = overview.results || [];
    var activeCandidates = results.filter(function (result) { return result.status === "active"; });
    var duration = Math.round(safeNumber(overview.durationSeconds, 3600) / 60);
    var content = document.getElementById("admin-content");
    content.innerHTML = '<div class="admin-page-title"><div><p class="eyebrow">Administration</p><h1>Exam overview</h1>' +
      '<p>Monitor applicants and manage the current assessment session.</p></div>' + statusPill(status) + '</div>' +
      '<div class="stat-grid">' +
      metric("Total registered", results.length, "All applicant records") +
      metric("Waiting", overview.waitingCount || 0, "Registered, not started") +
      metric("In progress", overview.activeCount || 0, "Timers currently running") +
      metric("Completed", overview.submittedCount || 0, "Submitted or ended") +
      '</div>' +
      '<div class="admin-two-col">' +
      '<section class="admin-card"><div class="card-heading"><div><h2>Session controls</h2>' +
      '<p>Open the exam, pause all active timers, or finish the session.</p></div>' + statusPill(status) + '</div>' +
      '<div id="control-buttons" class="control-buttons">' + controlButtons(status) + '</div>' +
      '<p class="control-explainer">Each applicant gets the configured duration when they select Begin assessment. Finishing submits saved answers for all active applicants.</p></section>' +
      '<section class="admin-card"><div class="card-heading"><div><h2>Timer and scoring</h2><p>Changes to duration also adjust active timers.</p></div></div>' +
      '<form id="settings-form"><div class="settings-grid">' +
      '<div class="field"><label for="duration-minutes">Duration (minutes)</label><input id="duration-minutes" name="duration" type="number" min="1" max="180" step="1" value="' + escapeHtml(duration) + '" required></div>' +
      '<div class="field"><label for="pass-percent">Pass mark (%)</label><input id="pass-percent" name="pass" type="number" min="0" max="100" step="1" value="' + escapeHtml(overview.passPercent == null ? 65 : overview.passPercent) + '" required></div>' +
      '</div><div class="button-row"><button class="btn btn-small" type="submit">Save settings</button></div></form>' +
      '<div class="card-subsection"><h3>Adjust remaining time</h3><form id="adjust-time-form">' +
      '<div class="time-adjust-row"><div class="field"><label for="adjust-minutes">Minutes (+ / −)</label><input id="adjust-minutes" name="minutes" type="number" min="-180" max="180" step="1" placeholder="+10" required></div>' +
      '<div class="field"><label for="adjust-target">Apply to</label><select id="adjust-target" name="target"><option value="all">All active applicants</option><option value="candidate">One applicant</option></select></div>' +
      '<button class="btn btn-secondary btn-small" type="submit">Apply</button></div>' +
      '<div id="candidate-target-field" class="field candidate-target-field" hidden><label for="candidate-target">Applicant</label><select id="candidate-target" name="candidate">' +
      activeCandidates.map(function (candidate) {
        return '<option value="' + escapeHtml(candidate.id) + '">' + escapeHtml(candidate.name) + ' · ' + escapeHtml(candidate.ic) + '</option>';
      }).join("") + '</select></div></form></div></section>' +
      '</div>' +
      '<section class="admin-card"><div class="card-heading"><div><h2>Recent applicants</h2><p>Latest registrations and assessment activity.</p></div>' +
      '<button id="view-all-results" class="btn btn-quiet btn-small" type="button">View all results →</button></div>' +
      resultsTable(results, 6) + '</section>' +
      '<div class="notice admin-note"><span><strong>Browser protection limits</strong>Clipboard, text selection and printing are restricted in the applicant portal, and exam screens are watermarked. Operating system screenshots and snipping cannot be fully blocked by a standard web page; use a managed lockdown environment if capture prevention is mandatory.</span></div>';
    content.querySelectorAll("[data-control]").forEach(function (button) {
      button.addEventListener("click", function () { requestControl(button.dataset.control); });
    });
    document.getElementById("settings-form").addEventListener("submit", saveSettings);
    document.getElementById("adjust-time-form").addEventListener("submit", adjustTime);
    document.getElementById("adjust-target").addEventListener("change", function (event) {
      document.getElementById("candidate-target-field").hidden = event.target.value !== "candidate";
    });
    document.getElementById("view-all-results").addEventListener("click", function () {
      state.tab = "results";
      location.hash = "results";
      renderCurrentTab();
    });
    bindResultButtons(content);
  }

  function closeModal() {
    modalRoot.replaceChildren();
    state.editor = null;
  }

  function confirmation(title, message, actionLabel, onConfirm) {
    modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">' +
      '<div class="modal-header"><h2 id="confirm-title">' + escapeHtml(title) + '</h2><button id="modal-close" class="icon-button" type="button" aria-label="Close">×</button></div>' +
      '<p>' + escapeHtml(message) + '</p><div class="modal-actions"><button id="modal-cancel" class="btn btn-secondary" type="button">Cancel</button>' +
      '<button id="modal-confirm" class="btn btn-danger" type="button">' + escapeHtml(actionLabel) + '</button></div></div></div>';
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal-cancel").addEventListener("click", closeModal);
    document.getElementById("modal-confirm").addEventListener("click", onConfirm);
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", function (event) {
      if (event.target === event.currentTarget) closeModal();
    });
    document.getElementById("modal-confirm").focus();
  }

  function requestControl(action) {
    if (action === "finish") {
      confirmation("Finish this exam session?", "All active applicants will have their saved answers submitted now. This action ends their attempts.", "Finish exam", function () {
        runControl(action);
      });
    } else runControl(action);
  }

  async function runControl(action) {
    var button = document.getElementById("modal-confirm");
    if (button) button.disabled = true;
    try {
      await api("/api/admin/control", "POST", { action: action });
      closeModal();
      await refreshOverview(true);
      notify({ open: "Exam is open.", pause: "All active timers are paused.", resume: "Timers resumed.", finish: "Exam session finished." }[action] || "Session updated.");
    } catch (error) {
      notify(error.message, true);
      if (button) button.disabled = false;
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var duration = Number(form.elements.duration.value);
    var passPercent = Number(form.elements.pass.value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 180 || !Number.isInteger(passPercent) || passPercent < 0 || passPercent > 100) {
      notify("Enter a duration from 1 to 180 minutes and a pass mark from 0 to 100%.", true);
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/admin/settings", "PUT", { durationMinutes: duration, passPercent: passPercent });
      await refreshOverview(true);
      notify("Timer and pass mark saved.");
    } catch (error) {
      notify(error.message, true);
      button.disabled = false;
    }
  }

  async function adjustTime(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var minutes = Number(form.elements.minutes.value);
    var target = form.elements.target.value;
    var candidateId = form.elements.candidate.value;
    if (!Number.isInteger(minutes) || !minutes || minutes < -180 || minutes > 180) {
      notify("Enter a nonzero whole number of minutes between −180 and 180.", true);
      return;
    }
    if (target === "candidate" && !candidateId) {
      notify("Select an active applicant.", true);
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    var body = { minutes: minutes };
    if (target === "candidate") body.candidateId = candidateId;
    try {
      await api("/api/admin/timer/adjust", "POST", body);
      await refreshOverview(true);
      notify("Remaining time adjusted.");
    } catch (error) {
      notify(error.message, true);
      button.disabled = false;
    }
  }

  function filteredQuestions() {
    var query = state.questionQuery.trim().toLowerCase();
    return state.questions.filter(function (question) {
      if (state.questionStatus === "enabled" && !question.enabled) return false;
      if (state.questionStatus === "disabled" && question.enabled) return false;
      return !query || [question.text, question.section].some(function (value) {
        return String(value || "").toLowerCase().includes(query);
      });
    });
  }

  function questionItems() {
    var filtered = filteredQuestions();
    if (!filtered.length) return '<div class="empty-state"><strong>No matching questions</strong>Change the search or add a new question.</div>';
    return filtered.map(function (question, index) {
      var keyKnown = question.correctIndex != null && Number(question.correctIndex) >= 0 && Number(question.correctIndex) < (question.options || []).length;
      return '<article class="bank-item' + (question.enabled ? "" : " off") + '"><div>' +
        '<div class="bank-meta"><span class="mini-badge">' + escapeHtml(question.section || "General") + '</span>' +
        '<span class="mini-badge ' + (question.enabled ? "success" : "") + '">' + (question.enabled ? "Enabled" : "Disabled") + '</span>' +
        '<span class="mini-badge ' + (keyKnown ? "success" : "warning") + '">' + (keyKnown ? "Key: " + String.fromCharCode(65 + Number(question.correctIndex)) : "Answer key needed") + '</span></div>' +
        '<h3>' + escapeHtml(question.text) + '</h3><span class="muted tiny">' + escapeHtml((question.options || []).length) + ' answer options</span>' +
        '</div><button class="btn btn-secondary btn-small" type="button" data-edit-question="' + escapeHtml(question.id) + '">Edit</button></article>';
    }).join("");
  }

  function renderQuestions() {
    var content = document.getElementById("admin-content");
    content.innerHTML = '<div class="admin-page-title"><div><p class="eyebrow">Assessment content</p><h1>Question bank</h1>' +
      '<p>Edit the questions candidates will see when they start a new attempt.</p></div>' +
      '<button id="add-question" class="btn" type="button">+ Add question</button></div>' +
      '<div class="toolbar"><input id="question-search" class="input" type="search" placeholder="Search questions or sections" aria-label="Search questions" value="' + escapeHtml(state.questionQuery) + '">' +
      '<select id="question-status-filter" class="input" aria-label="Filter questions by status">' +
      '<option value="all">All questions</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>' +
      '<span id="question-count" class="toolbar-count"></span></div>' +
      '<div id="question-bank-list" class="question-bank-list"></div>' +
      '<div class="notice admin-note"><span>Editing a question changes future attempts. Applicants already in progress keep the question version they started with.</span></div>';
    document.getElementById("question-status-filter").value = state.questionStatus;
    document.getElementById("question-search").addEventListener("input", function (event) {
      state.questionQuery = event.target.value;
      updateQuestionList();
    });
    document.getElementById("question-status-filter").addEventListener("change", function (event) {
      state.questionStatus = event.target.value;
      updateQuestionList();
    });
    document.getElementById("add-question").addEventListener("click", function () { openQuestionEditor(null); });
    updateQuestionList();
  }

  function updateQuestionList() {
    var list = document.getElementById("question-bank-list");
    if (!list) return;
    list.innerHTML = questionItems();
    var count = filteredQuestions().length;
    document.getElementById("question-count").textContent = count + " of " + state.questions.length + " questions";
    list.querySelectorAll("[data-edit-question]").forEach(function (button) {
      button.addEventListener("click", function () {
        var question = state.questions.find(function (item) { return item.id === button.dataset.editQuestion; });
        if (question) openQuestionEditor(question);
      });
    });
  }

  function syncEditor() {
    var form = document.getElementById("question-editor-form");
    if (!form || !state.editor) return;
    state.editor.section = form.elements.section.value;
    state.editor.text = form.elements.text.value;
    state.editor.options = Array.from(form.querySelectorAll("[data-option-input]")).map(function (input) { return input.value; });
    state.editor.correctIndex = Number(form.elements.correctIndex.value);
    state.editor.enabled = form.elements.enabled.checked;
  }

  function optionEditorRows() {
    return state.editor.options.map(function (option, index) {
      return '<div class="option-editor-row"><span>' + String.fromCharCode(65 + index) + '</span>' +
        '<input class="input" data-option-input="' + index + '" type="text" maxlength="1000" aria-label="Option ' + String.fromCharCode(65 + index) + '" value="' + escapeHtml(option) + '" required>' +
        '<button class="icon-button" data-remove-option="' + index + '" type="button" aria-label="Remove option ' + String.fromCharCode(65 + index) + '"' + (state.editor.options.length <= 2 ? " disabled" : "") + '>×</button></div>';
    }).join("");
  }

  function renderEditor() {
    var editor = state.editor;
    if (!editor) return;
    var answerOptions = editor.options.map(function (_, index) {
      return '<option value="' + index + '">' + String.fromCharCode(65 + index) + ' · Option ' + String.fromCharCode(65 + index) + '</option>';
    }).join("");
    modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="editor-title">' +
      '<div class="modal-header"><div><p class="panel-kicker">Question bank</p><h2 id="editor-title">' + (editor.id ? "Edit question" : "Add question") + '</h2></div>' +
      '<button id="close-editor" class="icon-button" type="button" aria-label="Close editor">×</button></div>' +
      '<form id="question-editor-form">' +
      '<div class="field"><label for="editor-section">Section or topic</label><input id="editor-section" name="section" type="text" maxlength="100" value="' + escapeHtml(editor.section) + '" placeholder="e.g. Service management" required></div>' +
      '<div class="field"><label for="editor-text">Question</label><textarea id="editor-text" name="text" maxlength="3000" placeholder="Write a clear multiple-choice question" required>' + escapeHtml(editor.text) + '</textarea></div>' +
      '<div class="field"><span class="field-label">Answer options</span><div id="option-editor-list" class="option-editor-list">' + optionEditorRows() + '</div>' +
      '<button id="add-option" class="btn btn-quiet btn-small" type="button"' + (editor.options.length >= 6 ? " disabled" : "") + '>+ Add option</button><span class="field-help">Use 2 to 6 options. Select the correct answer below.</span></div>' +
      '<div class="field"><label for="editor-correct">Correct answer</label><select id="editor-correct" name="correctIndex">' +
      '<option value="-1">Select an answer key</option>' + answerOptions + '</select></div>' +
      '<label class="toggle-row"><input id="editor-enabled" name="enabled" type="checkbox"' + (editor.enabled ? " checked" : "") + '><span><strong>Enabled for new attempts</strong><small>Disabled questions stay in the bank and are not shown to new candidates.</small></span></label>' +
      '<div class="modal-actions"><button id="cancel-editor" class="btn btn-secondary" type="button">Cancel</button><button id="save-editor" class="btn" type="submit">Save question</button></div>' +
      '</form></div></div>';
    document.getElementById("editor-correct").value = String(editor.correctIndex);
    document.getElementById("close-editor").addEventListener("click", closeModal);
    document.getElementById("cancel-editor").addEventListener("click", closeModal);
    document.getElementById("add-option").addEventListener("click", function () {
      syncEditor();
      if (state.editor.options.length < 6) state.editor.options.push("");
      renderEditor();
    });
    modalRoot.querySelectorAll("[data-remove-option]").forEach(function (button) {
      button.addEventListener("click", function () {
        syncEditor();
        var index = Number(button.dataset.removeOption);
        if (state.editor.options.length <= 2) return;
        state.editor.options.splice(index, 1);
        if (state.editor.correctIndex === index) state.editor.correctIndex = -1;
        else if (state.editor.correctIndex > index) state.editor.correctIndex -= 1;
        renderEditor();
      });
    });
    document.getElementById("question-editor-form").addEventListener("submit", saveQuestion);
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", function (event) {
      if (event.target === event.currentTarget) closeModal();
    });
    document.getElementById("editor-text").focus();
  }

  function openQuestionEditor(question) {
    state.editor = question ? {
      id: question.id,
      section: question.section || "",
      text: question.text || "",
      options: (question.options || []).slice(),
      correctIndex: question.correctIndex != null && Number.isInteger(Number(question.correctIndex)) ? Number(question.correctIndex) : -1,
      enabled: !!question.enabled
    } : {
      id: null,
      section: "",
      text: "",
      options: ["", "", "", ""],
      correctIndex: -1,
      enabled: true
    };
    if (state.editor.options.length < 2) state.editor.options = ["", ""];
    renderEditor();
  }

  async function saveQuestion(event) {
    event.preventDefault();
    syncEditor();
    var editor = state.editor;
    var section = editor.section.trim();
    var text = editor.text.trim();
    var options = editor.options.map(function (option) { return option.trim(); });
    if (!section || !text || options.length < 2 || options.length > 6 || options.some(function (option) { return !option; })) {
      notify("Enter a section, question and 2 to 6 nonempty options.", true);
      return;
    }
    if (editor.enabled && (editor.correctIndex < 0 || editor.correctIndex >= options.length)) {
      notify("Select the correct answer before enabling this question.", true);
      return;
    }
    var button = document.getElementById("save-editor");
    button.disabled = true;
    button.textContent = "Saving…";
    var body = { section: section, text: text, options: options, correctIndex: editor.correctIndex < 0 ? null : editor.correctIndex, enabled: editor.enabled };
    try {
      await api(editor.id ? "/api/admin/questions/" + encodeURIComponent(editor.id) : "/api/admin/questions", editor.id ? "PUT" : "POST", body);
      closeModal();
      var questions = await api("/api/admin/questions");
      state.questions = questions.questions || [];
      await refreshOverview(false);
      renderCurrentTab();
      notify("Question saved.");
    } catch (error) {
      notify(error.message, true);
      button.disabled = false;
      button.textContent = "Save question";
    }
  }

  function filteredResults() {
    var results = (state.overview && state.overview.results) || [];
    var query = state.resultQuery.trim().toLowerCase();
    return results.filter(function (result) {
      if (state.resultStatus !== "all" && result.status !== state.resultStatus) return false;
      return !query || [result.name, result.ic].some(function (value) {
        return String(value || "").toLowerCase().includes(query);
      });
    });
  }

  function renderResults() {
    var content = document.getElementById("admin-content");
    content.innerHTML = '<div class="admin-page-title"><div><p class="eyebrow">Candidate outcomes</p><h1>Results</h1>' +
      '<p>Review candidate scores and answer details.</p></div>' +
      '<button id="refresh-results" class="btn btn-secondary btn-small" type="button">↻ Refresh</button></div>' +
      '<div class="toolbar"><input id="result-search" class="input" type="search" placeholder="Search name or IC" aria-label="Search candidates" value="' + escapeHtml(state.resultQuery) + '">' +
      '<select id="result-status-filter" class="input" aria-label="Filter results by status">' +
      '<option value="all">All statuses</option><option value="registered">Registered</option><option value="active">In progress</option>' +
      '<option value="submitted">Submitted</option><option value="expired">Time ended</option><option value="finished_by_admin">Admin finished</option></select>' +
      '<span id="result-count" class="toolbar-count"></span></div>' +
      '<section class="admin-card"><div id="result-table"></div></section>';
    document.getElementById("result-status-filter").value = state.resultStatus;
    document.getElementById("result-search").addEventListener("input", function (event) {
      state.resultQuery = event.target.value;
      updateResultsTable();
    });
    document.getElementById("result-status-filter").addEventListener("change", function (event) {
      state.resultStatus = event.target.value;
      updateResultsTable();
    });
    document.getElementById("refresh-results").addEventListener("click", function () { refreshOverview(true); });
    updateResultsTable();
  }

  function updateResultsTable() {
    var node = document.getElementById("result-table");
    if (!node) return;
    var filtered = filteredResults();
    node.innerHTML = resultsTable(filtered);
    document.getElementById("result-count").textContent = filtered.length + " applicants";
    bindResultButtons(node);
  }

  async function openResultDetail(id) {
    modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Candidate result">' +
      '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading result…</p></div></div></div>';
    try {
      var detail = await api("/api/admin/results/" + encodeURIComponent(id));
      var attempt = detail.attempt || {};
      var answers = detail.answers || [];
      var review = answers.length ? answers.map(function (answer, index) {
        var hasSelection = answer.selectedIndex != null && Number(answer.selectedIndex) >= 0;
        var hasKey = answer.correctIndex != null && Number(answer.correctIndex) >= 0;
        var selected = hasSelection ? String.fromCharCode(65 + Number(answer.selectedIndex)) + " · " + (answer.options || [])[Number(answer.selectedIndex)] : "Not answered";
        var correct = hasKey ? String.fromCharCode(65 + Number(answer.correctIndex)) + " · " + (answer.options || [])[Number(answer.correctIndex)] : "Answer key unavailable";
        var kind = !hasKey ? "" : answer.correct ? "correct" : "incorrect";
        var label = !hasKey ? "Ungraded" : answer.correct ? "Correct" : hasSelection ? "Incorrect" : "Not answered";
        return '<article class="review-item ' + kind + '"><div class="bank-meta"><span class="mini-badge">' + (index + 1) + '</span>' +
          '<span class="mini-badge ' + (answer.correct ? "success" : hasKey ? "danger" : "warning") + '">' + label + '</span>' +
          '<span class="mini-badge">' + escapeHtml(answer.section || "General") + '</span></div>' +
          '<h3>' + escapeHtml(answer.text) + '</h3>' +
          '<p class="answer-line"><strong>Candidate:</strong> ' + escapeHtml(selected) + '</p>' +
          '<p class="answer-line"><strong>Correct:</strong> ' + escapeHtml(correct) + '</p></article>';
      }).join("") : '<div class="empty-state"><strong>No answers yet</strong>This applicant has not started the exam.</div>';
      modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="result-detail-title">' +
        '<div class="modal-header"><div><p class="panel-kicker">Candidate result</p><h2 id="result-detail-title">' + escapeHtml(attempt.name || "Applicant") + '</h2>' +
        '<p class="muted small">IC ' + escapeHtml(attempt.ic || "—") + '</p></div><button id="close-result" class="icon-button" type="button" aria-label="Close result">×</button></div>' +
        '<div class="detail-summary"><div><span>Status</span><strong>' + escapeHtml(statusText(attempt.status)) + '</strong></div>' +
        '<div><span>Score</span><strong>' + (attempt.score == null ? "—" : escapeHtml(attempt.score) + " / " + escapeHtml(attempt.questionCount) + " (" + escapeHtml(attempt.percentage) + "%)") + '</strong></div>' +
        '<div><span>Outcome</span><strong>' + (attempt.pass === true ? "Pass" : attempt.pass === false ? "Below pass mark" : "Pending") + '</strong></div></div>' +
        '<p class="small">Started: ' + escapeHtml(formatDate(attempt.startedAtUtc)) + ' · Submitted: ' + escapeHtml(formatDate(attempt.submittedAtUtc)) + '</p>' +
        '<div class="review-list">' + review + '</div></div></div>';
      document.getElementById("close-result").addEventListener("click", closeModal);
      modalRoot.querySelector(".modal-backdrop").addEventListener("click", function (event) {
        if (event.target === event.currentTarget) closeModal();
      });
      document.getElementById("close-result").focus();
    } catch (error) {
      closeModal();
      notify(error.message, true);
    }
  }

  async function refreshOverview(renderView) {
    try {
      var overview = await api("/api/admin/overview");
      state.overview = overview;
      if (renderView) renderCurrentTab();
      else {
        if (state.tab === "results") updateResultsTable();
        if (state.tab === "overview") {
          var active = document.activeElement;
          var editingForm = active && active.closest && active.closest("#settings-form, #adjust-time-form");
          if (!editingForm) renderOverview();
        }
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) renderLogin();
      else notify(error.message, true);
    }
  }

  window.addEventListener("hashchange", function () {
    var next = location.hash.slice(1);
    if (state.authenticated && ["overview", "questions", "results"].includes(next) && next !== state.tab) {
      state.tab = next;
      renderCurrentTab();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && modalRoot.firstChild) closeModal();
  });
  loadDashboard();
  setInterval(function () {
    if (!state.authenticated || state.polling || document.hidden || modalRoot.firstChild) return;
    state.polling = true;
    refreshOverview(false).finally(function () { state.polling = false; });
  }, 10000);
})();
