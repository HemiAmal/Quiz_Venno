const express = require('express');
const crypto = require('crypto');
const { db, withTransaction } = require('../db');
const {
  clean, cleanText, ah, toPhone, validPhone, validEmail, hashPassword, verifyPassword, newToken, newSlug, newAccessCode,
  newEmailCode, hashCode, parseCookies, setCookie, rateLimit, finalizeAttempt, sweepExpired, sweepIfDue,
} = require('../lib/common');
const { sendCode } = require('../lib/email');
const { normalizeTheme } = require('../lib/theme');

// Organiser API, under /api/org. Organisers sign up with their email, confirm it with a code, and then
// manage only their own quizzes: every route below checks that the quiz (or question, student,
// attempt) belongs to the signed-in organiser.
const router = express.Router();
const COOKIE = 'osid';
const COOKIE_PATH = '/api/org';
const SESSION_DAYS = 7;
const CODE_MINUTES = 15;
const MIN_PASSWORD = 8;

// ---------- sessions ----------
async function startSession(req, res, organiser) {
  const token = newToken();
  const now = Date.now();
  await db.run(`INSERT INTO sessions (token, kind, user_id, created_at, last_seen, ip, user_agent)
              VALUES (?, 'organiser', ?, ?, ?, ?, ?)`, [token, organiser.id, now, now, req.ip, clean(req.headers['user-agent'], 200)]);
  await db.run('UPDATE organisers SET last_login_at=? WHERE id=?', [now, organiser.id]);
  setCookie(res, COOKIE, token, { path: COOKIE_PATH, maxAge: SESSION_DAYS * 86400 });
}

const profile = (o) => ({
  id: o.id, name: o.name, email: o.email, institution: o.institution, designation: o.designation, phone: o.phone, createdAt: o.created_at,
});

