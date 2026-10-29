(function () {
  "use strict";

  var app = document.getElementById("app");
  var toastNode = document.getElementById("toast");
  var modalRoot = document.getElementById("modal-root");
  var watermark = document.getElementById("exam-watermark");
  var model = {
    payload: null,
    answers: {},
    current: 0,
    lastView: "",
    remaining: 0,
    remainingAt: 0,
    pending: new Map(),
    saveMessage: "",
    loading: false,
    timedOutRefresh: false,
    toastTimer: null
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function hasAnswer(id) {
    return Object.prototype.hasOwnProperty.call(model.answers, id);
  }

  function formatDuration(seconds) {
    var minutes = Math.round((Number(seconds) || 0) / 60);
    return minutes === 60 ? "1 hour" : minutes + " minutes";
  }

  function formatClock(seconds) {
    var safe = Math.max(0, Math.ceil(Number(seconds) || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var remainder = safe % 60;
    return [hours, minutes, remainder].map(function (part) { return String(part).padStart(2, "0"); }).join(":");
  }

  function formatDate(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function notify(message, isError) {
    clearTimeout(model.toastTimer);
    toastNode.textContent = message;
    toastNode.className = "toast show" + (isError ? " error" : "");
    model.toastTimer = setTimeout(function () { toastNode.className = "toast"; }, 3900);
  }

  async function api(url, method, body) {
    var response = await fetch(url, {
      method: method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(result.error || "The request could not be completed. Please try again.");
    }
    return result;
  }

  function examData() {
    return model.payload && model.payload.exam ? model.payload.exam : { status: "waiting", durationSeconds: 3600, questionCount: 0 };
  }

  function attemptData() {
    return model.payload && model.payload.attempt ? model.payload.attempt : null;
  }

  function currentView() {
    var attempt = attemptData();
    if (!model.payload || !model.payload.authenticated || !attempt) return "intro";
    if (attempt.status === "active") return "exam";
    if (attempt.status === "registered") return "registered";
    return "complete";
  }

  function viewKey() {
    var attempt = attemptData();
    return currentView() + "|" + examData().status + "|" + (attempt ? attempt.id : "");
  }

  function synchronizeClock() {
    var attempt = attemptData();
    model.remaining = attempt ? Number(attempt.secondsRemaining || 0) : 0;
    model.remainingAt = performance.now();
    model.timedOutRefresh = false;
    updateClock();
  }

  function secondsLeft() {
    if (examData().status === "paused") return Math.max(0, model.remaining);
    return Math.max(0, model.remaining - (performance.now() - model.remainingAt) / 1000);
  }

  function updateClock() {
    if (currentView() !== "exam") return;
    var node = document.getElementById("remaining-time");
    if (!node) return;
    var remaining = secondsLeft();
    node.textContent = formatClock(remaining);
    var card = node.closest(".timer-card");
    if (card) card.classList.toggle("urgent", remaining <= 300);
    if (remaining <= 0 && !model.timedOutRefresh && examData().status !== "paused") {
      model.timedOutRefresh = true;
      refreshState(true);
    }
  }

  function updateWatermark() {
    var attempt = attemptData();
    if (currentView() !== "exam" || !attempt) {
      document.body.classList.remove("exam-active", "exam-obscured");
      watermark.replaceChildren();
      return;
    }
    document.body.classList.add("exam-active");
    if (watermark.dataset.forId === attempt.id) return;
    watermark.dataset.forId = attempt.id;
    watermark.replaceChildren();
    var caption = attempt.name + "  •  " + (attempt.icMasked || "Candidate assessment");
    for (var i = 0; i < 9; i += 1) {
      var item = document.createElement("span");
      item.textContent = caption;
      watermark.appendChild(item);
    }
  }

  function renderHero() {
    var exam = examData();
    return '<section class="entry-hero">' +
      '<div><div class="hero-topline"><span class="line"></span> Employee applicant evaluation</div>' +
      '<p class="eyebrow eyebrow-light">Technology knowledge assessment</p>' +
      '<h1>Your next step starts here.</h1>' +
      '<p class="hero-subtitle">A focused multiple-choice assessment using the questions selected by the administrator.</p></div>' +
      '<div class="hero-facts">' +
      '<div class="hero-fact"><strong>' + escapeHtml(exam.questionCount || "—") + '</strong><span>Questions in the current bank</span></div>' +
      '<div class="hero-fact"><strong>' + escapeHtml(formatDuration(exam.durationSeconds)) + '</strong><span>Time once you begin</span></div>' +
      '<div class="hero-fact"><strong>MCQ</strong><span>Choose one answer each</span></div>' +
      '</div></section>';
  }

  function renderIntro() {
    var exam = examData();
    var closed = exam.status === "closed";
    app.innerHTML = '<div class="entry-grid">' + renderHero() +
      '<section class="entry-panel">' +
      '<p class="panel-kicker">Candidate registration</p>' +
      '<h2>' + (closed ? "This exam is closed." : "Before you begin") + '</h2>' +
      '<p class="panel-intro">' + (closed ?
        "The administrator has closed this exam session. Please contact them if you need access." :
        "Enter your legal name and IC to register. You can begin when the administrator opens the exam.") + '</p>' +
      (closed ? '<div class="notice notice-warning">Registration is unavailable while the exam is closed.</div>' :
        '<form id="register-form" novalidate>' +
        '<div class="field"><label for="candidate-name">Full name</label><input id="candidate-name" name="name" type="text" maxlength="120" autocomplete="name" placeholder="As shown on your identification" required></div>' +
        '<div class="field"><label for="candidate-ic">IC / identification number</label><input id="candidate-ic" name="ic" type="text" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Enter your IC number" required></div>' +
        '<button class="btn btn-block" type="submit">Register and continue <span aria-hidden="true">→</span></button>' +
        '</form>') +
      '<div class="notice"><span>Copy, paste, print and text selection are restricted in the candidate portal. Your exam screen will be watermarked.</span></div>' +
      '<p class="fine-print">Keep this browser open so your registered session can be resumed. An administrator controls when the exam opens and closes.</p>' +
      '</section></div>';
    var form = document.getElementById("register-form");
    if (form) form.addEventListener("submit", register);
  }

  function renderRegistered() {
    var exam = examData();
    var attempt = attemptData();
    var isOpen = exam.status === "open";
    var isPaused = exam.status === "paused";
    var isClosed = exam.status === "closed";
    var title = isOpen ? "Ready when you are." : isPaused ? "The exam is paused." : isClosed ? "The exam is closed." : "Waiting to begin.";
    var description = isOpen ?
      "Your time starts as soon as you select Begin assessment. Review the instructions before continuing." :
      isPaused ? "The administrator has paused the session. You can begin after it resumes." :
      isClosed ? "The administrator has closed the session. Contact them for the next step." :
      "You are registered. The administrator will open the exam when it is time to start.";
    app.innerHTML = '<div class="entry-grid">' + renderHero() +
      '<section class="entry-panel">' +
      '<span class="status-illustration ' + (isClosed ? "closed" : "") + '" aria-hidden="true">' + (isClosed ? "×" : isOpen ? "✓" : "◷") + '</span>' +
      '<p class="panel-kicker">Registration complete</p>' +
      '<h2>' + title + '</h2><p class="panel-intro">' + description + '</p>' +
      '<div class="identity-card"><div class="avatar" aria-hidden="true">' + escapeHtml((attempt.name || "C").trim().charAt(0).toUpperCase()) + '</div>' +
      '<div><strong>' + escapeHtml(attempt.name) + '</strong><span>IC ' + escapeHtml(attempt.icMasked || "registered") + '</span></div></div>' +
      (isOpen ? '<div class="notice notice-spaced">You have ' + escapeHtml(formatDuration(exam.durationSeconds)) + '. Select one option per question. Your answers save automatically.</div>' +
        '<button id="begin-button" class="btn btn-block" type="button">Begin assessment <span aria-hidden="true">→</span></button>' :
        '<div class="notice notice-warning notice-top"><span>This page checks for updates automatically.</span></div>') +
      '<p class="fine-print">Once you begin, the countdown runs until you submit or the administrator closes the exam. Pause and time changes are controlled by the administrator.</p>' +
      '</section></div>';
    var button = document.getElementById("begin-button");
    if (button) button.addEventListener("click", beginAssessment);
  }

  function renderExam() {
    var attempt = attemptData();
    if (!attempt) return;
    var questions = attempt.questions || [];
    if (!questions.length) {
      app.innerHTML = '<div class="entry-panel"><h2>No questions are available.</h2><p class="muted">Please contact the administrator.</p></div>';
      return;
    }
    model.current = Math.min(Math.max(0, model.current), questions.length - 1);
    var question = questions[model.current];
    var isPaused = examData().status === "paused";
    var answered = questions.filter(function (item) { return hasAnswer(item.id); }).length;
    var percentage = questions.length ? Math.round(answered / questions.length * 100) : 0;
    var options = question.options || [];
    var choices = options.map(function (option, index) {
      var selected = model.answers[question.id] === index;
      return '<button class="option' + (selected ? " selected" : "") + '" type="button" data-option="' + index + '" aria-pressed="' + selected + '"' + (isPaused ? " disabled" : "") + '>' +
        '<span class="option-key">' + String.fromCharCode(65 + index) + '</span><span class="option-text">' + escapeHtml(option) + '</span></button>';
    }).join("");
    var map = questions.map(function (item, index) {
      var className = "map-button" + (hasAnswer(item.id) ? " answered" : "") + (index === model.current ? " current" : "");
      return '<button class="' + className + '" type="button" data-question="' + index + '" aria-label="Question ' + (index + 1) + (hasAnswer(item.id) ? ", answered" : ", unanswered") + '"' + (index === model.current ? ' aria-current="step"' : "") + '>' + (index + 1) + '</button>';
    }).join("");
    app.innerHTML = '<div class="exam-shell">' +
      '<div class="exam-topbar"><div><p class="eyebrow">Candidate assessment</p><h1>Technology Knowledge Exam</h1></div>' +
      '<div class="topbar-actions"><div class="timer-card"><span class="timer-icon" aria-hidden="true">◷</span><span><small>Time remaining</small><strong id="remaining-time">--:--:--</strong></span></div></div></div>' +
      (isPaused ? '<div class="paused-banner"><span aria-hidden="true">◷</span><div><strong>Assessment paused by administrator</strong><span>Your timer is frozen. You can continue when the administrator resumes the session.</span></div></div>' : "") +
      '<div class="progress-strip"><span class="progress-caption">Your progress</span><progress class="progress-native" value="' + answered + '" max="' + questions.length + '" aria-label="Answered questions"></progress><span class="progress-count">' + answered + ' of ' + questions.length + ' answered · ' + percentage + '%</span></div>' +
      '<div class="exam-grid"><section class="question-card" aria-label="Current question">' +
      '<div class="question-meta"><span class="question-number">Question ' + String(model.current + 1).padStart(2, "0") + ' / ' + String(questions.length).padStart(2, "0") + '</span>' +
      '<span class="section-tag">' + escapeHtml(question.section || "Service management") + '</span></div>' +
      '<h2>' + escapeHtml(question.text) + '</h2><div class="option-list" role="group" aria-label="Answer choices">' + choices + '</div>' +
      '<div class="question-footer"><span id="save-status" class="save-status' + (model.saveMessage === "Answer saved" ? " saved" : "") + '">' + escapeHtml(model.saveMessage || "Select one answer") + '</span>' +
      '<div class="button-row"><button id="previous-question" type="button" class="btn btn-secondary" ' + (model.current === 0 ? "disabled" : "") + '>← Previous</button>' +
      '<button id="next-question" type="button" class="btn" ' + (model.current === questions.length - 1 ? "disabled" : "") + '>Next question →</button></div></div>' +
      '</section><aside class="side-card" aria-label="Question navigation">' +
      '<h3>Question navigator</h3><p>Move between questions at any time.</p><div class="question-map">' + map + '</div>' +
      '<div class="map-legend"><span><i class="legend-square answered"></i> Answered</span><span><i class="legend-square"></i> Not answered</span></div>' +
      '<hr class="side-divider"><button id="submit-assessment" class="btn btn-block" type="button">Submit assessment →</button>' +
      '<div class="exam-help"><span class="exam-help-icon" aria-hidden="true">ⓘ</span><span>Answers save automatically. You may submit before time ends.</span></div>' +
      '</aside></div></div>';
    app.querySelectorAll("[data-option]").forEach(function (button) {
      button.addEventListener("click", function () { saveAnswer(question.id, Number(button.dataset.option)); });
    });
    app.querySelectorAll("[data-question]").forEach(function (button) {
      button.addEventListener("click", function () { navigate(Number(button.dataset.question)); });
    });
    document.getElementById("previous-question").addEventListener("click", function () { navigate(model.current - 1); });
    document.getElementById("next-question").addEventListener("click", function () { navigate(model.current + 1); });
    document.getElementById("submit-assessment").addEventListener("click", confirmSubmit);
    updateClock();
  }

  function renderComplete() {
    var attempt = attemptData();
    var expired = attempt.status === "expired";
    var endedByAdmin = attempt.status === "finished_by_admin";
    var title = expired ? "Time has ended." : endedByAdmin ? "The assessment has ended." : "Assessment submitted.";
    var description = expired ?
      "The time limit was reached. Your saved answers have been submitted automatically." :
      endedByAdmin ? "The administrator ended the session. Your saved answers have been recorded." :
      "Your answers have been recorded. Thank you for completing the assessment.";
    app.innerHTML = '<div class="entry-grid">' + renderHero() +
      '<section class="entry-panel">' +
      '<span class="status-illustration done" aria-hidden="true">✓</span>' +
      '<p class="panel-kicker">Candidate assessment</p><h2>' + title + '</h2>' +
      '<p class="panel-intro">' + description + '</p>' +
      '<div class="identity-card"><div class="avatar" aria-hidden="true">' + escapeHtml((attempt.name || "C").trim().charAt(0).toUpperCase()) + '</div>' +
      '<div><strong>' + escapeHtml(attempt.name) + '</strong><span>IC ' + escapeHtml(attempt.icMasked || "registered") + '</span></div></div>' +
      (attempt.submittedAtUtc ? '<p class="fine-print">Recorded on ' + escapeHtml(formatDate(attempt.submittedAtUtc)) + '.</p>' : "") +
      '<div class="notice notice-top">The administrator can view your result in the admin console.</div>' +
      '</section></div>';
  }

  function render() {
    var view = currentView();
    model.lastView = viewKey();
    app.setAttribute("aria-live", view === "exam" ? "off" : "polite");
    if (view === "intro") renderIntro();
    else if (view === "registered") renderRegistered();
    else if (view === "exam") renderExam();
    else renderComplete();
    updateWatermark();
  }

  async function refreshState(silent) {
    if (model.loading) return;
    model.loading = true;
    try {
      var previousAttempt = attemptData();
      var previousKey = viewKey();
      var result = await api("/api/candidate/state");
      model.payload = result;
      var attempt = attemptData();
      if (!previousAttempt || !attempt || previousAttempt.id !== attempt.id) {
        model.current = 0;
        model.pending.clear();
      }
      var serverAnswers = attempt && attempt.answers ? attempt.answers : {};
      model.answers = Object.assign({}, serverAnswers);
      model.pending.forEach(function (entry, id) { model.answers[id] = entry.optionIndex; });
      synchronizeClock();
      if (previousKey !== viewKey() || !app.querySelector(".entry-grid, .exam-shell")) render();
      else updateWatermark();
    } catch (error) {
      if (!silent) {
        app.innerHTML = '<section class="entry-panel load-error"><h2>Unable to load the assessment.</h2><p class="muted">' + escapeHtml(error.message) + '</p><button id="retry-load" class="btn" type="button">Try again</button></section>';
        document.getElementById("retry-load").addEventListener("click", function () { refreshState(false); });
      } else notify(error.message, true);
    } finally {
      model.loading = false;
    }
  }

  async function register(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var name = form.elements.name.value.trim();
    var ic = form.elements.ic.value.trim();
    if (!name || !ic) {
      notify("Enter your full name and IC to continue.", true);
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Registering…";
    try {
      await api("/api/candidate/register", "POST", { name: name, ic: ic });
      await refreshState(false);
    } catch (error) {
      notify(error.message, true);
      button.disabled = false;
      button.textContent = "Register and continue →";
    }
  }

  async function beginAssessment() {
    var button = document.getElementById("begin-button");
    if (button) {
      button.disabled = true;
      button.textContent = "Starting…";
    }
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
    try {
      await api("/api/candidate/start", "POST", {});
      await refreshState(false);
    } catch (error) {
      notify(error.message, true);
      if (button) {
        button.disabled = false;
        button.textContent = "Begin assessment →";
      }
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    }
  }

  function navigate(index) {
    var attempt = attemptData();
    if (!attempt || !attempt.questions || index < 0 || index >= attempt.questions.length) return;
    model.current = index;
    model.saveMessage = "";
    renderExam();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setSaveMessage(message) {
    model.saveMessage = message;
    var node = document.getElementById("save-status");
    if (node) {
      node.textContent = message;
      node.classList.toggle("saved", message === "Answer saved");
    }
  }

  function saveAnswer(id, optionIndex) {
    if (currentView() !== "exam" || examData().status !== "open") return;
    model.answers[id] = optionIndex;
    setSaveMessage("Saving answer…");
    renderExam();
    var previous = model.pending.get(id);
    var promise = (previous ? previous.promise.catch(function () {}) : Promise.resolve()).then(function () {
      return api("/api/candidate/answer", "PUT", { questionId: id, optionIndex: optionIndex });
    });
    model.pending.set(id, { optionIndex: optionIndex, promise: promise });
    promise.then(function () {
      if (model.pending.get(id) && model.pending.get(id).promise === promise) {
        model.pending.delete(id);
        setSaveMessage("Answer saved");
      }
    }).catch(function (error) {
      if (model.pending.get(id) && model.pending.get(id).promise === promise) {
        model.pending.delete(id);
        notify(error.message, true);
        refreshState(true);
      }
    });
  }

  function closeModal() {
    modalRoot.replaceChildren();
  }

  function confirmSubmit() {
    var attempt = attemptData();
    if (!attempt || currentView() !== "exam") return;
    var questions = attempt.questions || [];
    var unanswered = questions.filter(function (item) { return !hasAnswer(item.id); }).length;
    modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="submit-title">' +
      '<div class="modal-header"><h2 id="submit-title">Submit your assessment?</h2><button class="icon-button" type="button" id="close-submit" aria-label="Close dialog">×</button></div>' +
      '<p>' + (unanswered ?
        "You have " + unanswered + " unanswered " + (unanswered === 1 ? "question" : "questions") + ". You can review them before submitting." :
        "All questions have an answer. Your assessment will be final once submitted.") + '</p>' +
      '<div class="modal-actions"><button class="btn btn-secondary" type="button" id="review-answers">Review answers</button>' +
      '<button class="btn" type="button" id="confirm-submit">Submit now</button></div></div></div>';
    document.getElementById("close-submit").addEventListener("click", closeModal);
    document.getElementById("review-answers").addEventListener("click", closeModal);
    document.getElementById("confirm-submit").addEventListener("click", submitAssessment);
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", function (event) {
      if (event.target === event.currentTarget) closeModal();
    });
    document.getElementById("confirm-submit").focus();
  }

  async function submitAssessment() {
    var button = document.getElementById("confirm-submit");
    if (button) {
      button.disabled = true;
      button.textContent = "Submitting…";
    }
    try {
      await Promise.all(Array.from(model.pending.values()).map(function (entry) { return entry.promise; }));
      await api("/api/candidate/submit", "POST", {});
      closeModal();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
      await refreshState(false);
    } catch (error) {
      notify(error.message, true);
      if (button) {
        button.disabled = false;
        button.textContent = "Submit now";
      }
      refreshState(true);
    }
  }

  function protectCandidatePortal() {
    ["copy", "cut", "paste", "contextmenu", "dragstart"].forEach(function (name) {
      document.addEventListener(name, function (event) {
        event.preventDefault();
        if (name !== "dragstart") notify("This action is restricted in the candidate portal.", true);
      });
    });
    document.addEventListener("selectstart", function (event) {
      if (currentView() === "exam") event.preventDefault();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && modalRoot.firstChild) {
        closeModal();
        return;
      }
      var key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ["c", "v", "x", "p", "s"].includes(key)) {
        event.preventDefault();
        notify("Clipboard and printing shortcuts are restricted.", true);
      }
      if ((event.ctrlKey || event.metaKey) && key === "a" && currentView() === "exam") {
        event.preventDefault();
      }
      if (event.key === "PrintScreen") {
        event.preventDefault();
        notify("Screen capture is prohibited. This assessment is watermarked.", true);
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (currentView() !== "exam") return;
      document.body.classList.toggle("exam-obscured", document.hidden);
    });
    window.addEventListener("blur", function () {
      if (currentView() === "exam") document.body.classList.add("exam-obscured");
    });
    window.addEventListener("focus", function () {
      document.body.classList.remove("exam-obscured");
      if (currentView() === "exam") refreshState(true);
    });
  }

  protectCandidatePortal();
  refreshState(false);
  setInterval(function () { if (model.payload) refreshState(true); }, 5000);
  setInterval(updateClock, 250);
})();
