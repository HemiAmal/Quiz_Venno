(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ui = window.ui;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- api ----------
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(`/api/org/${path}`, opts); } catch { throw new Error('No internet connection. Please check your network.'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !AUTH_PATHS.includes(path)) { showAuth('login'); throw new Error(data.error || 'Please log in.'); }
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); Object.assign(e, data, { status: res.status }); throw e; }
    return data;
  }
  const AUTH_PATHS = ['login', 'signup', 'verify', 'resend', 'forgot', 'reset', 'me'];
  const post = (p, body = {}) => api(p, { method: 'POST', body });
  const put = (p, body) => api(p, { method: 'PUT', body });
  const del = (p) => api(p, { method: 'DELETE' });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    if (t.hidden) { t.hidden = false; ui.pop(t, { y: 14, scale: 0.96 }); }
    clearTimeout(toast.t);
    toast.t = setTimeout(async () => {
      await ui.out(t, { y: 10, scale: 0.98 });
      t.hidden = true;
      t.style.opacity = ''; t.style.transform = '';
    }, 2800);
  }

  const dt = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const dur = (ms) => {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const ago = (t, now = Date.now()) => {
    if (!t) return 'never';
    const s = Math.round((now - t) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : dt(t);
  };
  const toLocalInput = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const REASONS = { student: 'Submitted', time_up: 'Time up (auto)', violations: 'Auto: warnings', organiser: 'Ended by you' };
  const VIOLATION_LABELS = {
    tab_switch: 'Switched app/tab', window_blur: 'Left window', fullscreen_exit: 'Left full screen', copy_attempt: 'Tried to copy',
    paste_attempt: 'Tried to paste', context_menu: 'Right-click', print_screen: 'Print Screen key', devtools_key: 'Dev tools / save / print key',
    page_reload: 'Reloaded page', new_device_login: 'Logged in on another device',
  };
  const quizUrl = (q) => `${location.origin}/q/${q.slug}`;
  // With a button, the button itself confirms ("Copied ✓") instead of a toast.
  async function copy(text, what = 'Copied', btn = null) {
    try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this:', text); return; }
    if (!btn) return toast(what);
    clearTimeout(btn.copiedT);
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    ui.bump(btn, 1.06);
    btn.copiedT = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('copied'); }, 1400);
  }

  // ---------- dialog ----------
  function dialog({ title, body, actions, wide = false }) {
    const d = $('#dlg');
    d.classList.toggle('wide', wide);
    $('#dlg-title').textContent = title;
    const b = $('#dlg-body');
    if (typeof body === 'string') b.innerHTML = body; else b.replaceChildren(body);
    $('#dlg-error').textContent = '';
    const bar = $('#dlg-actions');
    bar.replaceChildren();
    for (const a of actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${a.cls || 'outline'}`;
      btn.textContent = a.label;
      btn.onclick = async () => {
        if (!a.run) return d.close();
        btn.disabled = true;
        try { const keep = await a.run(b); if (!keep) d.close(); } catch (e) { $('#dlg-error').textContent = e.message; } finally { btn.disabled = false; }
      };
      bar.append(btn);
    }
    if (!d.open) {
      d.showModal();
      ui.pop(d);
    } else if (closing) {
      // Re-opened while the previous one was still fading out: cancel that and come back in.
      closeToken++;
      closing = false;
      ui.pop(d);
    } else {
      ui.enter(b, { y: 6, duration: 0.3 }); // new content in an already open dialog
    }
    b.scrollTop = 0;
    return b;
  }
  // Closing fades the dialog out first. Every close (buttons, ✕, Esc) goes through here.
  const dlgEl = $('#dlg');
  const nativeClose = HTMLDialogElement.prototype.close;
  let closeToken = 0;
  let closing = false;
  dlgEl.close = function close(value) {
    if (!this.open || closing) return;
    closing = true;
    const token = ++closeToken;
    ui.out(this).then(() => {
      if (token !== closeToken) return;
      closing = false;
      this.style.opacity = ''; this.style.transform = '';
      nativeClose.call(this, value);
    });
  };
  dlgEl.addEventListener('cancel', (e) => { e.preventDefault(); dlgEl.close(); });
  $('#dlg-form').addEventListener('submit', (e) => e.preventDefault());
  $('#dlg-close').onclick = () => $('#dlg').close();
  const confirmBox = (title, text, label = 'Confirm', cls = 'danger') => new Promise((resolve) => {
    dialog({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel' }, { label, cls, run: () => { resolve(true); } }] });
    $('#dlg').addEventListener('close', () => resolve(false), { once: true });
  });

  // ---------- SheetJS (loaded only when needed) ----------
  let xlsxLoading;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    xlsxLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the Excel library. Please reload the page.')); };
      document.head.append(s);
    });
    return xlsxLoading;
  }
  async function exportXlsx(filename, sheetName, rows) {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName.slice(0, 31));
    XLSX.writeFile(wb, filename);
  }
  async function downloadTemplate(filename, sheet, rows) {
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
      XLSX.writeFile(wb, filename);
    } catch (ex) { toast(ex.message); }
  }
  async function readSheet(file, raw = true) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer());
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw });
  }

  // ---------- images ----------
  // Large photos are scaled down in the browser before upload; small files go up as they are.
  async function uploadImage(file, maxDim = 1600) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Please choose a PNG, JPG, WEBP or GIF image.');
    let dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    if (file.size > 900 * 1024 && file.type !== 'image/gif') {
      const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = dataUrl; });
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      dataUrl = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86);
    }
    return (await post('upload-image', { dataUrl })).url;
  }

  // ============ auth ============
  let pendingEmail = sessionStorage.getItem('qv.email') || '';
  const setPendingEmail = (e) => { pendingEmail = e; sessionStorage.setItem('qv.email', e); $$('.email-echo').forEach((x) => { x.textContent = e; }); };
  setPendingEmail(pendingEmail);

  function showAuth(panel = 'login') {
    const arriving = $('#auth').hidden;
    $('#app').hidden = true;
    $('#auth').hidden = false;
    if ((panel === 'verify' || panel === 'reset') && !pendingEmail) panel = panel === 'verify' ? 'login' : 'forgot';
    const before = $('.auth-panel:not([hidden])')?.dataset.panel;
    $$('.auth-panel').forEach((p) => { p.hidden = p.dataset.panel !== panel; });
    // Forms slide in from the side they "come from": forward steps from the right, back steps from the left.
    if (before && before !== panel) {
      const order = ['login', 'forgot', 'reset', 'signup', 'verify'];
      ui.slide($(`[data-panel="${panel}"]`), order.indexOf(panel) > order.indexOf(before) ? 1 : -1, 24);
    }
    $$('.auth-panel .error, .auth-panel .ok').forEach((x) => { x.textContent = ''; });
    if (arriving) {
      ui.enter($('.auth-pitch'), { y: 16, duration: 0.7, blur: true });
      ui.enter($$('.ticks li'), { y: 8, delay: 0.25, stagger: 0.07 });
      ui.enter($(`[data-panel="${panel}"]`), { y: 14, delay: 0.1, duration: 0.6 });
    }
    if (location.hash !== `#${panel}`) history.replaceState(null, '', `#${panel}`);
    const first = $(`[data-panel="${panel}"] input:not([disabled])`);
    if (first && window.matchMedia('(pointer: fine)').matches) setTimeout(() => first.focus(), 0);
  }

  function authForm(id, fn) {
    const f = $(id);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.error', f);
      err.textContent = '';
      const btn = $('button.primary', f);
      btn.disabled = true;
      try { await fn(f, Object.fromEntries(new FormData(f))); } catch (ex) {
        err.textContent = ex.message;
        ui.shake(ex.field && f.elements[ex.field] ? f.elements[ex.field] : $('button.primary', f));
        if (ex.field && f.elements[ex.field]) f.elements[ex.field].focus();
      } finally { btn.disabled = false; }
    });
  }

  authForm('#form-login', async (f, data) => {
    try {
      await post('login', data);
    } catch (ex) {
      if (ex.code === 'UNVERIFIED') { setPendingEmail(ex.email); showAuth('verify'); $('#form-verify .ok').textContent = 'We have sent a new code.'; return; }
      throw ex;
    }
    f.reset();
    start();
  });
  authForm('#form-signup', async (f, data) => {
    const r = await post('signup', data);
    setPendingEmail(r.email);
    f.reset();
    showAuth('verify');
  });
  authForm('#form-verify', async (f, data) => {
    try {
      await post('verify', { email: pendingEmail, code: data.code });
    } catch (ex) {
      if (ex.code === 'VERIFIED') { showAuth('login'); return; }
      throw ex;
    }
    f.reset();
    sessionStorage.removeItem('qv.email');
    await start();
    toast('Email confirmed. Welcome to Quiz Venno!');
  });
  authForm('#form-forgot', async (f, data) => {
    await post('forgot', data);
    setPendingEmail(String(data.email).trim().toLowerCase());
    showAuth('reset');
  });
  authForm('#form-reset', async (f, data) => {
    await post('reset', { email: pendingEmail, code: data.code, password: data.password });
    f.reset();
    sessionStorage.removeItem('qv.email');
    await start();
    toast('Password changed');
  });
  $$('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
    const f = b.closest('form');
    $('.error', f).textContent = '';
    try {
      await post('resend', { email: pendingEmail, purpose: b.dataset.resend });
      $('.ok', f).textContent = 'A new code is on its way.';
    } catch (ex) { $('.error', f).textContent = ex.message; }
  }));
  $$('.otp').forEach((i) => i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); }));

  $('#btn-logout').onclick = async () => { await post('logout').catch(() => {}); stopTimers(); showAuth('login'); };

  // ============ app ============
  let me = null;
  let quizzes = [];
  let liveTimer = null;
  let selectedQuiz = Number(localStorage.getItem('qv.quiz')) || null;
  const loaders = {};
  const stopTimers = () => clearInterval(liveTimer);

  function openTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
    stopTimers();
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    window.scrollTo(0, 0);
    ui.indicator($('#tabs'), $(`#tabs button[data-tab="${name}"]`));
    ui.enter($(`#tab-${name}`).children, { y: 8, stagger: 0.04, duration: 0.4 });
    loaders[name]?.({ fresh: true }).catch((ex) => toast(ex.message));
  }
  window.addEventListener('resize', () => ui.indicator($('#tabs'), $('#tabs button.active')));
  // First load of a tab (not the 5-second refreshes): rows and cards arrive one after another.
  const arrive = (els, opts) => ui.enter(Array.from(els).slice(0, 24), { y: 8, stagger: 0.03, duration: 0.4, ...opts });
  $$('#tabs button').forEach((b) => { b.onclick = () => openTab(b.dataset.tab); });

  // All quiz pickers show the same quiz, remembered between visits.
  async function refreshQuizzes() {
    quizzes = await api('quizzes');
    if (!quizzes.some((q) => q.id === selectedQuiz)) selectedQuiz = quizzes[0]?.id ?? null;
    for (const sel of $$('.quiz-picker')) {
      sel.innerHTML = quizzes.length
        ? quizzes.map((q) => `<option value="${q.id}">${esc(q.title)}${q.published ? '' : ' (draft)'}</option>`).join('')
        : '<option value="">No quizzes yet</option>';
      sel.value = selectedQuiz ?? '';
    }
    return quizzes;
  }
  function pickQuiz(id) {
    selectedQuiz = Number(id) || null;
    localStorage.setItem('qv.quiz', String(selectedQuiz || ''));
    for (const sel of $$('.quiz-picker')) sel.value = selectedQuiz ?? '';
  }
  const currentQuiz = () => quizzes.find((q) => q.id === selectedQuiz);
  $$('.quiz-picker').forEach((sel) => sel.addEventListener('change', () => {
    pickQuiz(sel.value);
    const tab = sel.closest('.tab').id.slice(4);
    loaders[tab]?.({ fresh: true }).catch((ex) => toast(ex.message));
  }));
  const noQuizYet = (msg = 'Create a quiz first.') => `<p class="empty">${esc(msg)} <button class="link-btn" data-new-quiz>Create a quiz</button></p>`;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-new-quiz]')) quizForm(null); });

  function quizState(q, now = Date.now()) {
    if (!q.published) return '<span class="badge">Draft</span>';
    if (now < q.start_at) return '<span class="badge info">Scheduled</span>';
    if (now < q.end_at) return '<span class="badge good">Open now</span>';
    return '<span class="badge">Closed</span>';
  }

  // ---------- dashboard ----------
  loaders.dashboard = async ({ fresh } = {}) => {
    const s = await api('stats');
    $('#dash-name').textContent = me.name.split(' ')[0];
    $('#stat-tiles').innerHTML = [
      [s.quizzes, 'Quizzes'], [s.students, 'Students entered'], [s.live, 'Taking a quiz now'], [s.submitted, 'Completed'],
    ].map(([n, l]) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`).join('');
    if (fresh) {
      arrive($$('#stat-tiles .tile'), { stagger: 0.06 });
      $$('#stat-tiles .tile b').forEach((b) => ui.count(b, b.textContent));
    }
    $('#upcoming').innerHTML = s.upcoming.length
      ? `<div class="table-wrap"><table><tr><th>Quiz</th><th>Opens</th><th>Closes</th><th>Status</th><th></th></tr>${s.upcoming.map((q) =>
        `<tr><td><b>${esc(q.title)}</b></td><td class="small">${dt(q.start_at)}</td><td class="small">${dt(q.end_at)}</td><td>${quizState(q, s.serverNow)}</td>
        <td><button class="btn sm outline" data-share="${q.id}">Share</button></td></tr>`).join('')}</table></div>`
      : '<p class="empty">No upcoming quizzes.</p>';
    $('#getting-started').hidden = s.quizzes > 0;
  };
  $('#upcoming').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    await refreshQuizzes();
    shareDialog(quizzes.find((q) => q.id === Number(b.dataset.share)));
  });

  // ---------- quizzes ----------
  loaders.quizzes = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const box = $('#quiz-cards');
    if (!quizzes.length) {
      box.innerHTML = `<div class="card empty-card"><h2>No quizzes yet</h2><p class="muted">Create one, add questions, then publish and share the link.</p><button class="btn primary" data-new-quiz>+ New quiz</button></div>`;
      return;
    }
    const now = Date.now();
    box.innerHTML = quizzes.map((q) => {
      const t = q.theme;
      const qs = q.questions_per_attempt > 0 ? `${Math.min(q.questions_per_attempt, q.question_count)} of ${q.question_count}` : q.question_count;
      const swatch = t.logo
        ? `background-color:${t.bg};background-image:url('${esc(t.logo)}');background-size:80%;background-repeat:no-repeat`
        : `background:${t.bg};color:${t.accent}`;
      return `
      <article class="card qz">
        <div class="qz-top">
          <div class="qz-swatch" style="${swatch}">${t.logo ? '' : esc(q.title.trim()[0] || 'Q').toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div class="qz-title">${esc(q.title)}</div>
            <div class="qz-when">${dt(q.start_at)} → ${dt(q.end_at)} · ${q.duration_min} min</div>
          </div>
          ${quizState(q, now)}
        </div>
        <div class="qz-stats"><span><b>${qs}</b> questions</span><span><b>${q.attempt_count}</b> started</span><span><b>${q.submitted_count}</b> submitted</span></div>
        <div class="qz-access">
          <span>Link</span><code>${esc(quizUrl(q).replace(/^https?:\/\//, ''))}</code><button class="btn ghost sm" data-act="copy-link" data-id="${q.id}">Copy</button>
          <span>Password</span><code class="pw">${esc(q.access_code)}</code><button class="btn ghost sm" data-act="copy-pw" data-id="${q.id}">Copy</button>
        </div>
        <div class="qz-actions">
          <button class="btn sm ${q.published ? 'outline' : 'primary'}" data-act="publish" data-id="${q.id}">${q.published ? 'Unpublish' : 'Publish'}</button>
          <button class="btn sm outline" data-act="share" data-id="${q.id}">Share</button>
          <button class="btn sm outline" data-act="questions" data-id="${q.id}">Questions</button>
          <button class="btn sm outline" data-act="edit" data-id="${q.id}">Settings</button>
          <button class="btn sm outline" data-act="design" data-id="${q.id}">Design</button>
          <button class="btn sm outline" data-act="results" data-id="${q.id}">Results</button>
          <span class="spacer"></span>
          <button class="btn sm ghost" data-act="duplicate" data-id="${q.id}" title="Copy this quiz and its questions">Duplicate</button>
          <button class="btn sm danger" data-act="delete" data-id="${q.id}">Delete</button>
        </div>
      </article>`;
    }).join('');
    if (fresh) arrive($$('#quiz-cards .qz'), { y: 14, stagger: 0.06, duration: 0.5 });
  };
  $('#quiz-cards').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const q = quizzes.find((x) => x.id === Number(b.dataset.id));
    const act = b.dataset.act;
    try {
      if (act === 'copy-link') return copy(quizUrl(q), 'Link copied', b);
      if (act === 'copy-pw') return copy(q.access_code, 'Password copied', b);
      if (act === 'publish') {
        await post(`quizzes/${q.id}/publish`, { published: !q.published });
        await loaders.quizzes();
        if (!q.published) shareDialog(quizzes.find((x) => x.id === q.id), true);
        else toast('Unpublished: students can no longer open it');
        return;
      }
      if (act === 'share') return shareDialog(q);
      if (act === 'edit') return quizForm(q);
      if (act === 'design') return designDialog(q);
      if (act === 'questions' || act === 'results') { pickQuiz(q.id); return openTab(act); }
      if (act === 'duplicate') {
        const r = await post(`quizzes/${q.id}/duplicate`);
        pickQuiz(r.id);
        toast('Copy created as a draft, with its own link and password');
        return loaders.quizzes();
      }
      if (act === 'delete') {
        if (!(await confirmBox('Delete quiz?', `"${q.title}" and all its questions, students and results will be deleted permanently.`, 'Delete'))) return;
        await del(`quizzes/${q.id}`);
        toast('Quiz deleted');
        return loaders.quizzes();
      }
    } catch (ex) { toast(ex.message); }
  });

  function quizForm(q) {
    const now = Date.now();
    const start = q?.start_at ?? Math.ceil((now + 86400000) / 3600000) * 3600000;
    const v = q || {
      title: '', duration_min: 30, questions_per_attempt: 0, max_violations: 3, instructions: '', published: 0,
      end_at: start + 60 * 60000, show_results: 'score', extra_label: 'School / Institution', access_code: '',
    };
    const seg = (name, value, opts) => `<div class="seg">${opts.map(([val, title, sub]) =>
      `<label><input type="radio" name="${name}" value="${val}" ${value === val ? 'checked' : ''}><b>${title}</b><small>${sub}</small></label>`).join('')}</div>`;
    dialog({
      title: q ? 'Quiz settings' : 'New quiz',
      body: `
        <h3 class="section-h">Basics</h3>
        <label>Title<input name="title" value="${esc(v.title)}" maxlength="120" placeholder="e.g. Class 9 Science Quiz – Term 1"></label>
        <label>Instructions for students (optional)<textarea name="instructions" maxlength="4000" placeholder="Shown before they start, under the standard rules.">${esc(v.instructions)}</textarea></label>

        <h3 class="section-h">Schedule</h3>
        <div class="form-grid">
          <label>Opens at<input name="startAt" type="datetime-local" value="${toLocalInput(start)}"><span class="hint-text">Students can start from this time.</span></label>
          <label>Closes at<input name="endAt" type="datetime-local" value="${toLocalInput(v.end_at)}"><span class="hint-text">Everything unfinished is submitted.</span></label>
          <label>Time per student (minutes)<input name="durationMin" type="number" min="1" max="600" value="${v.duration_min}"></label>
        </div>
        <p class="muted small">Example: opens 10:00, closes 11:30, 60 minutes. A student who starts at 10:00 gets the full hour; one who starts at 11:00 gets only until 11:30.</p>

        <h3 class="section-h">Questions</h3>
        <div class="form-grid">
          <label>Questions per student<input name="questionsPerAttempt" type="number" min="0" value="${v.questions_per_attempt}"><span class="hint-text">0 = all. Fewer than your pool = a random set each.</span></label>
          <label>Auto-submit after this many app switches<input name="maxViolations" type="number" min="0" value="${v.max_violations}"><span class="hint-text">0 = never. 3 or more is kinder on phones.</span></label>
        </div>

        <h3 class="section-h">Who can enter</h3>
        <div class="form-grid">
          <label>Quiz password<input name="accessCode" value="${esc(v.access_code)}" maxlength="20" placeholder="${q ? '' : 'Leave empty to generate one'}" style="text-transform:uppercase;letter-spacing:.1em;font-weight:700"><span class="hint-text">4–20 letters or digits. Students need it with the link.</span></label>
          <label>Extra question on the details form<input name="extraLabel" value="${esc(v.extra_label)}" maxlength="60" placeholder="e.g. Class & division, Roll number"><span class="hint-text">Students always give name and mobile. Leave empty to ask nothing else.</span></label>
        </div>

        <h3 class="section-h">After submitting, students see</h3>
        ${seg('showResults', v.show_results, [
          ['none', 'Nothing', 'Just a thank-you'],
          ['score', 'Their score', 'Right after submitting'],
          ['full', 'Score + answers', 'Answers after the quiz closes'],
        ])}`,
      actions: [
        { label: 'Cancel' },
        {
          label: q ? 'Save' : 'Create quiz', cls: 'primary', run: async (b) => {
            const f = (n) => $(`[name=${n}]`, b);
            const body = {
              title: f('title').value, instructions: f('instructions').value, durationMin: f('durationMin').value,
              startAt: new Date(f('startAt').value).getTime(), endAt: new Date(f('endAt').value).getTime(),
              questionsPerAttempt: f('questionsPerAttempt').value, maxViolations: f('maxViolations').value,
              accessCode: f('accessCode').value, extraLabel: f('extraLabel').value,
              showResults: $('[name=showResults]:checked', b)?.value, published: !!v.published,
            };
            if (q) {
              await put(`quizzes/${q.id}`, body);
              toast('Quiz saved');
              if (!$('#tab-quizzes').hidden) loaders.quizzes();
            } else {
              const created = await post('quizzes', body);
              pickQuiz(created.id);
              toast('Quiz created. Now add some questions.');
              openTab('questions');
            }
          },
        },
      ],
    });
  }

  // ---------- share ----------
  function shareDialog(q, justPublished = false) {
    const url = quizUrl(q);
    const msg = `${q.title}\n\nOpens: ${dt(q.start_at)}\nCloses: ${dt(q.end_at)}\nTime: ${q.duration_min} minutes\n\nLink: ${url}\nPassword: ${q.access_code}\n\nOpen the link on your phone or laptop, enter the password and your details, and start when the quiz opens.`;
    const body = dialog({
      title: justPublished ? 'Published! Share it with your students' : 'Share quiz',
      body: `
        ${q.published ? '' : '<p class="hint">This quiz is a <b>draft</b>. Students will see "not open yet" until you publish it.</p>'}
        <label>Quiz link<div class="copy-row"><input readonly value="${esc(url)}"><button type="button" class="btn outline" data-copy="${esc(url)}">Copy</button></div></label>
        <label>Password<div class="copy-row"><input readonly value="${esc(q.access_code)}" style="letter-spacing:.15em;font-weight:700"><button type="button" class="btn outline" data-copy="${esc(q.access_code)}">Copy</button>
          <button type="button" class="btn ghost" id="new-code" title="Students already in stay in">New password</button></div></label>
        <div class="qr-box">
          <img class="qr-img" alt="QR code for the quiz link" width="168" height="168">
          <div class="stack" style="gap:10px">
            <div><b>QR code</b><p class="muted small">Students scan it with their phone camera to open the quiz.</p></div>
            <label class="check"><input type="checkbox" data-qr-pw> Include the password, so students only type their details</label>
            <div class="row" style="justify-content:flex-start">
              <a class="btn outline sm" data-qr-download download>Download PNG</a>
              <button type="button" class="btn outline sm" data-qr-big>Show full screen</button>
            </div>
          </div>
        </div>
        <label>Message to send (WhatsApp, email, class group)<textarea class="share-msg" readonly>${esc(msg)}</textarea></label>
        <div class="row" style="justify-content:flex-start">
          <button type="button" class="btn primary" data-copy-msg>Copy message</button>
          <a class="btn outline" href="${esc(url)}" target="_blank" rel="noopener">Open student page</a>
        </div>`,
      actions: [{ label: 'Done', cls: 'primary' }],
    });
    const qrPw = $('[data-qr-pw]', body);
    const qrSrc = (format) => `/api/org/quizzes/${q.id}/qr.${format}${qrPw.checked ? '?pw=1' : ''}`;
    const showQr = () => {
      const img = $('.qr-img', body);
      img.classList.add('loading');
      img.onload = () => img.classList.remove('loading');
      img.src = qrSrc('svg');
      $('[data-qr-download]', body).href = qrSrc('png');
    };
    showQr();
    qrPw.onchange = showQr;
    body.addEventListener('click', async (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) copy(c.dataset.copy, 'Copied', c);
      if (e.target.closest('[data-copy-msg]')) copy($('.share-msg', body).value, 'Message copied', e.target.closest('[data-copy-msg]'));
      if (e.target.closest('[data-qr-big]')) qrFullScreen(q, qrSrc('svg'));
      if (e.target.closest('#new-code')) {
        if (!confirm('Make a new password? The old one will stop working for anyone who hasn\'t entered yet.')) return;
        const r = await post(`quizzes/${q.id}/access-code`);
        await refreshQuizzes();
        if (!$('#tab-quizzes').hidden) loaders.quizzes();
        shareDialog({ ...q, access_code: r.accessCode });
      }
    });
  }

  // Large QR code with the link and password, for projecting on a classroom screen.
  function qrFullScreen(q, src) {
    const box = document.createElement('div');
    box.className = 'qr-full';
    box.innerHTML = `
      <div class="qr-full-inner">
        <h1>${esc(q.title)}</h1>
        <img src="${esc(src)}" alt="QR code for the quiz link">
        <p class="qr-full-link">${esc(quizUrl(q).replace(/^https?:\/\//, ''))}</p>
        <p class="qr-full-pw">Password <b>${esc(q.access_code)}</b></p>
        <p class="muted small">Press Esc or click anywhere to close</p>
      </div>`;
    $('#dlg').close();
    document.body.append(box);
    box.requestFullscreen?.().catch(() => {});
    const close = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      box.remove();
      document.removeEventListener('keydown', onKey);
      shareDialog(q);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) close(); };
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    // Esc in real full screen only leaves full screen; close the view with it.
    box.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && box.isConnected) close(); });
  }

  // ---------- design ----------
  const PRESETS = [
    ['Venno', { bg: '#fbf7ef', text: '#2d2a2e', accent: '#b31b34' }],
    ['Evergreen', { bg: '#fbf7ef', text: '#2d2a2e', accent: '#1e5b3a' }],
    ['Charcoal', { bg: '#2d2a2e', text: '#fbf7ef', accent: '#dcc7a1' }],
    ['Space', { bg: '#0b0b0b', text: '#f2f2f2', accent: '#ffd500' }],
    ['Ocean', { bg: '#eef6fb', text: '#0c2a3a', accent: '#0a7cc2' }],
    ['Sunset', { bg: '#fff6ef', text: '#2a160c', accent: '#e8590c' }],
    ['Rose', { bg: '#fff5f8', text: '#2b1020', accent: '#d6336c' }],
    ['Slate', { bg: '#1d2430', text: '#e8edf3', accent: '#38bdf8' }],
  ];
  const FONT_NAMES = { sans: 'Clean (sans-serif)', serif: 'Classic (serif)', rounded: 'Friendly (rounded)', mono: 'Technical (monospace)', condensed: 'Compact (condensed)' };

  function designDialog(q) {
    const t = { ...q.theme };
    const body = dialog({
      title: `Design · ${q.title}`,
      wide: true,
      body: `
        <div class="design">
          <div class="design-controls">
            <div class="stack" style="gap:8px"><span class="muted small"><b>Start from a preset</b></span>
              <div class="presets">${PRESETS.map(([name, p], i) => `<button type="button" class="preset" data-preset="${i}" title="${name}" data-name="${name}">
                <span style="background:${p.bg}"></span><span style="background:${p.accent}"></span><span style="background:${p.text}"></span></button>`).join('')}</div>
            </div>
            <div class="colors">
              ${[['bg', 'Background'], ['text', 'Text'], ['accent', 'Accent']].map(([k, l]) => `
                <label>${l}<div class="color-pair"><input type="color" data-color="${k}"><input type="text" data-hex="${k}" maxlength="7"></div></label>`).join('')}
            </div>
            <p class="contrast-note" id="contrast-note"></p>
            <div class="form-grid">
              <label>Font<select data-k="font">${Object.entries(FONT_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
              <label>Corners<select data-k="corners"><option value="square">Square</option><option value="rounded">Rounded</option><option value="pill">Extra round</option></select></label>
            </div>
            <label>Logo (top of the page)<div class="img-pick"><img data-img="logo" alt=""><label class="btn outline sm file">Upload<input type="file" accept="image/*" data-up="logo" hidden></label><button type="button" class="btn ghost sm" data-clear="logo">Remove</button></div>
              <span class="hint-text">A PNG with a transparent background looks best.</span></label>
            <label>Background picture (welcome screen)<div class="img-pick"><img data-img="bgImage" alt=""><label class="btn outline sm file">Upload<input type="file" accept="image/*" data-up="bgImage" hidden></label><button type="button" class="btn ghost sm" data-clear="bgImage">Remove</button></div></label>
            <label data-dim-row>Picture dimming <input type="range" min="0" max="90" step="5" data-k="bgDim"><span class="hint-text">More dimming keeps text readable over busy photos.</span></label>
          </div>
          <div class="preview-wrap">
            <div class="pv-tabs" style="margin-bottom:10px"><button type="button" class="on" data-pv="enter">Welcome</button><button type="button" data-pv="question">Question</button></div>
            <div class="pv" id="pv">
              <div class="pv-bg"></div>
              <div class="pv-inner">
                <div class="pv-head"><img id="pv-logo" alt="" hidden><span class="pv-host">${esc(me.institution)}</span></div>
                <div class="pv-card" data-pv-view="enter">
                  <div class="pv-eyebrow">${esc(me.institution)}</div>
                  <div class="pv-title">${esc(q.title)}</div>
                  <div class="pv-muted">${q.question_count} questions · ${q.duration_min} minutes</div>
                  <div class="pv-field">Quiz password<div class="pv-input">From your teacher</div></div>
                  <div class="pv-field">Full name<div class="pv-input">Your full name</div></div>
                  <div class="pv-btn">Continue →</div>
                </div>
                <div class="pv-card q" data-pv-view="question" hidden>
                  <div style="display:flex;align-items:center"><span class="pv-muted"><b style="color:var(--text)">Q 3</b>/10</span><span class="pv-timer">12:48</span></div>
                  <div class="pv-strip"><span class="a">1</span><span class="a">2</span><span>3</span><span class="m">4</span><span>5</span></div>
                  <div class="pv-eyebrow">Question 3</div>
                  <div style="font-weight:650">Which planet is known as the Red Planet?</div>
                  <div class="pv-opt"><span class="pv-key">A</span>Venus</div>
                  <div class="pv-opt sel"><span class="pv-key">B</span>Mars</div>
                  <div class="pv-opt"><span class="pv-key">C</span>Jupiter</div>
                  <div class="pv-btn">Save &amp; next →</div>
                </div>
              </div>
            </div>
          </div>
        </div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Reset to default', run: () => { Object.assign(t, PRESETS[0][1], { font: 'sans', corners: 'rounded', logo: null, bgImage: null, bgDim: 40 }); sync(); return true; } },
        {
          label: 'Save design', cls: 'primary', run: async () => {
            await put(`quizzes/${q.id}/theme`, t);
            toast('Design saved');
            if (!$('#tab-quizzes').hidden) loaders.quizzes();
          },
        },
      ],
    });

    const pv = $('#pv', body);
    function sync() {
      for (const k of ['bg', 'text', 'accent']) {
        $(`[data-color=${k}]`, body).value = t[k];
        $(`[data-hex=${k}]`, body).value = t[k];
      }
      $('[data-k=font]', body).value = t.font;
      $('[data-k=corners]', body).value = t.corners;
      $('[data-k=bgDim]', body).value = t.bgDim;
      $('[data-dim-row]', body).hidden = !t.bgImage;
      for (const k of ['logo', 'bgImage']) {
        const img = $(`[data-img=${k}]`, body);
        img.hidden = !t[k];
        if (t[k]) img.src = t[k];
        $(`[data-clear=${k}]`, body).hidden = !t[k];
      }
      window.applyQuizTheme(pv, t);
      const logo = $('#pv-logo', body);
      logo.hidden = !t.logo;
      if (t.logo) logo.src = t.logo;
      $('.pv-host', body).hidden = !!t.logo;
      // Warn when the colours are hard to read.
      const c = window.quizThemeContrast;
      const note = $('#contrast-note', body);
      const problems = [];
      if (c(t.text, t.bg) < 4.5) problems.push('text is hard to read on the background');
      if (c(t.accent, t.bg) < 2.2) problems.push('the accent colour barely stands out from the background');
      note.textContent = problems.length ? `Heads up: ${problems.join(', and ')}.` : 'Colours are easy to read.';
      note.className = `contrast-note ${problems.length ? 'bad' : 'muted'}`;
    }
    sync();

    body.addEventListener('input', (e) => {
      const c = e.target.dataset.color;
      const h = e.target.dataset.hex;
      const k = e.target.dataset.k;
      if (c) { t[c] = e.target.value; sync(); }
      if (h && /^#[0-9a-f]{6}$/i.test(e.target.value)) { t[h] = e.target.value.toLowerCase(); sync(); }
      if (k) { t[k] = k === 'bgDim' ? Number(e.target.value) : e.target.value; sync(); }
    });
    body.addEventListener('change', async (e) => {
      const up = e.target.dataset.up;
      if (!up || !e.target.files[0]) return;
      const file = e.target.files[0];
      e.target.value = '';
      try {
        $('#dlg-error').textContent = '';
        toast('Uploading…');
        t[up] = await uploadImage(file, up === 'logo' ? 600 : 1920);
        sync();
        toast('Image added');
      } catch (ex) { $('#dlg-error').textContent = ex.message; }
    });
    body.addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]');
      if (p) { Object.assign(t, PRESETS[Number(p.dataset.preset)][1]); sync(); }
      const clear = e.target.closest('[data-clear]');
      if (clear) { t[clear.dataset.clear] = null; sync(); }
      const v = e.target.closest('[data-pv]');
      if (v) {
        $$('[data-pv]', body).forEach((b) => b.classList.toggle('on', b === v));
        $$('[data-pv-view]', body).forEach((x) => { x.hidden = x.dataset.pvView !== v.dataset.pv; });
        $('.pv-bg', body).hidden = v.dataset.pv !== 'enter';
      }
    });
  }

  // ---------- questions ----------
  let questions = [];
  loaders.questions = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const q = currentQuiz();
    if (!q) { $('#q-list').innerHTML = noQuizYet(); $('#q-summary').textContent = ''; return; }
    questions = await api(`quizzes/${q.id}/questions`);
    const cats = {};
    questions.forEach((x) => { cats[x.category] = (cats[x.category] || 0) + 1; });
    $('#q-summary').textContent = `${plural(questions.length, 'question')} in this quiz${Object.keys(cats).length ? ': ' + Object.entries(cats).map(([c, n]) => `${c} ${n}`).join(', ') : ''}.`
      + (q.published ? '' : ' When you are done, publish it from the Quizzes tab.');
    $('#q-list').innerHTML = questions.length ? questions.map((x, i) => `
      <div class="qitem">
        <div>
          <div class="qt">${i + 1}. ${esc(x.text)}</div>
          ${x.image ? `<img src="${esc(x.image)}" alt="">` : ''}
          <ol type="A">${x.options.map((o, j) => `<li class="${j === x.correct ? 'correct' : ''}">${esc(o)}</li>`).join('')}</ol>
          <div class="qmeta"><span class="badge info">${esc(x.category)}</span><span class="badge">${esc(x.difficulty)}</span><span class="badge">${x.marks} mark${x.marks === 1 ? '' : 's'}</span></div>
        </div>
        <div><button class="btn sm outline" data-edit="${x.id}">Edit</button><button class="btn sm danger" data-del="${x.id}">Delete</button></div>
      </div>`).join('') : '<div class="card empty-card"><h2>No questions yet</h2><p class="muted">Add them one by one, or download the Excel template, fill it in and upload it.</p></div>';
    if (fresh) arrive($$('#q-list .qitem'));
  };
  $('#btn-new-q').onclick = () => { if (currentQuiz()) questionForm(null); else quizForm(null); };
  $('#q-list').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const rm = e.target.closest('[data-del]');
    if (edit) questionForm(questions.find((q) => q.id === Number(edit.dataset.edit)));
    if (rm && await confirmBox('Delete question?', 'This question will be removed from the quiz.', 'Delete')) {
      try { await del(`questions/${rm.dataset.del}`); loaders.questions(); } catch (ex) { toast(ex.message); }
    }
  });

  function questionForm(q) {
    const v = q || { text: '', options: ['', '', '', ''], correct: 0, category: 'General', difficulty: 'Medium', marks: 1, image: null };
    let image = v.image;
    const cats = [...new Set(['General', ...questions.map((x) => x.category)])];
    const body = dialog({
      title: q ? 'Edit question' : 'Add question',
      body: `
        <label>Question<textarea name="text" maxlength="2000">${esc(v.text)}</textarea></label>
        <div class="stack" style="gap:8px"><span class="muted small"><b>Options</b> · select the correct one</span><div id="opts" class="stack" style="gap:8px"></div>
          <button type="button" class="btn ghost sm" id="add-opt" style="align-self:flex-start">+ Add option</button></div>
        <div class="form-grid">
          <label>Category<input name="category" list="cat-list" value="${esc(v.category)}" maxlength="40">
            <datalist id="cat-list">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</datalist></label>
          <label>Difficulty<select name="difficulty"><option>Easy</option><option>Medium</option><option>Hard</option></select></label>
          <label>Marks<input name="marks" type="number" min="0.5" step="0.5" value="${v.marks}"></label>
        </div>
        <div class="stack" style="gap:8px"><span class="muted small"><b>Image</b> (optional)</span>
          <div class="opt-row"><input type="file" accept="image/*" id="q-img-file"><button type="button" class="btn ghost sm" id="q-img-clear">Remove image</button></div>
          <img id="q-img-prev" style="max-height:120px;border-radius:8px;align-self:flex-start" alt=""></div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: q ? 'Save question' : 'Save and add another', cls: 'primary', run: async (b) => {
            const options = $$('#opts input[type=text]', b).map((i) => i.value.trim());
            const correctIdx = $$('#opts input[type=radio]', b).findIndex((r) => r.checked);
            // Drop empty options but keep the correct answer pointing at the right one.
            const kept = options.map((o, i) => ({ o, i })).filter((x) => x.o);
            const payload = {
              text: $('[name=text]', b).value, options: kept.map((x) => x.o), correct: kept.findIndex((x) => x.i === correctIdx),
              category: $('[name=category]', b).value, difficulty: $('[name=difficulty]', b).value, marks: $('[name=marks]', b).value, image,
            };
            if (q) await put(`questions/${q.id}`, payload); else await post(`quizzes/${selectedQuiz}/questions`, payload);
            toast('Question saved');
            await loaders.questions();
            if (!q) { questionForm(null); return true; } // keep adding
          },
        },
      ],
    });
    $('[name=difficulty]', body).value = v.difficulty;
    const opts = $('#opts', body);
    const addOpt = (text = '', checked = false) => {
      const n = opts.children.length;
      if (n >= 6) return;
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML = `<input type="radio" name="correct" ${checked ? 'checked' : ''} aria-label="Correct answer"><b>${'ABCDEF'[n]}</b><input type="text" maxlength="500" placeholder="Option ${'ABCDEF'[n]}">`;
      $('input[type=text]', row).value = text;
      opts.append(row);
    };
    v.options.forEach((o, i) => addOpt(o, i === v.correct));
    $('#add-opt', body).onclick = () => addOpt();
    const prev = $('#q-img-prev', body);
    const showImg = () => { prev.hidden = !image; if (image) prev.src = image; $('#q-img-clear', body).hidden = !image; };
    showImg();
    $('#q-img-clear', body).onclick = () => { image = null; showImg(); };
    $('#q-img-file', body).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { image = await uploadImage(file, 1400); showImg(); } catch (ex) { $('#dlg-error').textContent = ex.message; }
    };
    if (window.matchMedia('(pointer: fine)').matches) $('[name=text]', body).focus();
  }

  const TEMPLATE_HEADERS = ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct (A/B/C/D)', 'Category', 'Difficulty', 'Marks', 'Image URL'];
  $('#btn-template').onclick = () => downloadTemplate('quiz-venno-questions-template.xlsx', 'Questions', [TEMPLATE_HEADERS,
    ['Which planet is known as the Red Planet?', 'Venus', 'Mars', 'Jupiter', 'Mercury', 'B', 'Science', 'Easy', 1, ''],
    ['Who wrote the national anthem of India?', 'Rabindranath Tagore', 'Bankim Chandra Chatterjee', 'Sarojini Naidu', 'Subramania Bharati', 'A', 'General', 'Easy', 1, '']]);

  $('#bulk-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !selectedQuiz) return;
    try {
      const rows = await readSheet(file);
      const pick = (r, ...names) => {
        for (const k of Object.keys(r)) if (names.some((n) => k.trim().toLowerCase().startsWith(n))) return String(r[k]).trim();
        return '';
      };
      const parsed = rows.map((r) => {
        const options = ['option a', 'option b', 'option c', 'option d', 'option e', 'option f'].map((n) => pick(r, n)).filter(Boolean);
        const c = pick(r, 'correct').toUpperCase();
        return {
          text: pick(r, 'question'), options, correct: /^[A-F]$/.test(c) ? 'ABCDEF'.indexOf(c) : Number(c) - 1,
          category: pick(r, 'category') || 'General', difficulty: pick(r, 'difficulty') || 'Medium',
          marks: pick(r, 'marks') || 1, image: pick(r, 'image') || null,
        };
      }).filter((r) => r.text);
      if (!parsed.length) throw new Error(`No questions found. Use the template columns: ${TEMPLATE_HEADERS.join(', ')}`);
      const res = await post(`quizzes/${selectedQuiz}/questions/bulk`, { rows: parsed });
      await loaders.questions();
      dialog({
        title: 'Upload finished',
        body: `<p>Added <b>${plural(res.added, 'question')}</b>.</p>${res.errors.length ? `<p class="error">${plural(res.errors.length, 'row')} skipped:</p><div class="log" style="padding:8px 10px">${res.errors.map(esc).join('<br>')}</div>` : ''}`,
        actions: [{ label: 'OK', cls: 'primary' }],
      });
    } catch (ex) { toast(ex.message); }
  };

  // ---------- students ----------
  const PROGRESS = { waiting: ['Waiting', ''], doing: ['Doing', 'info'], completed: ['Completed', 'good'] };
  let students = [];
  let searchT;
  loaders.students = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const q = currentQuiz();
    if (!q) { $('#student-table').innerHTML = `<tr><td>${noQuizYet()}</td></tr>`; $('#s-count').textContent = ''; return; }
    const qs = new URLSearchParams({ q: $('#s-search').value, progress: $('#s-progress').value });
    students = await api(`quizzes/${q.id}/students?${qs}`);
    const n = (p) => students.filter((s) => s.progress === p).length;
    const extra = q.extra_label;
    $('#s-count').textContent = `${plural(students.length, 'student')} · ${n('waiting')} waiting · ${n('doing')} doing · ${n('completed')} completed`;
    $('#student-table').innerHTML = students.length
      ? `<tr><th>Name</th><th>Mobile</th>${extra ? `<th>${esc(extra)}</th>` : ''}<th>Entered</th><th>Status</th><th>Score</th><th>Right / Wrong / Flagged</th><th></th></tr>${students.map((s) => `
      <tr>
        <td>${s.attempt_id ? `<a href="#" data-view="${s.attempt_id}">${esc(s.name)}</a>` : `<b>${esc(s.name)}</b>`}${s.status === 'blocked' ? ' <span class="badge bad">Blocked</span>' : ''}</td>
        <td class="num">${esc(s.phone)}</td>
        ${extra ? `<td>${esc(s.extra)}</td>` : ''}
        <td class="small">${dt(s.created_at)}</td>
        <td><span class="badge ${PROGRESS[s.progress][1]}">${PROGRESS[s.progress][0]}</span></td>
        <td class="num">${s.progress === 'completed' ? `<b>${s.score}</b> / ${s.total_marks}` : ''}</td>
        <td class="num">${s.progress === 'completed' ? `${s.correct_count} / ${s.wrong_count} / ${s.flagged_count}` : ''}</td>
        <td>
          ${s.attempt_id ? `<button class="btn sm outline" data-view="${s.attempt_id}">Details</button>` : ''}
          <button class="btn sm outline" data-act="${s.status === 'blocked' ? 'active' : 'blocked'}" data-id="${s.id}">${s.status === 'blocked' ? 'Unblock' : 'Block'}</button>
          <button class="btn sm danger" data-act="delete" data-id="${s.id}" title="Remove so this number can start again">Remove</button>
        </td>
      </tr>`).join('')}`
      : `<tr><td class="empty">No students yet. They appear here when they enter the quiz password and their details.</td></tr>`;
    if (fresh) arrive($$('#student-table tr').slice(1), { stagger: 0.02 });
    stopTimers();
    liveTimer = setInterval(() => { if (!$('#tab-students').hidden && !$('#dlg').open) loaders.students().catch(() => {}); }, 5000);
  };
  $('#s-search').oninput = () => { clearTimeout(searchT); searchT = setTimeout(() => loaders.students(), 300); };
  $('#s-progress').onchange = () => loaders.students();
  $('#student-table').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { e.preventDefault(); attemptDetail(v.dataset.view); return; }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const s = students.find((x) => x.id === Number(b.dataset.id));
    const act = b.dataset.act;
    try {
      if (act === 'active' || act === 'blocked') { await put(`students/${s.id}`, { status: act }); toast(`${s.name}: ${act === 'blocked' ? 'blocked' : 'unblocked'}`); }
      if (act === 'delete') {
        if (!(await confirmBox('Remove student?', `${s.name}'s entry, answers and score will be deleted. This mobile number can then start the quiz again.`, 'Remove'))) return;
        await del(`students/${s.id}`);
      }
      loaders.students();
    } catch (ex) { toast(ex.message); }
  });
  $('#btn-export-students').onclick = () => {
    const q = currentQuiz();
    if (!q) return;
    exportXlsx(`${fileName(q)}-students.xlsx`, 'Students', students.map((s) => ({
      Name: s.name, Mobile: s.phone, ...(q.extra_label ? { [q.extra_label]: s.extra } : {}),
      Entered: dt(s.created_at), Status: PROGRESS[s.progress][0],
      Score: s.progress === 'completed' ? s.score : '', 'Total marks': s.progress === 'completed' ? s.total_marks : '',
      Right: s.correct_count ?? '', Wrong: s.wrong_count ?? '', Unanswered: s.unanswered_count ?? '', 'Flagged for review': s.flagged_count ?? '',
      Started: dt(s.started_at), Submitted: dt(s.submitted_at), 'Ended by': REASONS[s.submit_reason] || '', Warnings: s.violations ?? '',
    }))).catch((ex) => toast(ex.message));
  };
  const fileName = (q) => (q?.title || 'quiz').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'quiz';

  // ---------- approved list ----------
  let approved = [];
  const renderApproved = () => {
    const q = currentQuiz();
    const term = $('#a-search').value.trim().toLowerCase();
    const rows = term ? approved.filter((a) => `${a.name} ${a.extra} ${a.phone}`.toLowerCase().includes(term)) : approved;
    const entered = approved.filter((a) => a.entered).length;
    $('#a-status').innerHTML = approved.length
      ? `<b>${approved.length}</b> approved number${approved.length === 1 ? '' : 's'} · ${entered} entered. Only these numbers can enter this quiz.`
      : 'The list is empty, so <b>anyone with the link and password</b> can enter. Upload a list to allow only registered students.';
    const extra = q?.extra_label;
    $('#approved-table').innerHTML = rows.length
      ? `<tr><th>Name</th><th>Mobile</th>${extra ? `<th>${esc(extra)}</th>` : ''}<th>Entered</th><th></th></tr>${rows.map((a) => `
      <tr>
        <td><b>${esc(a.name) || '<span class="muted">—</span>'}</b></td>
        <td class="num">${esc(a.phone)}</td>
        ${extra ? `<td>${esc(a.extra)}</td>` : ''}
        <td>${a.entered ? '<span class="badge good">Yes</span>' : '<span class="badge">Not yet</span>'}</td>
        <td><button class="btn sm danger" data-phone="${esc(a.phone)}">Remove</button></td>
      </tr>`).join('')}`
      : `<tr><td class="empty">${approved.length ? 'No match.' : 'No approved students for this quiz.'}</td></tr>`;
  };
  loaders.approved = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const q = currentQuiz();
    if (!q) { approved = []; $('#a-status').textContent = ''; $('#approved-table').innerHTML = `<tr><td>${noQuizYet()}</td></tr>`; return; }
    approved = await api(`quizzes/${q.id}/approved`);
    renderApproved();
    if (fresh) arrive($$('#approved-table tr').slice(1), { stagger: 0.02 });
  };
  $('#a-search').oninput = renderApproved;
  $('#approved-table').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-phone]');
    if (!b) return;
    const a = approved.find((x) => x.phone === b.dataset.phone);
    if (!(await confirmBox('Remove from list?', `${a.name || a.phone} (${a.phone}) will no longer be able to enter this quiz.`, 'Remove'))) return;
    await del(`quizzes/${selectedQuiz}/approved/${a.phone}`).catch((ex) => toast(ex.message));
    loaders.approved();
  });
  $('#btn-a-add').onclick = () => {
    const q = currentQuiz();
    if (!q) return;
    dialog({
      title: 'Add student',
      body: `<label>Name<input name="name" maxlength="80"></label>
        <label>Mobile number<input name="phone" inputmode="tel" maxlength="16"></label>
        ${q.extra_label ? `<label>${esc(q.extra_label)} (optional)<input name="extra" maxlength="150"></label>` : ''}`,
      actions: [{ label: 'Cancel' }, {
        label: 'Add', cls: 'primary', run: async (b) => {
          await post(`quizzes/${q.id}/approved`, { name: $('[name=name]', b).value, phone: $('[name=phone]', b).value, extra: $('[name=extra]', b)?.value });
          toast('Added to the approved list');
          loaders.approved();
        },
      }],
    });
  };
  $('#btn-a-clear').onclick = async () => {
    if (!selectedQuiz) return;
    if (!(await confirmBox('Clear the approved list?', 'Every number will be removed, and anyone with the link and password will be able to enter until you upload a new list.', 'Clear list'))) return;
    await del(`quizzes/${selectedQuiz}/approved`).catch((ex) => toast(ex.message));
    toast('Approved list cleared');
    loaders.approved();
  };
  $('#btn-a-template').onclick = () => {
    const extra = currentQuiz()?.extra_label || 'School';
    downloadTemplate('quiz-venno-approved-list.xlsx', 'Approved', [['Name', 'Mobile', extra], ['Anika Menon', '9876543210', '']]);
  };
  $('#a-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !selectedQuiz) return;
    try {
      const rows = await readSheet(file, false);
      // Column names vary between registration sheets, so match on the words they usually contain, best word
      // first, skipping columns that contain an excluded word ("School name" is not the student's name).
      const pick = (r, words, not = []) => {
        const keys = Object.keys(r).map((k) => [k, k.trim().toLowerCase()]).filter(([, l]) => !not.some((n) => l.includes(n)));
        for (const w of words) for (const [k, l] of keys) if (l.includes(w)) return String(r[k]).trim();
        return '';
      };
      const extraWords = [(currentQuiz()?.extra_label || '').toLowerCase().split(/\W+/)[0], 'school', 'class', 'institution', 'roll'].filter(Boolean);
      const parsed = rows.map((r) => ({
        name: pick(r, ['name', 'student'], ['school', 'parent', 'father', 'mother', 'guardian', 'institution']),
        phone: pick(r, ['mobile', 'phone', 'whatsapp', 'contact']),
        extra: pick(r, extraWords, ['name']) || pick(r, extraWords),
      })).filter((r) => r.name || r.phone);
      if (!parsed.length) throw new Error('No students found. Use the columns Name and Mobile (download the template).');
      const res = await post(`quizzes/${selectedQuiz}/approved/bulk`, { rows: parsed });
      await loaders.approved();
      dialog({
        title: 'Upload finished',
        body: `<p>Added or updated <b>${plural(res.added, 'student')}</b>.</p>${res.errors.length ? `<p class="error">${plural(res.errors.length, 'row')} skipped:</p><div class="log" style="padding:8px 10px">${res.errors.map(esc).join('<br>')}</div>` : ''}`,
        actions: [{ label: 'OK', cls: 'primary' }],
      });
    } catch (ex) { toast(ex.message); }
  };

  // ---------- live ----------
  loaders.live = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const load = async () => {
      const q = currentQuiz();
      if (!q) { $('#live-table').innerHTML = `<tr><td>${noQuizYet()}</td></tr>`; $('#l-summary').textContent = ''; return; }
      const d = await api(`quizzes/${q.id}/live`);
      $('#l-summary').textContent = `${d.rows.length} taking it now · ${d.waiting} waiting to start · ${d.submitted} submitted`;
      $('#live-table').innerHTML = d.rows.length
        ? `<tr><th>Student</th>${q.extra_label ? `<th>${esc(q.extra_label)}</th>` : ''}<th>Answered</th><th>Flagged</th><th>Time left</th><th>Warnings</th><th>Last seen</th><th></th></tr>${d.rows.map((r) => `
        <tr>
          <td><b>${esc(r.name)}</b><div class="muted small">${esc(r.phone)}</div></td>
          ${q.extra_label ? `<td>${esc(r.extra)}</td>` : ''}
          <td class="num">${r.answered}/${r.total}</td>
          <td class="num">${r.flagged}</td>
          <td class="num">${dur(Math.max(0, r.deadline_at - d.serverNow))}</td>
          <td>${r.violations ? `<span class="badge ${r.violations >= 2 ? 'bad' : 'warn'}">${r.violations}</span>` : '<span class="badge good">0</span>'}</td>
          <td class="small">${ago(r.last_seen, d.serverNow)}</td>
          <td><button class="btn sm outline" data-view="${r.id}">Details</button><button class="btn sm danger" data-end="${r.id}">End now</button></td>
        </tr>`).join('')}`
        : '<tr><td class="empty">Nobody is taking this quiz right now.</td></tr>';
    };
    await load();
    if (fresh) arrive($$('#live-table tr').slice(1), { stagger: 0.02 });
    stopTimers();
    liveTimer = setInterval(() => { if (!$('#dlg').open) load().catch(() => {}); }, 5000);
  };
  $('#live-table').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]');
    const end = e.target.closest('[data-end]');
    if (v) attemptDetail(v.dataset.view);
    if (end && await confirmBox('End this attempt?', 'Their saved answers will be submitted now.', 'End now')) {
      await post(`attempts/${end.dataset.end}/submit`).catch((ex) => toast(ex.message));
      loaders.live();
    }
  });

  // ---------- results ----------
  let results = [];
  loaders.results = async ({ fresh } = {}) => {
    await refreshQuizzes();
    const q = currentQuiz();
    if (!q) { results = []; $('#result-table').innerHTML = `<tr><td>${noQuizYet()}</td></tr>`; return; }
    results = await api(`quizzes/${q.id}/results`);
    renderResults();
    if (fresh) arrive($$('#result-table tr').slice(1), { stagger: 0.025 });
  };
  function renderResults() {
    const top = Number($('#r-top').value) || 0;
    const extra = currentQuiz()?.extra_label;
    $('#result-table').innerHTML = results.length
      ? `<tr><th>#</th><th>Student</th>${extra ? `<th>${esc(extra)}</th>` : ''}<th>Score</th><th>Right</th><th>Wrong</th><th>Unanswered</th><th>Time taken</th><th>Warnings</th><th>Ended by</th><th></th></tr>${results.map((r) => `
      <tr class="${r.rank <= top ? 'short' : ''}">
        <td class="num"><b>${r.rank}</b></td>
        <td><b>${esc(r.name)}</b><div class="muted small">${esc(r.phone)}</div></td>
        ${extra ? `<td>${esc(r.extra)}</td>` : ''}
        <td class="num"><b>${r.score}</b> / ${r.total_marks}</td>
        <td class="num">${r.correct_count}</td><td class="num">${r.wrong_count}</td><td class="num">${r.unanswered_count}</td>
        <td class="num">${dur(r.time_taken_ms)}</td>
        <td>${r.violations ? `<span class="badge ${r.violations >= 2 ? 'bad' : 'warn'}">${r.violations}</span>` : '<span class="badge good">0</span>'}</td>
        <td class="small">${REASONS[r.submit_reason] || esc(r.submit_reason)}</td>
        <td><button class="btn sm outline" data-view="${r.id}">Details</button></td>
      </tr>`).join('')}`
      : '<tr><td class="empty">No submissions yet.</td></tr>';
  }
  $('#r-top').oninput = renderResults;
  $('#result-table').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) attemptDetail(v.dataset.view);
  });
  const resultRow = (q) => (r) => ({
    Rank: r.rank, Name: r.name, Mobile: r.phone, ...(q.extra_label ? { [q.extra_label]: r.extra } : {}),
    Score: r.score, 'Total marks': r.total_marks, Right: r.correct_count, Wrong: r.wrong_count, Unanswered: r.unanswered_count,
    'Flagged for review': r.flagged_count, Questions: r.questions, Entered: dt(r.entered_at), Started: dt(r.started_at),
    'Time taken': dur(r.time_taken_ms), Warnings: r.violations, 'Ended by': REASONS[r.submit_reason] || r.submit_reason, Submitted: dt(r.submitted_at),
  });
  $('#btn-export-all').onclick = () => {
    const q = currentQuiz();
    if (q) exportXlsx(`${fileName(q)}-results.xlsx`, 'Results', results.map(resultRow(q))).catch((ex) => toast(ex.message));
  };
  $('#btn-export-short').onclick = () => {
    const q = currentQuiz();
    const top = Number($('#r-top').value) || 0;
    if (q) exportXlsx(`${fileName(q)}-top${top}.xlsx`, 'Shortlist', results.filter((r) => r.rank <= top).map(resultRow(q))).catch((ex) => toast(ex.message));
  };

  async function attemptDetail(id) {
    let a;
    try { a = await api(`attempts/${id}`); } catch (ex) { return toast(ex.message); }
    dialog({
      title: a.name,
      body: `
        <p class="muted">${esc(a.phone)}${a.extra ? ` · ${esc(a.extra)}` : ''} · ${esc(a.quiz_title)}</p>
        <p class="muted small">Entered ${dt(a.entered_at)} · Started ${dt(a.started_at)}${a.submitted_at ? ` · Submitted ${dt(a.submitted_at)} (${esc(REASONS[a.submit_reason] || a.submit_reason)})` : ' · Still taking the quiz'}</p>
        <div class="tiles">
          <div class="tile"><b>${a.status === 'submitted' ? a.score : '—'}</b><span>Score${a.total_marks ? ` / ${a.total_marks}` : ''}</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.isCorrect).length}</b><span>Right</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.chosen != null && !q.isCorrect).length}</b><span>Wrong</span></div>
          <div class="tile"><b>${a.questions.filter((q) => q.chosen == null).length}</b><span>Unanswered</span></div>
          <div class="tile"><b>${a.violations}</b><span>Warnings</span></div>
          <div class="tile"><b>${a.time_taken_ms != null ? dur(a.time_taken_ms) : '—'}</b><span>Time taken</span></div>
        </div>
        <h3>Activity log</h3>
        <div class="log">${a.violationLog.length ? `<table>${a.violationLog.map((v) => `<tr><td class="small">${dt(v.at)}</td><td>${esc(VIOLATION_LABELS[v.type] || v.type)}</td><td class="muted small">${esc(v.detail || '')}</td></tr>`).join('')}</table>` : '<p class="muted" style="padding:10px">Nothing suspicious recorded.</p>'}</div>
        <h3>Answers</h3>
        <div class="log"><table><tr><th>#</th><th>Question</th><th>Their answer</th><th>Correct answer</th><th>Flagged</th></tr>${a.questions.map((q) => `
          <tr><td>${q.n}</td><td class="small">${esc(q.text)}</td>
          <td>${q.chosen == null ? '<span class="muted">—</span>' : `<span class="badge ${q.isCorrect ? 'good' : 'bad'}">${esc(q.chosen)}</span>`}</td>
          <td class="small">${esc(q.correctAnswer)}</td><td>${q.flagged ? '<span class="badge warn">★</span>' : ''}</td></tr>`).join('')}</table></div>`,
      actions: [
        {
          label: 'Allow retake', cls: 'danger', run: async () => {
            if (!confirm(`Delete this attempt so ${a.name} can take the quiz again? Their current answers and score will be lost.`)) return true;
            await del(`attempts/${a.id}`);
            toast('Attempt deleted. The student can start again.');
            const tab = location.hash.slice(1);
            loaders[tab]?.();
          },
        },
        { label: 'Close', cls: 'primary' },
      ],
    });
  }

  // ---------- account ----------
  loaders.account = async () => {
    const f = $('#form-profile');
    for (const k of ['name', 'email', 'institution', 'designation', 'phone']) f.elements[k].value = me[k] || '';
  };
  $('#form-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('.error', f).textContent = ''; $('.ok', f).textContent = '';
    try {
      me = await put('profile', Object.fromEntries(new FormData(f)));
      showWho();
      $('.ok', f).textContent = 'Saved.';
    } catch (ex) { $('.error', f).textContent = ex.message; }
  });
  $('#form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('.error', f).textContent = ''; $('.ok', f).textContent = '';
    try { await post('password', Object.fromEntries(new FormData(f))); f.reset(); $('.ok', f).textContent = 'Password changed.'; } catch (ex) { $('.error', f).textContent = ex.message; }
  });

  // ---------- boot ----------
  function showWho() {
    $('#who-name').textContent = me.name;
    $('#who-inst').textContent = me.institution;
  }
  const AUTH_PANELS = ['login', 'signup', 'verify', 'forgot', 'reset'];
  async function start() {
    try { me = await api('me'); } catch {
      const h = location.hash.slice(1);
      return showAuth(AUTH_PANELS.includes(h) ? h : 'login');
    }
    showWho();
    const fromAuth = !$('#auth').hidden;
    $('#auth').hidden = true;
    $('#app').hidden = false;
    if (fromAuth) ui.enter($('#app'), { y: 0, duration: 0.35 });
    await refreshQuizzes().catch(() => {});
    const tab = location.hash.slice(1);
    openTab(loaders[tab] ? tab : 'dashboard');
  }
  // Typing #results etc. in the address bar (or Back/Forward) switches the tab or form too.
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (!$('#app').hidden && loaders[h]) openTab(h);
    else if (!$('#auth').hidden && AUTH_PANELS.includes(h)) showAuth(h);
  });
  start();
})();