// ---------- email codes ----------
// Sends a fresh code, at most one a minute per account and purpose. Returns false if one was sent too recently.
async function issueCode(organiser, purpose) {
  const now = Date.now();
  const last = await db.get('SELECT created_at FROM email_codes WHERE organiser_id=? AND purpose=? ORDER BY created_at DESC LIMIT 1',
    [organiser.id, purpose]);
  if (last && now - last.created_at < 60_000) return false;
  const code = newEmailCode();
  await db.run('DELETE FROM email_codes WHERE organiser_id=? AND purpose=?', [organiser.id, purpose]);
  await db.run('INSERT INTO email_codes (organiser_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [organiser.id, purpose, hashCode(code), now + CODE_MINUTES * 60_000, now]);
  await sendCode(organiser.email, organiser.name, code, purpose);
  return true;
}

// Five wrong tries and the code stops working; a new one has to be requested.
async function checkCode(organiser, purpose, code) {
  const row = await db.get('SELECT * FROM email_codes WHERE organiser_id=? AND purpose=? ORDER BY created_at DESC LIMIT 1',
    [organiser.id, purpose]);
  if (!row || row.expires_at < Date.now()) return 'That code has expired. Ask for a new one.';
  if (row.tries >= 5) return 'Too many wrong codes. Ask for a new one.';
  const given = Buffer.from(hashCode(String(code || '').replace(/\D/g, '')), 'hex');
  if (!crypto.timingSafeEqual(given, Buffer.from(row.code_hash, 'hex'))) {
    await db.run('UPDATE email_codes SET tries = tries + 1 WHERE id=?', [row.id]);
    return 'That code is not right. Check the email and try again.';
  }
  await db.run('DELETE FROM email_codes WHERE organiser_id=? AND purpose=?', [organiser.id, purpose]);
  return null;
}

const findByEmail = (email) => db.get('SELECT * FROM organisers WHERE email=?', [String(email || '').trim().toLowerCase()]);

// ---------- sign up, verify, log in ----------
router.post('/signup', rateLimit('signup', 10, 60 * 60_000), ah(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80);
  const email = String(b.email || '').trim().toLowerCase();
  const institution = clean(b.institution, 150);
  const designation = clean(b.designation, 80);
  const phone = toPhone(b.phone);
  const password = String(b.password || '');
  if (name.length < 2) return res.status(400).json({ field: 'name', error: 'Please enter your full name.' });
  if (!validEmail(email)) return res.status(400).json({ field: 'email', error: 'Please enter a valid email address.' });
  if (institution.length < 2) return res.status(400).json({ field: 'institution', error: 'Please enter your school, college or organisation.' });
  if (phone && !validPhone(phone)) return res.status(400).json({ field: 'phone', error: 'Please enter a valid phone number, or leave it empty.' });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ field: 'password', error: `Password must be at least ${MIN_PASSWORD} characters.` });

  let organiser = await findByEmail(email);
  if (organiser?.email_verified) {
    return res.status(409).json({ field: 'email', error: 'An account with this email already exists. Log in instead.' });
  }
  const now = Date.now();
  if (organiser) {
    // Signed up before but never confirmed the email: take the new details and send a new code.
    await db.run('UPDATE organisers SET name=?, pass_hash=?, institution=?, designation=?, phone=? WHERE id=?',
      [name, hashPassword(password), institution, designation, phone, organiser.id]);
  } else {
    const info = await db.run(`INSERT INTO organisers (name, email, pass_hash, institution, designation, phone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [name, email, hashPassword(password), institution, designation, phone, now]);
    organiser = { id: info.lastInsertRowid };
  }
  organiser = await db.get('SELECT * FROM organisers WHERE id=?', [organiser.id]);
  await issueCode(organiser, 'verify');
  res.json({ ok: true, email });
}));

router.post('/verify', rateLimit('verify', 30, 15 * 60_000), ah(async (req, res) => {
  const organiser = await findByEmail(req.body?.email);
  if (!organiser) return res.status(400).json({ error: 'That code is not right. Check the email and try again.' });
  if (organiser.email_verified) return res.status(400).json({ code: 'VERIFIED', error: 'This email is already confirmed. Please log in.' });
  const problem = await checkCode(organiser, 'verify', req.body?.code);
  if (problem) return res.status(400).json({ error: problem });
  await db.run('UPDATE organisers SET email_verified=1 WHERE id=?', [organiser.id]);
  if (organiser.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  await startSession(req, res, organiser);
  res.json({ ok: true });
}));

router.post('/resend', rateLimit('resend', 8, 15 * 60_000), ah(async (req, res) => {
  const purpose = req.body?.purpose === 'reset' ? 'reset' : 'verify';
  const organiser = await findByEmail(req.body?.email);
  // Same answer whether or not the account exists, so this can't be used to find out who has signed up.
  if (organiser && organiser.status === 'active' && (purpose === 'reset' || !organiser.email_verified)) {
    if (!await issueCode(organiser, purpose)) return res.status(429).json({ error: 'A code was just sent. Please wait a minute before asking again.' });
  }
  res.json({ ok: true });
}));

router.post('/login', rateLimit('org-login', 15, 15 * 60_000), ah(async (req, res) => {
  const organiser = await findByEmail(req.body?.email);
  if (!organiser || !verifyPassword(String(req.body?.password || ''), organiser.pass_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  if (organiser.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  if (!organiser.email_verified) {
    await issueCode(organiser, 'verify');
    return res.status(403).json({ code: 'UNVERIFIED', email: organiser.email, error: 'Please confirm your email first. We have sent you a code.' });
  }
  await startSession(req, res, organiser);
  res.json({ ok: true });
}));

router.post('/forgot', rateLimit('forgot', 8, 15 * 60_000), ah(async (req, res) => {
  const organiser = await findByEmail(req.body?.email);
  if (organiser && organiser.status === 'active') await issueCode(organiser, 'reset');
  res.json({ ok: true }); // same answer either way
}));

router.post('/reset', rateLimit('reset', 20, 15 * 60_000), ah(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ field: 'password', error: `Password must be at least ${MIN_PASSWORD} characters.` });
  const organiser = await findByEmail(req.body?.email);
  if (!organiser || organiser.status !== 'active') return res.status(400).json({ error: 'That code is not right. Check the email and try again.' });
  const problem = await checkCode(organiser, 'reset', req.body?.code);
  if (problem) return res.status(400).json({ error: problem });
  // The code proves they own the address, so this also confirms it.
  await db.run('UPDATE organisers SET pass_hash=?, email_verified=1 WHERE id=?', [hashPassword(password), organiser.id]);
  await db.run("UPDATE sessions SET revoked='password' WHERE kind='organiser' AND user_id=? AND revoked IS NULL", [organiser.id]);
  await startSession(req, res, organiser);
  res.json({ ok: true });
}));

router.post('/logout', ah(async (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.run("UPDATE sessions SET revoked='logout' WHERE token=?", [token]);
  setCookie(res, COOKIE, '', { path: COOKIE_PATH, maxAge: 0 });
  res.json({ ok: true });
}));

// ---------- everything below needs a signed-in organiser ----------
router.use(ah(async (req, res, next) => {
  const token = parseCookies(req)[COOKIE];
  const s = token && await db.get("SELECT * FROM sessions WHERE token=? AND kind='organiser' AND revoked IS NULL", [token]);
  if (!s || s.created_at < Date.now() - SESSION_DAYS * 86400_000) return res.status(401).json({ error: 'Please log in.' });
  const organiser = await db.get('SELECT * FROM organisers WHERE id=?', [s.user_id]);
  if (!organiser || !organiser.email_verified) return res.status(401).json({ error: 'Please log in.' });
  if (organiser.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  req.org = organiser;
  // Every view (dashboard, students, live, results) reflects quizzes whose time has run out.
  await sweepIfDue();
  next();
}));

router.get('/me', (req, res) => res.json(profile(req.org)));

router.put('/profile', ah(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80);
  const institution = clean(b.institution, 150);
  const phone = toPhone(b.phone);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (institution.length < 2) return res.status(400).json({ error: 'Please enter your school, college or organisation.' });
  if (phone && !validPhone(phone)) return res.status(400).json({ error: 'Please enter a valid phone number, or leave it empty.' });
  await db.run('UPDATE organisers SET name=?, institution=?, designation=?, phone=? WHERE id=?',
    [name, institution, clean(b.designation, 80), phone, req.org.id]);
  res.json(profile(await db.get('SELECT * FROM organisers WHERE id=?', [req.org.id])));
}));

router.post('/password', ah(async (req, res) => {
  const { current, next: newPass } = req.body || {};
  if (!verifyPassword(String(current || ''), req.org.pass_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (String(newPass || '').length < MIN_PASSWORD) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
  await db.run('UPDATE organisers SET pass_hash=? WHERE id=?', [hashPassword(String(newPass)), req.org.id]);
  // Sign out every other device.
  const token = parseCookies(req)[COOKIE];
  await db.run("UPDATE sessions SET revoked='password' WHERE kind='organiser' AND user_id=? AND token<>? AND revoked IS NULL", [req.org.id, token]);
  res.json({ ok: true });
}));

// ---------- ownership checks ----------
// :quizId, :questionId, :studentId and :attemptId only resolve to rows of the signed-in organiser's quizzes.
const notFound = (res) => res.status(404).json({ error: 'Not found.' });
// Like ah, but for router.param handlers, which receive the parameter's value as a fourth argument.
const ahParam = (fn) => (req, res, next, id) => fn(req, res, next, id).catch(next);
router.param('quizId', ahParam(async (req, res, next, id) => {
  req.quiz = await db.get('SELECT * FROM quizzes WHERE id=? AND organiser_id=?', [Number(id) || 0, req.org.id]);
  if (!req.quiz) return notFound(res);
  next();
}));
router.param('questionId', ahParam(async (req, res, next, id) => {
  req.question = await db.get(`SELECT qn.* FROM questions qn JOIN quizzes q ON q.id = qn.quiz_id
    WHERE qn.id=? AND q.organiser_id=?`, [Number(id) || 0, req.org.id]);
  if (!req.question) return notFound(res);
  next();
}));
router.param('studentId', ahParam(async (req, res, next, id) => {
  req.student = await db.get(`SELECT s.* FROM students s JOIN quizzes q ON q.id = s.quiz_id
    WHERE s.id=? AND q.organiser_id=?`, [Number(id) || 0, req.org.id]);
  if (!req.student) return notFound(res);
  next();
}));
router.param('attemptId', ahParam(async (req, res, next, id) => {
  req.attempt = await db.get(`SELECT a.* FROM attempts a JOIN quizzes q ON q.id = a.quiz_id
    WHERE a.id=? AND q.organiser_id=?`, [Number(id) || 0, req.org.id]);
  if (!req.attempt) return notFound(res);
  next();
}));

// ---------- dashboard ----------
router.get('/stats', ah(async (req, res) => {
  const now = Date.now();
  const id = req.org.id;
  const [quizzes, students, live, submitted, upcoming] = await Promise.all([
    db.get('SELECT COUNT(*) n FROM quizzes WHERE organiser_id=?', [id]),
    db.get('SELECT COUNT(*) n FROM students s JOIN quizzes q ON q.id=s.quiz_id WHERE q.organiser_id=?', [id]),
    db.get(`SELECT COUNT(*) n FROM attempts a JOIN quizzes q ON q.id=a.quiz_id
      WHERE q.organiser_id=? AND a.status='in_progress' AND a.deadline_at > ?`, [id, now]),
    db.get("SELECT COUNT(*) n FROM attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE q.organiser_id=? AND a.status='submitted'", [id]),
    db.all('SELECT id, title, slug, start_at, end_at, published FROM quizzes WHERE organiser_id=? AND end_at > ? ORDER BY start_at LIMIT 8', [id, now]),
  ]);
  res.json({
    quizzes: Number(quizzes.n), students: Number(students.n), live: Number(live.n), submitted: Number(submitted.n),
    upcoming, serverNow: now,
  });
}));

// ---------- quizzes ----------
const RESULT_MODES = ['none', 'score', 'full'];
function quizFromBody(b) {
  const q = {
    title: clean(b.title, 120), instructions: cleanText(b.instructions, 4000),
    start_at: Number(b.startAt), end_at: Number(b.endAt), duration_min: Math.round(Number(b.durationMin)),
    questions_per_attempt: Math.max(0, Math.round(Number(b.questionsPerAttempt) || 0)),
    max_violations: Math.max(0, Math.round(Number(b.maxViolations) || 0)),
    published: b.published ? 1 : 0,
    show_results: RESULT_MODES.includes(b.showResults) ? b.showResults : 'none',
    extra_label: clean(b.extraLabel, 60),
    access_code: String(b.accessCode || '').trim().toUpperCase(),
  };
  if (!q.title) return { error: 'Title is required.' };
  if (!Number.isFinite(q.start_at) || !Number.isFinite(q.end_at) || q.end_at <= q.start_at) return { error: 'The closing time must be after the opening time.' };
  if (!(q.duration_min >= 1 && q.duration_min <= 600)) return { error: 'Duration must be between 1 and 600 minutes.' };
  if (q.access_code && !/^[A-Z0-9]{4,20}$/.test(q.access_code)) return { error: 'The quiz password must be 4 to 20 letters or digits, without spaces.' };
  return { q };
}

// A new address that no other quiz uses (collisions are astronomically rare, but cheap to rule out).
async function uniqueSlug(tx = db) {
  for (;;) {
    const slug = newSlug();
    if (!await tx.get('SELECT 1 FROM quizzes WHERE slug=?', [slug])) return slug;
  }
}

const quizOut = (q) => ({ ...q, theme: normalizeTheme(q.theme) });

router.get('/quizzes', ah(async (req, res) => {
  const id = req.org.id;
  const [quizzes, qCounts, aCounts] = await Promise.all([
    db.all('SELECT * FROM quizzes WHERE organiser_id=? ORDER BY start_at DESC', [id]),
    db.all('SELECT qn.quiz_id, COUNT(*) n FROM questions qn JOIN quizzes q ON q.id=qn.quiz_id WHERE q.organiser_id=? GROUP BY qn.quiz_id', [id]),
    db.all('SELECT a.quiz_id, a.status, COUNT(*) n FROM attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE q.organiser_id=? GROUP BY a.quiz_id, a.status', [id]),
  ]);
  const questionCount = new Map(qCounts.map((r) => [r.quiz_id, Number(r.n)]));
  res.json(quizzes.map((q) => {
    const mine = aCounts.filter((r) => r.quiz_id === q.id);
    return {
      ...quizOut(q),
      question_count: questionCount.get(q.id) || 0,
      attempt_count: mine.reduce((sum, r) => sum + Number(r.n), 0),
      submitted_count: mine.filter((r) => r.status === 'submitted').reduce((sum, r) => sum + Number(r.n), 0),
    };
  }));
}));

router.post('/quizzes', ah(async (req, res) => {
  const { q, error } = quizFromBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const info = await db.run(`INSERT INTO quizzes (organiser_id, slug, access_code, title, instructions, start_at, end_at, duration_min,
      questions_per_attempt, max_violations, published, show_results, extra_label, theme, created_at)
    VALUES (@org, @slug, @access_code, @title, @instructions, @start_at, @end_at, @duration_min,
      @questions_per_attempt, @max_violations, @published, @show_results, @extra_label, @theme, @now) RETURNING id`,
  {
    ...q, org: req.org.id, slug: await uniqueSlug(), access_code: q.access_code || newAccessCode(),
    theme: JSON.stringify(normalizeTheme(req.body?.theme)), now: Date.now(),
  });
  res.json(quizOut(await db.get('SELECT * FROM quizzes WHERE id=?', [info.lastInsertRowid])));
}));

router.put('/quizzes/:quizId', ah(async (req, res) => {
  const { q, error } = quizFromBody(req.body || {});
  if (error) return res.status(400).json({ error });
  await db.run(`UPDATE quizzes SET title=@title, instructions=@instructions, start_at=@start_at, end_at=@end_at,
    duration_min=@duration_min, questions_per_attempt=@questions_per_attempt, max_violations=@max_violations, published=@published,
    show_results=@show_results, extra_label=@extra_label, access_code=@access_code WHERE id=@id`,
  { ...q, access_code: q.access_code || req.quiz.access_code, id: req.quiz.id });
  res.json({ ok: true });
}));

router.post('/quizzes/:quizId/publish', ah(async (req, res) => {
  const published = req.body?.published ? 1 : 0;
  if (published) {
    const n = await db.get('SELECT COUNT(*) n FROM questions WHERE quiz_id=?', [req.quiz.id]);
    if (!Number(n.n)) return res.status(400).json({ error: 'Add at least one question before publishing.' });
  }
  await db.run('UPDATE quizzes SET published=? WHERE id=?', [published, req.quiz.id]);
  res.json({ ok: true });
}));

// New password; students already signed in stay signed in.
router.post('/quizzes/:quizId/access-code', ah(async (req, res) => {
  const code = newAccessCode();
  await db.run('UPDATE quizzes SET access_code=? WHERE id=?', [code, req.quiz.id]);
  res.json({ accessCode: code });
}));

// QR code of the quiz link, as an SVG image. With ?pw=1 the link also carries the password (#pw=...), so a
// student who scans it only has to type their details: handy when the code is projected in a classroom.
// qr.png is the same picture as a file to download (for WhatsApp, posters, slides).
router.get('/quizzes/:quizId/qr.:format(svg|png)', ah(async (req, res) => {
  const QRCode = require('qrcode');
  let url = `${req.protocol}://${req.get('host')}/q/${req.quiz.slug}`;
  if (req.query.pw === '1') url += `#pw=${req.quiz.access_code}`;
  const opts = { margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } };
  if (req.params.format === 'svg') return res.type('image/svg+xml').send(await QRCode.toString(url, { ...opts, type: 'svg' }));
  const name = `${req.quiz.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'quiz'}-qr.png`;
  res.type('image/png').set('Content-Disposition', `attachment; filename="${name}"`).send(await QRCode.toBuffer(url, { ...opts, width: 1024 }));
}));

