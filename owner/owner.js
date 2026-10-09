(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The panel's address is secret, so the API is found relative to it.
  const API = new URL('api/', location.href.split('#')[0].replace(/[^/]*$/, ''));

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(new URL(path, API), opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error(data.error || 'Please log in.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); };
  const dt = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('login', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); f.reset(); start(); } catch (ex) { $('.error', f).textContent = ex.message; }
  });
  $('#btn-logout').onclick = async () => { await api('logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); };
  $('#btn-password').onclick = () => $('#dlg').showModal();
  $('#dlg-cancel').onclick = () => $('#dlg').close();
  $('#form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('password', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      f.reset(); $('#dlg').close(); toast('Password changed');
    } catch (ex) { $('.error', f).textContent = ex.message; }
  });

  let view = 'organisers';
  let rows = [];
  $$('[data-view]').forEach((b) => { b.onclick = () => { view = b.dataset.view; $$('[data-view]').forEach((x) => x.classList.toggle('active', x === b)); load(true); }; });
  $('#search').oninput = render;

  let first = true;
  async function load(fresh = false) {
    const s = await api('stats');
    $('#tiles').innerHTML = [[s.organisers, 'Organisers'], [s.verified, 'Email confirmed'], [s.quizzes, 'Quizzes'], [s.students, 'Students'], [s.live, 'Taking a quiz now']]
      .map(([n, l]) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`).join('');
    if (first) {
      first = false;
      window.ui.enter($$('#tiles .tile'), { y: 10, stagger: 0.06 });
      $$('#tiles .tile b').forEach((b) => window.ui.count(b, b.textContent));
    }
    rows = await api(view);
    render();
    if (fresh) window.ui.enter($$('#table tr').slice(1, 25), { y: 6, stagger: 0.02, duration: 0.35 });
  }

  function render() {
    const term = $('#search').value.trim().toLowerCase();
    const list = term ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(term)) : rows;
    const t = $('#table');
    if (!list.length) { t.innerHTML = '<tr><td class="empty">Nothing here yet.</td></tr>'; return; }
    if (view === 'quizzes') {
      t.innerHTML = `<tr><th>Quiz</th><th>Organiser</th><th>Opens</th><th>Closes</th><th>Students</th><th>Status</th></tr>${list.map((q) => `
        <tr><td><b>${esc(q.title)}</b><div class="muted small">/q/${esc(q.slug)}</div></td><td>${esc(q.organiser)}<div class="muted small">${esc(q.institution)}</div></td>
        <td class="small">${dt(q.start_at)}</td><td class="small">${dt(q.end_at)}</td><td class="num">${q.students}</td>
        <td>${q.published ? '<span class="badge good">Published</span>' : '<span class="badge">Draft</span>'}</td></tr>`).join('')}`;
      return;
    }
    t.innerHTML = `<tr><th>Organiser</th><th>Institution</th><th>Joined</th><th>Last login</th><th>Quizzes</th><th>Students</th><th>Status</th><th></th></tr>${list.map((o) => `
      <tr>
        <td><b>${esc(o.name)}</b><div class="muted small">${esc(o.email)}${o.phone ? ` · ${esc(o.phone)}` : ''}</div></td>
        <td>${esc(o.institution)}<div class="muted small">${esc(o.designation)}</div></td>
        <td class="small">${dt(o.created_at)}</td><td class="small">${dt(o.last_login_at)}</td>
        <td class="num">${o.quizzes}</td><td class="num">${o.students}</td>
        <td>${o.status === 'suspended' ? '<span class="badge bad">Suspended</span>' : o.email_verified ? '<span class="badge good">Active</span>' : '<span class="badge warn">Email not confirmed</span>'}</td>
        <td>
          ${o.email_verified ? '' : `<button class="btn sm outline" data-act="verify" data-id="${o.id}">Confirm email</button>`}
          <button class="btn sm outline" data-act="${o.status === 'suspended' ? 'active' : 'suspended'}" data-id="${o.id}">${o.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>
          <button class="btn sm danger" data-act="delete" data-id="${o.id}">Delete</button>
        </td>
      </tr>`).join('')}`;
  }

  $('#table').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const o = rows.find((x) => x.id === Number(b.dataset.id));
    const act = b.dataset.act;
    try {
      if (act === 'verify') {
        if (!confirm(`Mark ${o.email} as confirmed without the email code? Do this only if you know this person.`)) return;
        await api(`organisers/${o.id}`, { method: 'PUT', body: { verified: true } });
      } else if (act === 'delete') {
        if (!confirm(`Delete ${o.name} (${o.email}) and ALL their quizzes, questions, students and results? This cannot be undone.`)) return;
        await api(`organisers/${o.id}`, { method: 'DELETE' });
      } else {
        await api(`organisers/${o.id}`, { method: 'PUT', body: { status: act } });
      }
      toast('Done');
      load();
    } catch (ex) { toast(ex.message); }
  });

  async function start() {
    try { await api('me'); } catch { return; }
    $('#login').hidden = true;
    $('#app').hidden = false;
    window.ui.enter($('#app'), { y: 0, duration: 0.35 });
    load(true);
  }
  start();
})();
