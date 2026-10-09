(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const ui = window.ui;
  const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; };

  // This page serves every quiz; which one comes from the address: /q/<slug>
  const slug = (location.pathname.match(/^\/q\/([a-z0-9]+)/i) || [])[1]?.toLowerCase() || '';
  const BASE = `/api/q/${slug}`;
  const KEY = `qv.${slug}`;
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(`${KEY}.${k}`)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`${KEY}.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(`${KEY}.${k}`); } catch { /* ignore */ } },
  };

  let info = null;   // public quiz info
  let me = null;     // signed-in student state
  let lobbyTimer = null;

  // ---------- api ----------
  class ApiError extends Error {
    constructor(status, body) { super(body.error || 'Request failed'); this.status = status; this.code = body.code; this.field = body.field; }
  }
  async function api(path, body) {
    const opts = { method: body === undefined ? 'GET' : 'POST', headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(`${BASE}${path}`, opts); } catch { throw new ApiError(0, { error: 'No internet connection. Please check your network.' }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new ApiError(res.status, data);
      if (err.code === 'SESSION_REPLACED' || err.code === 'BLOCKED') showMessage('Logged out', err.message);
      throw err;
    }
    return data;
  }

  // ---------- views ----------
  function show(name) {
    const view = $(`#view-${name}`);
    const changed = view.hidden;
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    // Each screen eases in. The quiz screen only fades: a moving parent would shift its fixed watermark.
    if (changed) {
      if (name === 'enter') ui.enter($('.auth-card'), { y: 18, duration: 0.6 });
      else if (name !== 'loading') ui.enter(view, { y: name === 'quiz' ? 0 : 12, duration: 0.45 });
    }
    document.body.classList.toggle('on-landing', ['enter', 'loading', 'error'].includes(name));
    document.body.classList.toggle('in-quiz', name === 'quiz');
    window.scrollTo(0, 0);
    if (name !== 'lobby') clearInterval(lobbyTimer);
  }
  function showMessage(title, text) {
    quiz.stop();
    $('#msg-title').textContent = title;
    $('#msg-text').textContent = text;
    show('message');
  }
  function showError(title, text) {
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
    show('error');
  }
  $('#btn-reenter').onclick = () => show('enter');

  function modal(title, text, actions, warn = false) {
    const m = $('#modal');
    m.classList.toggle('warn', warn);
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    const box = $('#modal-actions');
    box.replaceChildren();
    return new Promise((resolve) => {
      for (const a of actions) {
        const b = el('button', `btn ${a.cls || 'ghost'}`, a.label);
        b.onclick = () => { m.hidden = true; resolve(a.value); };
        box.append(b);
      }
      m.hidden = false;
      ui.pop($('.modal-body', m), { y: 12, scale: 0.95 });
    });
  }

  const fmt = (ms) => {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // "Tue, 29 Sept, 7:00 pm – 9:00 pm" (end date repeated only if it is a different day)
  const windowText = (a, b) => (new Date(a).toDateString() === new Date(b).toDateString() ? `${when(a)} – ${clock(b)}` : `${when(a)} – ${when(b)}`);

  // ---------- quiz info and theme ----------
  function applyInfo(q) {
    info = q;
    window.applyQuizTheme(document.documentElement, q.theme);
    document.title = q.title;
    const logo = $('#quiz-logo');
    if (q.theme.logo) {
      logo.src = q.theme.logo;
      logo.alt = q.organiser.institution;
      logo.hidden = false;
      logo.onerror = () => { logo.hidden = true; };
    } else logo.hidden = true;
    $('#host-name').textContent = q.organiser.institution;
    $('#enter-host').textContent = q.organiser.institution;
    $('#enter-title').textContent = q.title;
    $('#enter-meta').textContent = `${q.questionCount} questions · ${q.durationMin} minutes · ${windowText(q.startAt, q.endAt)}`;
    $('#extra-field').hidden = !q.extraLabel;
    $('#extra-label').textContent = q.extraLabel || '';
  }

  // ---------- enter password and details ----------
  const enterForm = $('#form-enter');
  // A link shared as /q/<slug>#pw=CODE fills in the password.
  const pw = /[#&]pw=([A-Za-z0-9]+)/.exec(location.hash);
  if (pw) enterForm.elements.password.value = pw[1].toUpperCase();
  enterForm.elements.phone.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d+\s-]/g, ''); });
  enterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', enterForm);
    err.textContent = '';
    $$('.field', enterForm).forEach((f) => f.classList.remove('bad'));
    const btn = $('button[type=submit]', enterForm);
    btn.disabled = true;
    try {
      await api('/enter', Object.fromEntries(new FormData(enterForm)));
      const keep = enterForm.elements.password.value;
      enterForm.reset();
      enterForm.elements.password.value = keep;
      await loadLobby();
    } catch (ex) {
      err.textContent = ex.message;
      ui.shake(enterForm.elements[ex.field] || btn);
      if (ex.field) enterForm.elements[ex.field]?.focus();
    } finally { btn.disabled = false; }
  });

  $('#btn-signout').onclick = async () => {
    await api('/logout', {}).catch(() => {});
    show('enter');
  };

  // ---------- lobby ----------
  async function loadLobby() {
    me = await api('/me');
    applyInfo(me.quiz);
    const s = me.student;
    const q = me.quiz;
    $('#lobby-name').textContent = s.name.split(' ')[0];
    $('#lobby-meta').textContent = [s.extra, s.phone].filter(Boolean).join(' · ');

    if (me.attemptStatus === 'in_progress') return quiz.enter();
    if (me.attemptStatus === 'submitted') return showDone('You have already submitted this quiz.', me.result);

    $('#quiz-title').textContent = q.title;
    $('#quiz-qcount').textContent = q.questionCount;
    $('#quiz-duration').textContent = q.durationMin;
    $('#quiz-window').textContent = `You can start from ${when(q.startAt)}. The quiz closes for everyone at ${when(q.endAt)}.`;
    $('#quiz-instructions').textContent = q.instructions || '';
    const resultsRule = {
      none: 'Your score is not shown after the quiz. Your organiser will share results.',
      score: 'You will see your score as soon as you submit.',
      full: 'You will see your score when you submit, and the correct answers after the quiz closes for everyone.',
    }[q.showResults];
    const rules = [
      'Each question has one correct answer. Your answer is saved as soon as you choose it.',
      'Use the question numbers at the top to jump to any question. You can go back and change answers until you submit.',
      `You get ${q.durationMin} minutes, but the quiz closes at ${when(q.endAt)}. If you start late, you only get the time left until then.`,
      'The timer keeps running even if you close the page. When time is up, your saved answers are submitted automatically.',
      'You can submit early. Once submitted you cannot change answers, and you can take the quiz only once.',
      resultsRule,
      `Stay on the quiz screen. Switching apps or tabs is recorded${q.maxViolations > 0 ? `, and after ${q.maxViolations} times your quiz is submitted automatically` : ''}.`,
      'On a laptop the quiz runs in full screen. Leaving full screen counts as switching away.',
      'Entering your details on another device will log out this one.',
    ];
    $('#rules-list').replaceChildren(...rules.map((r) => el('li', '', r)));

    // Count down using server time so a wrong phone clock doesn't matter.
    const offset = me.serverNow - Date.now();
    const tick = () => {
      const now = Date.now() + offset;
      const left = q.startAt - now;
      const open = left <= 0;
      const closed = now >= q.endAt;
      $('#countdown-wrap').hidden = open;
      $('#countdown').textContent = fmt(left);
      $('#quiz-status').textContent = closed ? 'Closed' : open ? 'Open now' : 'Upcoming quiz';
      $('#btn-start').disabled = !open || closed || !$('#agree').checked;
      $('#btn-start').textContent = closed ? 'This quiz has closed' : open ? 'Start quiz' : 'Waiting for start time';
    };
    clearInterval(lobbyTimer);
    tick();
    lobbyTimer = setInterval(tick, 1000);
    $('#agree').onchange = tick;
    show('lobby');
  }

  $('#btn-start').addEventListener('click', async () => {
    $('#start-error').textContent = '';
    requestFullscreen(); // must happen inside the tap/click
    try {
      await api('/attempt/start', {});
      await quiz.enter();
    } catch (ex) {
      if (ex.code === 'SUBMITTED') return finishAndShow(ex.message);
      $('#start-error').textContent = ex.message;
    }
  });

  // ---------- done and result ----------
  function showDone(text, result) {
    $('#done-text').textContent = `${text} Thank you for taking part.`;
    const box = $('#result-box');
    const review = $('#review');
    box.hidden = !result;
    review.hidden = true;
    if (result) {
      const n = (v) => (Number.isInteger(v) ? v : Number(v).toFixed(1));
      $('#res-score').textContent = n(result.score);
      $('#res-total').textContent = `/ ${n(result.totalMarks)}`;
      $('#res-right').textContent = result.correct;
      $('#res-wrong').textContent = result.wrong;
      $('#res-skip').textContent = result.unanswered;
      $('#res-note').textContent = result.reviewAt
        ? `The correct answers will be shown here after the quiz closes at ${when(result.reviewAt)}.`
        : '';
      if (result.review) renderReview(result.review);
    }
    show('done');
    // The tick draws itself, then the score counts up and the details follow.
    ui.pop($('.done-icon'), { y: 0, scale: 0.6 });
    ui.draw($('#done-tick'), { delay: 0.2 });
    if (result) {
      ui.count($('#res-score'), result.score, { decimals: Number.isInteger(Number(result.score)) ? 0 : 1, duration: 1 });
      ui.enter($$('#result-box .facts > div'), { y: 10, delay: 0.35, stagger: 0.08 });
      if (result.review) ui.enter($$('#review-list .rq').slice(0, 12), { y: 12, delay: 0.5, stagger: 0.05 });
    }
  }

  function renderReview(items) {
    $('#review-list').replaceChildren(...items.map((q, i) => {
      const card = el('div', 'rq');
      card.append(el('div', 'muted small', `Question ${i + 1}`), el('div', 'rq-text', q.text));
      if (q.image) { const img = el('img', 'review-img'); img.src = q.image; img.alt = ''; card.append(img); }
      q.options.forEach((o, j) => {
        const isCorrect = j === q.correct;
        const isChosen = j === q.chosen;
        const row = el('div', `rq-opt${isCorrect ? ' correct' : isChosen ? ' wrong' : ''}`);
        row.append(el('span', 'key', 'ABCDEF'[j]), el('span', '', o));
        if (isCorrect) row.append(el('span', 'tag', isChosen ? 'Your answer ✓' : 'Correct answer'));
        else if (isChosen) row.append(el('span', 'tag', 'Your answer'));
        card.append(row);
      });
      if (q.chosen == null) card.append(el('div', 'muted small', 'You did not answer this question.'));
      return card;
    }));
    $('#review').hidden = false;
  }

  // After submitting: fetch the result the organiser chose to show.
  async function finishAndShow(text) {
    let result = null;
    try { result = (await api('/me')).result; } catch { /* show the thank-you without a score */ }
    showDone(text, result);
  }

  // ---------- anti-cheat helpers ----------
  const isDesktop = () => window.matchMedia('(pointer: fine)').matches && !('ontouchstart' in window);
  function requestFullscreen() {
    if (!isDesktop()) return;
    const root = document.documentElement;
    const fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (fn && !document.fullscreenElement) fn.call(root)?.catch?.(() => {});
  }

  // ---------- quiz ----------
  const quiz = (() => {
    let state = null;          // from GET /attempt
    let current = 0;
    let cache = new Map();     // index -> question
    let endsAt = 0;            // performance.now() based deadline
    let timerId = null;
    let active = false;
    let lastViolation = 0;
    let logged = {};           // throttle for non-counting events
    let shown = null;          // index of the question on screen

    function syncClock(remainingMs) { endsAt = performance.now() + remainingMs; }

    async function enter() {
      try { state = await api('/attempt'); } catch (ex) { return handleErr(ex); }
      active = true;
      cache = new Map();
      shown = null;
      syncClock(state.remainingMs);
      $('#q-total').textContent = state.total;
      buildWatermark();
      show('quiz');
      if (store.get('inQuiz')) report('page_reload', 'Quiz page was reloaded or reopened');
      store.set('inQuiz', true);
      clearInterval(timerId);
      timerId = setInterval(tick, 500);
      tick();
      flushPending();
      const firstOpen = state.answered.findIndex((a) => !a);
      await go(firstOpen >= 0 ? firstOpen : 0);
    }

    function stop() {
      active = false;
      clearInterval(timerId);
      store.del('inQuiz');
    }

    function buildWatermark() {
      const text = `${me.student.name} · ${me.student.phone}     `;
      $('#watermark').textContent = Array.from({ length: 40 }, () => text.repeat(6)).join('\n');
    }

    function tick() {
      const left = endsAt - performance.now();
      const t = $('#timer');
      t.textContent = fmt(left);
      t.classList.toggle('low', left <= 5 * 60_000);
      if (left <= 0 && active) timeUp();
    }

    async function timeUp() {
      active = false;
      clearInterval(timerId);
      await flushPending();
      finish('Time is up. Your saved answers have been submitted automatically.');
    }

    function finish(text) {
      stop();
      store.del('pending');
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      finishAndShow(text);
    }

    function handleErr(ex) {
      if (ex.code === 'SUBMITTED') return finish(ex.message);
      if (ex.status === 401 || ex.status === 403) return; // message view already shown
      setSave(ex.message, true);
    }

    async function go(n) {
      if (n < 0 || n >= state.total) return;
      current = n;
      let q = cache.get(n);
      if (!q) {
        try { q = await api(`/attempt/q/${n}`); } catch (ex) { return handleErr(ex); }
        cache.set(n, q);
        syncClock(q.remainingMs);
      }
      if (current !== n) return; // user moved on while loading
      const from = shown;
      shown = n;
      render(q);
      // Next slides in from the right, previous from the left.
      if (from != null && from !== n) ui.slide($('#qcard'), n > from ? 1 : -1, 26);
      // Quietly fetch the next question so "Next" is instant on slow networks.
      if (n + 1 < state.total && !cache.has(n + 1)) api(`/attempt/q/${n + 1}`).then((nq) => cache.set(n + 1, nq)).catch(() => {});
    }

    function render(q) {
      $('#q-pos').textContent = q.index + 1;
      $('#q-label').textContent = `Question ${q.index + 1}`;
      $('#q-text').textContent = q.text;
      const img = $('#q-img');
      if (q.image) { img.src = q.image; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
      $('#q-options').replaceChildren(...q.options.map((text, i) => {
        const b = el('button', 'opt');
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(q.chosen === i));
        b.append(el('span', 'key', 'ABCDEF'[i]), el('span', '', text));
        b.onclick = () => choose(q, i);
        return b;
      }));
      const mark = $('#btn-mark');
      mark.setAttribute('aria-pressed', String(q.marked));
      mark.textContent = q.marked ? 'Marked ★' : 'Mark for review';
      $('#btn-prev').disabled = q.index === 0;
      $('#btn-next').disabled = q.index === state.total - 1;
      renderStrip();
    }

    function renderStrip() {
      const strip = $('#qstrip');
      if (strip.children.length !== state.total) {
        strip.replaceChildren(...state.answered.map((_, i) => {
          const b = el('button', '', i + 1);
          b.type = 'button';
          b.onclick = () => go(i);
          return b;
        }));
      }
      Array.from(strip.children).forEach((b, i) => {
        b.classList.toggle('answered', !!state.answered[i]);
        b.classList.toggle('marked', !!state.marked[i]);
        b.classList.toggle('current', i === current);
        if (i === current) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
      strip.children[current]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    function choose(q, i) {
      q.chosen = q.chosen === i ? null : i; // tap again to clear
      state.answered[q.index] = q.chosen != null;
      render(q);
      if (q.chosen != null) ui.bump($$('#q-options .key')[i], 1.18);
      save(q);
    }

    function toggleMark() {
      const q = cache.get(current);
      if (!q) return;
      q.marked = !q.marked;
      state.marked[q.index] = q.marked;
      render(q);
      save(q);
    }

    // ---- autosave with offline retry ----
    function setSave(text, offline = false) {
      const s = $('#save-state');
      s.textContent = text;
      s.classList.toggle('offline', offline);
    }

    function save(q) {
      const pending = store.get('pending') || {};
      pending[q.index] = { index: q.index, choice: q.chosen, marked: q.marked };
      store.set('pending', pending);
      flushPending();
    }

    let flushing = null;
    function flushPending() {
      if (flushing) return flushing.then(() => (Object.keys(store.get('pending') || {}).length ? flushPending() : undefined));
      flushing = (async () => {
        const items = Object.values(store.get('pending') || {});
        if (!items.length) return;
        setSave('Saving…');
        for (const item of items) {
          try {
            const r = await api('/attempt/answer', item);
            syncClock(r.remainingMs);
            const now = store.get('pending') || {};
            if (JSON.stringify(now[item.index]) === JSON.stringify(item)) { delete now[item.index]; store.set('pending', now); }
          } catch (ex) {
            if (ex.code === 'SUBMITTED') { store.del('pending'); return handleErr(ex); }
            if (ex.status >= 400 && ex.status < 500) { const now = store.get('pending') || {}; delete now[item.index]; store.set('pending', now); continue; }
            setSave('Offline. Your answers will save when the connection is back.', true);
            return;
          }
        }
        setSave('All answers saved ✓');
      })().finally(() => { flushing = null; });
      return flushing;
    }
    setInterval(() => { if (active && Object.keys(store.get('pending') || {}).length) flushPending(); }, 4000);
    window.addEventListener('online', () => active && flushPending());

    // ---- submit ----
    async function submit() {
      const unanswered = state.answered.filter((a) => !a).length;
      const marked = state.marked.filter(Boolean).length;
      let text = 'Once you submit, you cannot change your answers.';
      if (unanswered) text = `You have ${unanswered} unanswered question${unanswered > 1 ? 's' : ''}. ${text}`;
      if (marked) text += ` ${marked} question${marked > 1 ? 's are' : ' is'} marked for review.`;
      const ok = await modal('Submit quiz?', text, [
        { label: 'Go back', value: false },
        { label: 'Submit', value: true, cls: 'primary' },
      ]);
      if (!ok) return;
      await flushPending();
      try { await api('/attempt/submit', {}); finish('Your answers have been submitted.'); } catch (ex) { handleErr(ex); }
    }

    // ---- violations ----
    let pendingWarning = null;
    async function report(type, detail) {
      if (!active) return;
      const counts = ['tab_switch', 'window_blur', 'fullscreen_exit'].includes(type);
      const now = Date.now();
      if (counts) {
        // visibilitychange + blur usually fire together; treat them as one event.
        if (now - lastViolation < 2500) return;
        lastViolation = now;
      } else {
        if (logged[type] && now - logged[type] < 10_000) return;
        logged[type] = now;
      }
      let r;
      try { r = await api('/attempt/violation', { type, detail }); } catch (ex) { return handleErr(ex); }
      if (!counts) return;
      if (r.submitted) return finish('You left the quiz screen too many times, so your quiz was submitted automatically.');
      const left = r.maxViolations > 0 ? r.maxViolations - r.violations : null;
      pendingWarning = left == null
        ? `Leaving the quiz screen is recorded (${r.violations} so far). Please stay on this screen.`
        : `Leaving the quiz screen is recorded. ${left} more time${left === 1 ? '' : 's'} and your quiz will be submitted automatically.`;
      if (!document.hidden) showWarning();
    }
    async function showWarning() {
      if (!pendingWarning) return;
      const text = pendingWarning;
      pendingWarning = null;
      await modal('Warning', text, [{ label: isDesktop() ? 'Return to full screen' : 'Continue quiz', value: true, cls: 'primary' }], true);
      requestFullscreen();
    }

    document.addEventListener('visibilitychange', () => {
      if (!active) return;
      if (document.hidden) report('tab_switch', 'Page hidden (switched app/tab or locked screen)');
      else showWarning();
    });
    window.addEventListener('blur', () => { if (active && !document.hidden) report('window_blur', 'Window lost focus'); });
    document.addEventListener('fullscreenchange', () => {
      if (active && isDesktop() && !document.fullscreenElement) report('fullscreen_exit', 'Left full screen');
    });

    const block = (type) => (e) => { if (active) { e.preventDefault(); report(type); } };
    document.addEventListener('copy', block('copy_attempt'));
    document.addEventListener('cut', block('copy_attempt'));
    document.addEventListener('paste', block('paste_attempt'));
    document.addEventListener('contextmenu', block('context_menu'));
    document.addEventListener('selectstart', (e) => { if (active) e.preventDefault(); });
    document.addEventListener('dragstart', (e) => { if (active) e.preventDefault(); });
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (k === 'printscreen') { report('print_screen'); return; }
      if (k === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (mod && ['u', 's', 'p'].includes(k))) {
        e.preventDefault(); report('devtools_key', e.key);
      } else if (mod && ['c', 'x', 'a'].includes(k)) {
        e.preventDefault(); report('copy_attempt', `Ctrl+${e.key}`);
      }
    });
    window.addEventListener('beforeunload', (e) => { if (active) { e.preventDefault(); e.returnValue = ''; } });

    // ---- buttons ----
    // Moving between questions also pushes any unsaved answer to the server.
    $('#btn-prev').onclick = () => { flushPending(); go(current - 1); };
    $('#btn-next').onclick = () => { flushPending(); go(current + 1); };
    $('#btn-mark').onclick = toggleMark;
    $('#btn-submit').onclick = submit;

    return { enter, stop };
  })();

  // ---------- boot ----------
  (async () => {
    if (!slug) return showError('Quiz not found', 'This link is incomplete. Ask your quiz organiser for the full link.');
    // Signed in already (came back to the page, or the phone restarted)? Go straight to the lobby or quiz.
    try { await loadLobby(); return; } catch (ex) {
      if (ex.code === 'SESSION_REPLACED' || ex.code === 'BLOCKED') {
        try { applyInfo((await api('')).quiz); } catch { /* keep the default look */ }
        return;
      }
    }
    try {
      applyInfo((await api('')).quiz);
      show('enter');
    } catch (ex) {
      if (ex.code === 'NO_QUIZ') return showError('Quiz not found', ex.message);
      if (ex.code === 'NOT_OPEN') return showError('Not open yet', ex.message);
      showError('Could not load the quiz', ex.status === 0 ? ex.message : 'Please refresh the page in a moment.');
    }
  })();
})();
