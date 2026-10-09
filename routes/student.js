const express = require('express');
const { db } = require('../db');
const {
  clean, ah, toPhone, validPhone, newToken, shuffle, parseCookies, setCookie, hit, hits, TOO_MANY, rateLimit, finalizeAttempt,
} = require('../lib/common');
const { normalizeTheme } = require('../lib/theme');

// Student side of one quiz, everything under /api/q/<slug>/. A student's session cookie is scoped to
// that path, so the same phone can be signed in to two different quizzes at once without mixing them up.
const router = express.Router();
const quizRouter = express.Router({ mergeParams: true });
const COOKIE = 'sid';
const SESSION_DAYS = 2;
const cookiePath = (quiz) => `/api/q/${quiz.slug}/`;

// Loads the quiz from its address. A quiz of a suspended organiser is treated as not existing.
router.use('/q/:slug', ah(async (req, res, next) => {
  const quiz = await db.get(`SELECT q.*, o.name organiser_name, o.institution organiser_institution
    FROM quizzes q JOIN organisers o ON o.id = q.organiser_id
    WHERE q.slug = ? AND o.status = 'active'`, [String(req.params.slug).toLowerCase()]);
  if (!quiz) return res.status(404).json({ code: 'NO_QUIZ', error: 'This quiz does not exist. Check the link with your quiz organiser.' });
  req.quiz = quiz;
  next();
}), quizRouter);

async function publicQuiz(q) {
  const poolRow = await db.get('SELECT COUNT(*) n FROM questions WHERE quiz_id = ?', [q.id]);
  const pool = Number(poolRow.n);
  const count = q.questions_per_attempt > 0 ? Math.min(q.questions_per_attempt, pool) : pool;
  return {
    title: q.title, instructions: q.instructions || '', startAt: q.start_at, endAt: q.end_at,
    durationMin: q.duration_min, questionCount: count, maxViolations: q.max_violations,
    showResults: q.show_results, extraLabel: q.extra_label, theme: normalizeTheme(q.theme),
    organiser: { name: q.organiser_name, institution: q.organiser_institution },
    published: !!q.published,
  };
}

// ---------- auth ----------
const requireStudent = ah(async (req, res, next) => {
  const token = parseCookies(req)[COOKIE];
  const session = token && await db.get("SELECT * FROM sessions WHERE token = ? AND kind = 'student'", [token]);
  const student = session && await db.get('SELECT * FROM students WHERE id = ? AND quiz_id = ?', [session.user_id, req.quiz.id]);
  if (!student) return res.status(401).json({ code: 'NO_SESSION', error: 'Please enter the quiz password and your details.' });
  if (session.revoked) {
    const msg = session.revoked === 'replaced'
      ? 'Your details were entered on another device, so this device was logged out.'
      : 'You have been logged out.';
    return res.status(401).json({ code: 'SESSION_REPLACED', error: msg });
  }
  if (student.status === 'blocked') return res.status(403).json({ code: 'BLOCKED', error: 'Your access to this quiz has been blocked. Please contact the organiser.' });
  await db.run('UPDATE sessions SET last_seen = ? WHERE token = ?', [Date.now(), token]);
  req.student = student;
  next();
});

// ---------- public ----------
quizRouter.get('/', ah(async (req, res) => {
  if (!req.quiz.published) return res.status(404).json({ code: 'NOT_OPEN', error: 'This quiz is not open yet. Check back later or ask your quiz organiser.' });
  res.json({ quiz: await publicQuiz(req.quiz), serverNow: Date.now() });
}));