router.put('/quizzes/:quizId/theme', ah(async (req, res) => {
  const theme = normalizeTheme(req.body || {});
  await db.run('UPDATE quizzes SET theme=? WHERE id=?', [JSON.stringify(theme), req.quiz.id]);
  res.json(theme);
}));

// Copy of the quiz and its questions, as an unpublished draft with its own link and password.
router.post('/quizzes/:quizId/duplicate', ah(async (req, res) => {
  const src = req.quiz;
  const id = await withTransaction(async (tx) => {
    const info = await tx.run(`INSERT INTO quizzes (organiser_id, slug, access_code, title, instructions, start_at, end_at, duration_min,
        questions_per_attempt, max_violations, published, show_results, extra_label, theme, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING id`,
    [req.org.id, await uniqueSlug(tx), newAccessCode(), `${src.title} (copy)`.slice(0, 120), src.instructions, src.start_at, src.end_at,
      src.duration_min, src.questions_per_attempt, src.max_violations, src.show_results, src.extra_label, src.theme, Date.now()]);
    await tx.run(`INSERT INTO questions (quiz_id, text, image, options, correct, category, difficulty, marks, created_at)
      SELECT ?, text, image, options, correct, category, difficulty, marks, created_at FROM questions WHERE quiz_id=? ORDER BY id`,
    [info.lastInsertRowid, src.id]);
    return info.lastInsertRowid;
  });
  res.json({ id });
}));

