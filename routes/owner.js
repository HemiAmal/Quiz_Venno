const express = require('express');
const { db } = require('../db');
const {
  clean, ah, hashPassword, verifyPassword, newToken, parseCookies, setCookie, rateLimit,
} = require('../lib/common');

// Owner panel API: whoever runs this deployment sees every organiser and can suspend, confirm or remove them.
// It lives under a secret path (see server.js), like the panel itself.
const COOKIE = 'wsid';
const SESSION_HOURS = 12;

module.exports = function ownerRouter(ownerPath) {
  const router = express.Router();
  const cookieOpts = { path: ownerPath };

  router.post('/login', rateLimit('owner-login', 10, 15 * 60_000), ah(async (req, res) => {
    const owner = await db.get('SELECT * FROM owners WHERE username=?', [clean(req.body?.username, 60)]);
    if (!owner || !verifyPassword(String(req.body?.password || ''), owner.pass_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    const token = newToken();
    const now = Date.now();
    await db.run(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
                VALUES (?, 'owner', ?, ?, ?, ?, ?)`, [token, owner.id, now, now, req.ip, clean(req.headers['user-agent'], 200)]);
    setCookie(res, COOKIE, token, { ...cookieOpts, maxAge: SESSION_HOURS * 3600 });
    res.json({ ok: true });
  }));

  router.post('/logout', ah(async (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) await db.run("UPDATE sessions SET revoked='logout' WHERE token=?", [token]);
    setCookie(res, COOKIE, '', { ...cookieOpts, maxAge: 0 });
    res.json({ ok: true });
  }));

  router.use(ah(async (req, res, next) => {
    const token = parseCookies(req)[COOKIE];
    const s = token && await db.get("SELECT * FROM sessions WHERE token=? AND kind='owner' AND revoked IS NULL", [token]);
    if (!s || s.created_at < Date.now() - SESSION_HOURS * 3600_000) return res.status(401).json({ error: 'Please log in.' });
    req.owner = await db.get('SELECT id, username, pass_hash FROM owners WHERE id=?', [s.user_id]);
    if (!req.owner) return res.status(401).json({ error: 'Please log in.' });
    next();
  }));

  router.get('/me', (req, res) => res.json({ username: req.owner.username }));

  router.post('/password', ah(async (req, res) => {
    const { current, next: newPass } = req.body || {};
    if (!verifyPassword(String(current || ''), req.owner.pass_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
    if (String(newPass || '').length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
    await db.run('UPDATE owners SET pass_hash=? WHERE id=?', [hashPassword(String(newPass)), req.owner.id]);
    res.json({ ok: true });
  }));

  router.get('/stats', ah(async (req, res) => {
    const now = Date.now();
    const [organisers, verified, quizzes, students, live] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM organisers'),
      db.get('SELECT COUNT(*) n FROM organisers WHERE email_verified=1'),
      db.get('SELECT COUNT(*) n FROM quizzes'),
      db.get('SELECT COUNT(*) n FROM students'),
      db.get("SELECT COUNT(*) n FROM attempts WHERE status='in_progress' AND deadline_at > ?", [now]),
    ]);
    res.json({
      organisers: Number(organisers.n), verified: Number(verified.n), quizzes: Number(quizzes.n),
      students: Number(students.n), live: Number(live.n),
    });
  }));

  router.get('/organisers', ah(async (req, res) => {
    res.json(await db.all(`SELECT o.id, o.name, o.email, o.institution, o.designation, o.phone, o.email_verified, o.status,
        o.created_at, o.last_login_at,
        (SELECT COUNT(*) FROM quizzes q WHERE q.organiser_id = o.id) quizzes,
        (SELECT COUNT(*) FROM students s JOIN quizzes q ON q.id = s.quiz_id WHERE q.organiser_id = o.id) students
      FROM organisers o ORDER BY o.created_at DESC`));
  }));

  router.get('/quizzes', ah(async (req, res) => {
    res.json(await db.all(`SELECT q.id, q.title, q.slug, q.start_at, q.end_at, q.published, o.name organiser, o.institution,
        (SELECT COUNT(*) FROM students s WHERE s.quiz_id = q.id) students
      FROM quizzes q JOIN organisers o ON o.id = q.organiser_id ORDER BY q.start_at DESC LIMIT 500`));
  }));

  router.put('/organisers/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (status !== undefined) {
      if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
      await db.run('UPDATE organisers SET status=? WHERE id=?', [status, id]);
      if (status === 'suspended') await db.run("UPDATE sessions SET revoked='suspended' WHERE kind='organiser' AND user_id=? AND revoked IS NULL", [id]);
    }
    // For an organiser whose verification email never arrived.
    if (req.body?.verified === true) await db.run('UPDATE organisers SET email_verified=1 WHERE id=?', [id]);
    res.json({ ok: true });
  }));

  // Removes the organiser with all their quizzes, questions, students and results.
  router.delete('/organisers/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    await db.run("DELETE FROM sessions WHERE kind='organiser' AND user_id=?", [id]);
    await db.run('DELETE FROM organisers WHERE id=?', [id]);
    res.json({ ok: true });
  }));

  return router;
};