// The password and the student's details in one step. The first entry creates the student; entering the same
// mobile number again (phone restarted, other device) signs back in to the same student and attempt.
quizRouter.post('/enter', rateLimit('enter', 300, 15 * 60_000), ah(async (req, res) => {
  const quiz = req.quiz;
  const b = req.body || {};
  if (!quiz.published) return res.status(403).json({ error: 'This quiz is not open yet.' });

  // Wrong passwords are counted per visitor and quiz, so the password can't be guessed by trying many.
  const pwKey = `quizpw:${quiz.id}:${req.ip}`;
  if (await hits(pwKey) >= 20) return res.status(429).json(TOO_MANY);
  if (String(b.password || '').trim().toUpperCase() !== quiz.access_code.toUpperCase()) {
    await hit(pwKey, 15 * 60_000);
    return res.status(403).json({ field: 'password', error: 'That quiz password is not right. Check it with your organiser.' });
  }

  const name = clean(b.name, 80);
  const phone = toPhone(b.phone);
  const extra = clean(b.extra, 150);
  if (name.length < 2) return res.status(400).json({ field: 'name', error: 'Please enter your full name.' });
  if (!validPhone(phone)) return res.status(400).json({ field: 'phone', error: 'Please enter your mobile number (digits only).' });
  if (quiz.extra_label && !extra) return res.status(400).json({ field: 'extra', error: `Please fill in "${quiz.extra_label}".` });

  const now = Date.now();
  let student = await db.get('SELECT * FROM students WHERE quiz_id = ? AND phone = ?', [quiz.id, phone]);
  if (!student) {
    const listed = await db.get(`SELECT EXISTS (SELECT 1 FROM approved WHERE quiz_id = ? AND phone = ?) AS ok,
      EXISTS (SELECT 1 FROM approved WHERE quiz_id = ?) AS active`, [quiz.id, phone, quiz.id]);
    if (listed.active && !listed.ok) {
      return res.status(403).json({ field: 'phone', error: 'This mobile number is not on the list for this quiz. Contact your organiser.' });
    }
    if (now >= quiz.end_at) return res.status(403).json({ error: 'This quiz has closed.' });
    try {
      const info = await db.run('INSERT INTO students (quiz_id, name, phone, extra, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [quiz.id, name, phone, extra, now]);
      student = await db.get('SELECT * FROM students WHERE id = ?', [info.lastInsertRowid]);
    } catch (e) {
      if (!/unique/i.test(String(e.message))) throw e; // double tap on "Continue": the first one wins
      student = await db.get('SELECT * FROM students WHERE quiz_id = ? AND phone = ?', [quiz.id, phone]);
    }
  } else {
    if (student.status === 'blocked') return res.status(403).json({ error: 'Your access to this quiz has been blocked. Please contact the organiser.' });
    // One device at a time, and a running quiz records the switch.
    const older = await db.all("SELECT token FROM sessions WHERE kind='student' AND user_id=? AND revoked IS NULL", [student.id]);
    if (older.length) {
      await db.run("UPDATE sessions SET revoked='replaced' WHERE kind='student' AND user_id=? AND revoked IS NULL", [student.id]);
      const running = await db.get("SELECT id FROM attempts WHERE student_id=? AND status='in_progress'", [student.id]);
      if (running) {
        await db.run('INSERT INTO violations (attempt_id, type, detail, at) VALUES (?, ?, ?, ?)',
          [running.id, 'new_device_login', clean(req.headers['user-agent'], 200), now]);
      }
    }
  }

  const token = newToken();
  await db.run(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
              VALUES (?, 'student', ?, ?, ?, ?, ?)`,
  [token, student.id, now, now, req.ip, clean(req.headers['user-agent'], 200)]);
  setCookie(res, COOKIE, token, { path: cookiePath(quiz), maxAge: SESSION_DAYS * 86400 });
  res.json({ ok: true });
}));

quizRouter.post('/logout', ah(async (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.run("UPDATE sessions SET revoked='logout' WHERE token=?", [token]);
  setCookie(res, COOKIE, '', { path: cookiePath(req.quiz), maxAge: 0 });
  res.json({ ok: true });
}));

// ---------- result (what the organiser chose to show) ----------
async function resultFor(quiz, attempt) {
  if (!attempt || attempt.status !== 'submitted' || quiz.show_results === 'none') return null;
  const result = {
    score: attempt.score, totalMarks: attempt.total_marks, correct: attempt.correct_count,
    wrong: attempt.wrong_count, unanswered: attempt.unanswered_count,
  };
  if (quiz.show_results !== 'full') return result;
  // Answers only once the quiz has closed for everyone, so they can't be passed to students still taking it.
  if (Date.now() < quiz.end_at) return { ...result, reviewAt: quiz.end_at };
  const order = JSON.parse(attempt.question_order);
  const ids = order.map((o) => o.q);
  const [qs, ans] = await Promise.all([
    ids.length ? db.all(`SELECT id, text, image, options, correct FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [],
    db.all('SELECT question_id, chosen FROM answers WHERE attempt_id = ?', [attempt.id]),
  ]);
  const qMap = new Map(qs.map((q) => [q.id, q]));
  const aMap = new Map(ans.map((a) => [a.question_id, a.chosen]));
  result.review = order.filter((o) => qMap.has(o.q)).map((o) => {
    const q = qMap.get(o.q);
    const options = JSON.parse(q.options);
    const chosen = aMap.get(o.q);
    return {
      text: q.text, image: q.image,
      options: o.o.map((orig) => options[orig]),
      chosen: chosen != null ? o.o.indexOf(chosen) : null,
      correct: o.o.indexOf(q.correct),
    };
  });
  return result;
}

// ---------- signed in ----------
quizRouter.get('/me', requireStudent, ah(async (req, res) => {
  const s = req.student;
  const quiz = req.quiz;
  let attempt = await db.get('SELECT * FROM attempts WHERE student_id=?', [s.id]);
  if (attempt && attempt.status === 'in_progress' && attempt.deadline_at <= Date.now()) {
    attempt = await finalizeAttempt(attempt.id, 'time_up');
  }
  res.json({
    student: { name: s.name, phone: s.phone, extra: s.extra },
    quiz: await publicQuiz(quiz),
    attemptStatus: attempt?.status || null,
    result: await resultFor(quiz, attempt),
    serverNow: Date.now(),
  });
}));

quizRouter.post('/attempt/start', requireStudent, ah(async (req, res) => {
  const s = req.student;
  const quiz = req.quiz;
  const now = Date.now();
  const existing = await db.get('SELECT * FROM attempts WHERE student_id=?', [s.id]);
  if (existing) {
    if (existing.status === 'submitted') return res.status(409).json({ code: 'SUBMITTED', error: 'You have already submitted this quiz.' });
    return res.json({ ok: true, resumed: true });
  }
  if (!quiz.published) return res.status(403).json({ error: 'This quiz is not open.' });
  if (now < quiz.start_at) return res.status(403).json({ error: 'The quiz has not started yet.' });
  if (now >= quiz.end_at) return res.status(403).json({ error: 'The quiz has closed.' });

  const pool = await db.all('SELECT id, options FROM questions WHERE quiz_id=?', [quiz.id]);
  if (!pool.length) return res.status(503).json({ error: 'The quiz is not ready yet. Please try again shortly.' });
  const take = quiz.questions_per_attempt > 0 ? Math.min(quiz.questions_per_attempt, pool.length) : pool.length;
  // Each student gets their own random subset, question order and option order.
  const order = shuffle(pool).slice(0, take).map((q) => ({
    q: q.id,
    o: shuffle(JSON.parse(q.options).map((_, i) => i)),
  }));
  const deadline = Math.min(now + quiz.duration_min * 60_000, quiz.end_at);
  try {
    await db.run(`INSERT INTO attempts (quiz_id, student_id, started_at, deadline_at, question_order, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)`, [quiz.id, s.id, now, deadline, JSON.stringify(order), now]);
  } catch (e) {
    if (!/unique/i.test(String(e.message))) throw e; // double tap on "Start": the first one wins
  }
  res.json({ ok: true });
}));

// Loads the running attempt; auto-submits it if time is up.
const requireAttempt = ah(async (req, res, next) => {
  const a = await db.get("SELECT * FROM attempts WHERE student_id=? AND status='in_progress'", [req.student.id]);
  if (!a) return res.status(409).json({ code: 'SUBMITTED', error: 'Your quiz has been submitted.' });
  const now = Date.now();
  if (a.deadline_at <= now) {
    await finalizeAttempt(a.id, 'time_up');
    return res.status(409).json({ code: 'SUBMITTED', error: 'Time is up. Your saved answers have been submitted.' });
  }
  await db.run('UPDATE attempts SET last_seen=? WHERE id=?', [now, a.id]);
  req.attempt = a;
  req.order = JSON.parse(a.question_order);
  next();
});
const inQuiz = [requireStudent, requireAttempt];

quizRouter.get('/attempt', inQuiz, ah(async (req, res) => {
  const a = req.attempt;
  const rows = await db.all('SELECT question_id, chosen, marked FROM answers WHERE attempt_id=?', [a.id]);
  const answers = new Map(rows.map((r) => [r.question_id, r]));
  res.json({
    total: req.order.length,
    answered: req.order.map((o) => answers.get(o.q)?.chosen != null),
    marked: req.order.map((o) => !!answers.get(o.q)?.marked),
    remainingMs: a.deadline_at - Date.now(),
    violations: a.violations,
    maxViolations: req.quiz.max_violations,
    serverNow: Date.now(),
  });
}));

// One question at a time, options in this student's order, and never the correct answer.
quizRouter.get('/attempt/q/:n', inQuiz, ah(async (req, res) => {
  const n = Number(req.params.n);
  const entry = req.order[n];
  if (!Number.isInteger(n) || !entry) return res.status(404).json({ error: 'Question not found.' });
  const q = await db.get('SELECT id, text, image, options FROM questions WHERE id=?', [entry.q]);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const options = JSON.parse(q.options);
  const saved = await db.get('SELECT chosen, marked FROM answers WHERE attempt_id=? AND question_id=?', [req.attempt.id, q.id]);
  res.json({
    index: n,
    text: q.text,
    image: q.image,
    options: entry.o.map((orig) => options[orig]),
    chosen: saved?.chosen != null ? entry.o.indexOf(saved.chosen) : null,
    marked: !!saved?.marked,
    remainingMs: req.attempt.deadline_at - Date.now(),
  });
}));

quizRouter.post('/attempt/answer', inQuiz, ah(async (req, res) => {
  const n = Number(req.body?.index);
  const entry = req.order[n];
  if (!Number.isInteger(n) || !entry) return res.status(400).json({ error: 'Invalid question.' });
  const display = req.body?.choice;
  let chosen = null;
  if (display != null) {
    if (!Number.isInteger(display) || display < 0 || display >= entry.o.length) return res.status(400).json({ error: 'Invalid option.' });
    chosen = entry.o[display]; // map back to the original option index
  }
  await db.run(`INSERT INTO answers (attempt_id, question_id, chosen, marked, answered_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(attempt_id, question_id) DO UPDATE SET chosen=excluded.chosen, marked=excluded.marked, answered_at=excluded.answered_at`,
  [req.attempt.id, entry.q, chosen, req.body?.marked ? 1 : 0, Date.now()]);
  res.json({ ok: true, remainingMs: req.attempt.deadline_at - Date.now() });
}));

const VIOLATION_TYPES = new Set(['tab_switch', 'window_blur', 'fullscreen_exit', 'copy_attempt', 'paste_attempt',
  'context_menu', 'print_screen', 'devtools_key', 'page_reload']);

quizRouter.post('/attempt/violation', inQuiz, ah(async (req, res) => {
  const type = String(req.body?.type || '');
  if (!VIOLATION_TYPES.has(type)) return res.status(400).json({ error: 'Unknown event.' });
  const now = Date.now();
  const a = req.attempt;
  await db.run('INSERT INTO violations (attempt_id, type, detail, at) VALUES (?, ?, ?, ?)',
    [a.id, type, clean(req.body?.detail, 200), now]);

  // Only leaving the quiz screen counts toward auto-submit; key presses and right-clicks are just logged.
  const counts = ['tab_switch', 'window_blur', 'fullscreen_exit'].includes(type);
  let violations = a.violations;
  if (counts) {
    violations++;
    await db.run('UPDATE attempts SET violations=? WHERE id=?', [violations, a.id]);
  }
  const max = req.quiz.max_violations;
  if (counts && max > 0 && violations >= max) {
    await finalizeAttempt(a.id, 'violations');
    return res.json({ violations, maxViolations: max, submitted: true });
  }
  res.json({ violations, maxViolations: max, submitted: false });
}));

quizRouter.post('/attempt/submit', inQuiz, ah(async (req, res) => {
  await finalizeAttempt(req.attempt.id, 'student');
  res.json({ ok: true });
}));

module.exports = router;