router.delete('/quizzes/:quizId', ah(async (req, res) => {
  await db.run('DELETE FROM quizzes WHERE id=?', [req.quiz.id]);
  res.json({ ok: true });
}));

// ---------- questions ----------
function questionFromBody(b) {
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => clean(o, 500)).filter(Boolean);
  const q = {
    text: cleanText(b.text, 2000), image: b.image ? clean(b.image, 400) : null, options,
    correct: Number(b.correct), category: clean(b.category, 40) || 'General',
    difficulty: ['Easy', 'Medium', 'Hard'].includes(b.difficulty) ? b.difficulty : 'Medium',
    marks: Number(b.marks) > 0 ? Math.min(Number(b.marks), 1000) : 1,
  };
  if (!q.text) return { error: 'Question text is required.' };
  if (options.length < 2 || options.length > 6) return { error: 'Give between 2 and 6 options.' };
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= options.length) return { error: 'Choose which option is correct.' };
  if (q.image && !/^\/uploads\/[\w.-]+$|^https:\/\/[^\s"'()<>]+$/.test(q.image)) return { error: 'Invalid image.' };
  return { q };
}

const insertQuestion = (queryable, quizId, q) => queryable.run(
  `INSERT INTO questions (quiz_id, text, image, options, correct, category, difficulty, marks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  [quizId, q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, Date.now()],
);

router.get('/quizzes/:quizId/questions', ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM questions WHERE quiz_id=? ORDER BY id', [req.quiz.id]);
  res.json(rows.map((r) => ({ ...r, options: JSON.parse(r.options) })));
}));

router.post('/quizzes/:quizId/questions', ah(async (req, res) => {
  const { q, error } = questionFromBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const info = await insertQuestion(db, req.quiz.id, q);
  res.json({ id: info.lastInsertRowid });
}));

// Bulk import: rows already parsed from Excel/CSV in the browser.
router.post('/quizzes/:quizId/questions/bulk', ah(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 2000) : [];
  const errors = [];
  let added = 0;
  await withTransaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const { q, error } = questionFromBody(rows[i] || {});
      if (error) { errors.push(`Row ${i + 2}: ${error}`); continue; }
      await insertQuestion(tx, req.quiz.id, q);
      added++;
    }
  });
  res.json({ added, errors });
}));

router.put('/questions/:questionId', ah(async (req, res) => {
  const { q, error } = questionFromBody(req.body || {});
  if (error) return res.status(400).json({ error });
  await db.run('UPDATE questions SET text=?, image=?, options=?, correct=?, category=?, difficulty=?, marks=? WHERE id=?',
    [q.text, q.image, JSON.stringify(q.options), q.correct, q.category, q.difficulty, q.marks, req.question.id]);
  res.json({ ok: true });
}));

router.delete('/questions/:questionId', ah(async (req, res) => {
  await db.run('DELETE FROM questions WHERE id=?', [req.question.id]);
  res.json({ ok: true });
}));

// Images (questions, quiz logo and background) cannot live on the server's disk (Vercel does not keep files
// between requests). With a Vercel Blob store connected they go there and are served from its CDN; otherwise
// they are kept in the database and served from /uploads/<name> (see server.js).
router.post('/upload-image', express.json({ limit: '4mb' }), rateLimit('upload', 120, 60 * 60_000), ah(async (req, res) => {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2.5 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 2.5 MB.' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = require('@vercel/blob');
    const blob = await put(`images/${name}`, buf, { access: 'public', contentType: `image/${m[1]}` });
    return res.json({ url: blob.url });
  }
  await db.run('INSERT INTO images (name, mime, data, organiser_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [name, `image/${m[1]}`, m[2], req.org.id, Date.now()]);
  res.json({ url: `/uploads/${name}` });
}));

// ---------- students of a quiz (created when they enter the password and their details) ----------
// Progress: waiting (entered, not started), doing (quiz in progress), completed (submitted).
router.get('/quizzes/:quizId/students', ah(async (req, res) => {
  const params = [req.quiz.id];
  let where = 'WHERE s.quiz_id = ?';
  if (req.query.q) {
    where += ' AND (s.name ILIKE ? OR s.extra ILIKE ? OR s.phone ILIKE ?)';
    const like = `%${String(req.query.q).slice(0, 80)}%`;
    params.push(like, like, like);
  }
  const rows = await db.all(`SELECT s.*, a.id attempt_id, a.status attempt_status, a.started_at, a.submitted_at, a.score, a.total_marks,
      a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count, a.violations, a.submit_reason,
      (SELECT MAX(last_seen) FROM sessions se WHERE se.kind='student' AND se.user_id=s.id AND se.revoked IS NULL) last_seen
    FROM students s LEFT JOIN attempts a ON a.student_id = s.id ${where} ORDER BY s.created_at DESC LIMIT 10000`, params);
  const progress = (r) => (r.attempt_status === 'submitted' ? 'completed' : r.attempt_status === 'in_progress' ? 'doing' : 'waiting');
  const wanted = req.query.progress;
  res.json(rows.map((r) => ({ ...r, progress: progress(r) })).filter((r) => !wanted || r.progress === wanted));
}));

router.put('/students/:studentId', ah(async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  await db.run('UPDATE students SET status=? WHERE id=?', [status, req.student.id]);
  if (status === 'blocked') await db.run("UPDATE sessions SET revoked='blocked' WHERE kind='student' AND user_id=? AND revoked IS NULL", [req.student.id]);
  res.json({ ok: true });
}));

// Deletes the student and their attempt, so that number can enter the quiz again.
router.delete('/students/:studentId', ah(async (req, res) => {
  await db.run("DELETE FROM sessions WHERE kind='student' AND user_id=?", [req.student.id]);
  await db.run('DELETE FROM students WHERE id=?', [req.student.id]);
  res.json({ ok: true });
}));

// ---------- approved list, per quiz ----------
// While a quiz's list is empty anyone with the password can enter; once it has numbers, only those numbers can.
const UPSERT_APPROVED = `INSERT INTO approved (quiz_id, phone, name, extra, added_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (quiz_id, phone) DO UPDATE SET name = excluded.name, extra = excluded.extra`;

router.get('/quizzes/:quizId/approved', ah(async (req, res) => {
  res.json(await db.all(`SELECT a.phone, a.name, a.extra, a.added_at, (s.id IS NOT NULL) AS entered FROM approved a
    LEFT JOIN students s ON s.quiz_id = a.quiz_id AND s.phone = a.phone WHERE a.quiz_id=? ORDER BY a.name, a.phone`, [req.quiz.id]));
}));

router.post('/quizzes/:quizId/approved', ah(async (req, res) => {
  const phone = toPhone(req.body?.phone);
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid mobile number (digits only).' });
  await db.run(UPSERT_APPROVED, [req.quiz.id, phone, clean(req.body?.name, 80), clean(req.body?.extra, 150), Date.now()]);
  res.json({ ok: true });
}));

router.post('/quizzes/:quizId/approved/bulk', ah(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 20000) : [];
  const errors = [];
  let added = 0;
  await withTransaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const phone = toPhone(rows[i]?.phone);
      if (!validPhone(phone)) { errors.push(`Row ${i + 2}: "${clean(rows[i]?.phone, 30)}" is not a valid mobile number.`); continue; }
      await tx.run(UPSERT_APPROVED, [req.quiz.id, phone, clean(rows[i].name, 80), clean(rows[i].extra, 150), Date.now()]);
      added++;
    }
  });
  res.json({ added, errors });
}));

router.delete('/quizzes/:quizId/approved/:phone', ah(async (req, res) => {
  await db.run('DELETE FROM approved WHERE quiz_id=? AND phone=?', [req.quiz.id, toPhone(req.params.phone)]);
  res.json({ ok: true });
}));

router.delete('/quizzes/:quizId/approved', ah(async (req, res) => {
  await db.run('DELETE FROM approved WHERE quiz_id=?', [req.quiz.id]);
  res.json({ ok: true });
}));

// ---------- live monitor, results, attempt details ----------
router.get('/quizzes/:quizId/live', ah(async (req, res) => {
  await sweepExpired();
  const now = Date.now();
  const quizId = req.quiz.id;
  const [rows, answerRows, submitted, waiting] = await Promise.all([
    db.all(`SELECT a.id, a.started_at, a.deadline_at, a.violations, a.last_seen, a.question_order, s.name, s.extra, s.phone
      FROM attempts a JOIN students s ON s.id=a.student_id
      WHERE a.quiz_id=? AND a.status='in_progress' ORDER BY a.violations DESC, s.name`, [quizId]),
    db.all(`SELECT an.attempt_id, an.chosen, an.marked FROM answers an JOIN attempts a ON a.id = an.attempt_id
      WHERE a.quiz_id=? AND a.status='in_progress'`, [quizId]),
    db.get("SELECT COUNT(*) n FROM attempts WHERE quiz_id=? AND status='submitted'", [quizId]),
    db.get('SELECT COUNT(*) n FROM students s WHERE s.quiz_id=? AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.student_id=s.id)', [quizId]),
  ]);
  const tally = new Map();
  for (const r of answerRows) {
    const t = tally.get(r.attempt_id) || { answered: 0, flagged: 0 };
    if (r.chosen != null) t.answered++;
    if (r.marked === 1) t.flagged++;
    tally.set(r.attempt_id, t);
  }
  res.json({
    serverNow: now,
    rows: rows.map(({ question_order, ...r }) => ({ ...r, ...(tally.get(r.id) || { answered: 0, flagged: 0 }), total: JSON.parse(question_order).length })),
    submitted: Number(submitted.n),
    waiting: Number(waiting.n),
  });
}));

// Ranking: highest score first; ties go to whoever finished faster, then whoever submitted earlier.
router.get('/quizzes/:quizId/results', ah(async (req, res) => {
  await sweepExpired();
  const rows = await db.all(`SELECT a.id, a.score, a.total_marks, a.correct_count, a.wrong_count, a.unanswered_count, a.flagged_count,
      a.time_taken_ms, a.violations, a.submit_reason, a.started_at, a.submitted_at, a.question_order,
      s.id student_id, s.name, s.extra, s.phone, s.created_at entered_at
    FROM attempts a JOIN students s ON s.id=a.student_id
    WHERE a.quiz_id=? AND a.status='submitted'
    ORDER BY a.score DESC, a.time_taken_ms ASC, a.submitted_at ASC`, [req.quiz.id]);
  res.json(rows.map(({ question_order, ...r }, i) => ({ rank: i + 1, ...r, questions: JSON.parse(question_order).length })));
}));

router.get('/attempts/:attemptId', ah(async (req, res) => {
  const a = await db.get(`SELECT a.*, s.name, s.extra, s.phone, s.created_at entered_at, q.title quiz_title, q.extra_label
    FROM attempts a JOIN students s ON s.id=a.student_id JOIN quizzes q ON q.id=a.quiz_id WHERE a.id=?`, [req.attempt.id]);
  const order = JSON.parse(a.question_order);
  const [answerRows, questionRows, violationLog] = await Promise.all([
    db.all('SELECT question_id, chosen, marked FROM answers WHERE attempt_id=?', [a.id]),
    db.all('SELECT id, text, options, correct FROM questions WHERE quiz_id=?', [a.quiz_id]),
    db.all('SELECT type, detail, at FROM violations WHERE attempt_id=? ORDER BY at', [a.id]),
  ]);
  const answers = new Map(answerRows.map((r) => [r.question_id, r]));
  const qs = new Map(questionRows.map((q) => [q.id, q]));
  const { question_order, ...rest } = a;
  res.json({
    ...rest,
    questions: order.map((o, i) => {
      const q = qs.get(o.q);
      const ans = answers.get(o.q);
      const opts = q ? JSON.parse(q.options) : [];
      return {
        n: i + 1, text: q?.text ?? '(deleted question)',
        chosen: ans?.chosen != null ? opts[ans.chosen] : null,
        correctAnswer: q ? opts[q.correct] : null,
        isCorrect: !!q && ans?.chosen === q.correct,
        flagged: !!ans?.marked,
      };
    }),
    violationLog,
  });
}));

router.post('/attempts/:attemptId/submit', ah(async (req, res) => {
  await finalizeAttempt(req.attempt.id, 'organiser');
  res.json({ ok: true });
}));

// Lets a student take the quiz again (e.g. after a genuine technical problem).
router.delete('/attempts/:attemptId', ah(async (req, res) => {
  await db.run('DELETE FROM attempts WHERE id=?', [req.attempt.id]);
  res.json({ ok: true });
}));

module.exports = router;
