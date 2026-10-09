const path = require('path');
const fs = require('fs');

// Two ways to reach Postgres, same SQL for both:
//  - Hosted (Vercel): the Postgres (Neon) integration injects POSTGRES_URL; a plain Neon project uses DATABASE_URL.
//  - Local development with neither set: PGlite, a real Postgres engine that runs inside Node and keeps
//    its files in DATA_DIR/venno-pg. Nothing to install, and `npm start` works offline.
// Each driver exposes query(text, values) -> { rows, fields, rowCount }, exec(sql) for the multi-statement
// schema, and transaction(fn) where fn receives a query function pinned to one connection.
const CONNECTION = findConnection();

// Vercel names the variable POSTGRES_URL or DATABASE_URL, optionally with a prefix chosen when the
// database was connected (e.g. STORAGE_POSTGRES_URL). Pooled addresses are preferred; if only a direct
// Neon address is present it is turned into the pooled one (same host with "-pooler" on the first part),
// because a serverless function opens far more connections than a direct address allows.
function findConnection() {
  const env = process.env;
  const named = Object.keys(env).filter((k) => /(^|_)(POSTGRES_URL|DATABASE_URL)$/.test(k) && env[k]);
  const direct = Object.keys(env).filter((k) => /(^|_)(POSTGRES_URL_NON_POOLING|DATABASE_URL_UNPOOLED)$/.test(k) && env[k]);
  const pick = ['POSTGRES_URL', 'DATABASE_URL', ...named, ...direct].map((k) => env[k]).find(Boolean);
  if (!pick) return null;
  try {
    const url = new URL(pick);
    if (url.hostname.endsWith('.neon.tech') && !url.hostname.split('.')[0].endsWith('-pooler')) {
      url.hostname = url.hostname.replace(/^([^.]+)/, '$1-pooler');
      return url.toString();
    }
  } catch { /* not a URL we can adjust: use it as given */ }
  return pick;
}

function hostedDriver() {
  const { createPool } = require('@vercel/postgres');
  const pool = createPool({ connectionString: CONNECTION });
  return {
    query: (text, values) => pool.query(text, values),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      // One pinned connection: the pool hands out a different one per query, which would break atomicity.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, values) => client.query(text, values));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

function localDriver() {
  if (process.env.VERCEL) {
    const e = new Error('No database is connected. In Vercel open this project, go to Storage, create or connect a Postgres (Neon) database, then redeploy.');
    e.setup = true; // safe to show to the visitor: it says what to set up and contains nothing secret
    throw e;
  }
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'venno-pg');
  fs.mkdirSync(dir, { recursive: true });
  // Built from parts so Vercel's bundler does not pull this dev-only package into the deployed function.
  const { PGlite } = require(['@electric-sql', 'pglite'].join('/'));
  const pg = new PGlite(dir);
  const shape = (r) => ({ rows: r.rows, fields: r.fields, rowCount: r.affectedRows });
  return {
    query: async (text, values) => shape(await pg.query(text, values)),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn(async (text, values) => shape(await tx.query(text, values)))),
  };
}

// Created on first use, not when this file loads: a missing or wrong database then shows up as a
// readable error page (see server.js) instead of crashing the whole function on Vercel.
let opened;
const open = () => { if (!opened) opened = CONNECTION ? hostedDriver() : localDriver(); return opened; };
const driver = {
  query: async (text, values) => open().query(text, values),
  exec: async (sql) => open().exec(sql),
  transaction: async (fn) => open().transaction(fn),
};

// Postgres returns BIGINT (and COUNT(*)) as strings. Every BIGINT here is a millisecond timestamp or a
// count, all far below 2^53, so turn them back into numbers: the rest of the app and the front ends
// expect numbers.
function fixRows(result) {
  const big = (result.fields || []).filter((f) => f.dataTypeID === 20).map((f) => f.name);
  if (big.length) {
    for (const row of result.rows) for (const name of big) if (row[name] != null) row[name] = Number(row[name]);
  }
  return result;
}

// ---------- ?/@name placeholders ----------
// Queries are written with `?` or `@name` placeholders. This converts either style into Postgres's
// `$1, $2, ...` style, reusing the same number when a named placeholder (e.g. `@q`) appears more than once.
function toPgQuery(text, params) {
  if (Array.isArray(params)) {
    let i = 0;
    return { text: text.replace(/\?/g, () => `$${++i}`), values: params };
  }
  const values = [];
  const seen = new Map();
  const converted = text.replace(/@(\w+)/g, (_, name) => {
    if (!seen.has(name)) { values.push(params[name]); seen.set(name, values.length); }
    return `$${seen.get(name)}`;
  });
  return { text: converted, values };
}

function makeDb(query) {
  return {
    async get(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows } = fixRows(await query(t, values));
      return rows[0];
    },
    async all(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows } = fixRows(await query(t, values));
      return rows;
    },
    // For INSERT statements that need the new row's id, the call site's SQL must end with `RETURNING id`.
    async run(text, params = []) {
      const { text: t, values } = toPgQuery(text, params);
      const { rows, rowCount } = fixRows(await query(t, values));
      return { lastInsertRowid: rows[0]?.id, rowCount };
    },
  };
}

const db = makeDb(driver.query);

// Runs `fn(tx)` inside a single Postgres transaction. Inside `fn`, use only `tx`, never `db`.
const withTransaction = (fn) => driver.transaction((query) => fn(makeDb(query)));

// ---------- schema ----------
// Millisecond epoch columns (created_at, start_at, deadline_at, ...) are BIGINT: Postgres's plain
// INTEGER is 32-bit and overflows on Date.now()-style values.
//
// Three kinds of people use the platform:
//  - the owner (whoever runs this deployment): a hidden panel to oversee organisers
//  - organisers (teachers, quiz masters): sign up with a verified email, then create and run quizzes
//  - students: open a quiz's link, enter its password and their details, take that one quiz
// Every quiz belongs to one organiser; students, approved lists and attempts belong to one quiz.
async function ensureSchema() {
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS owners (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organisers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      institution TEXT NOT NULL,
      designation TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at BIGINT NOT NULL,
      last_login_at BIGINT
    );

    -- One-time codes sent by email: confirming the address at sign-up, and resetting a forgotten password.
    CREATE TABLE IF NOT EXISTS email_codes (
      id SERIAL PRIMARY KEY,
      organiser_id INTEGER NOT NULL REFERENCES organisers(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
      code_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_codes_org ON email_codes(organiser_id, purpose);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('student','organiser','owner')),
      user_id INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      revoked TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(kind, user_id);

    -- slug: the quiz's public address (/q/<slug>). access_code: the password students need; kept readable
    -- because the organiser has to see it to share it. theme: JSON of the organiser's colours and images.
    -- show_results: what a student sees after submitting: none, score, or full (score now, answers once the quiz closes).
    -- extra_label: one extra question on the student details form (e.g. "Class"); empty = not asked.
    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      organiser_id INTEGER NOT NULL REFERENCES organisers(id) ON DELETE CASCADE,
      slug TEXT UNIQUE NOT NULL,
      access_code TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      start_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      duration_min INTEGER NOT NULL,
      questions_per_attempt INTEGER NOT NULL DEFAULT 0,
      max_violations INTEGER NOT NULL DEFAULT 3,
      published INTEGER NOT NULL DEFAULT 0,
      show_results TEXT NOT NULL DEFAULT 'none' CHECK (show_results IN ('none','score','full')),
      extra_label TEXT NOT NULL DEFAULT 'School / Institution',
      theme TEXT NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quizzes_org ON quizzes(organiser_id);

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      image TEXT,
      options TEXT NOT NULL,
      correct INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      difficulty TEXT NOT NULL DEFAULT 'Medium',
      marks DOUBLE PRECISION NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);

    -- A student exists within one quiz: the same mobile number in two quizzes is two separate students.
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      extra TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      created_at BIGINT NOT NULL,
      UNIQUE (quiz_id, phone)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      started_at BIGINT NOT NULL,
      deadline_at BIGINT NOT NULL,
      submitted_at BIGINT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
      submit_reason TEXT,
      question_order TEXT NOT NULL,
      score DOUBLE PRECISION,
      correct_count INTEGER,
      wrong_count INTEGER,
      unanswered_count INTEGER,
      flagged_count INTEGER,
      total_marks DOUBLE PRECISION,
      time_taken_ms BIGINT,
      violations INTEGER NOT NULL DEFAULT 0,
      last_seen BIGINT,
      UNIQUE (quiz_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, deadline_at);

    CREATE TABLE IF NOT EXISTS answers (
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL,
      chosen INTEGER,
      marked INTEGER NOT NULL DEFAULT 0,
      answered_at BIGINT NOT NULL,
      PRIMARY KEY (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS violations (
      id SERIAL PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      detail TEXT,
      at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_violations_attempt ON violations(attempt_id);

    -- Rate limiting is kept here rather than in memory: on Vercel every instance has its own memory,
    -- so an in-memory counter would let each instance be tried separately.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at BIGINT NOT NULL
    );

    -- Approved list, per quiz: when a quiz has at least one number here, only those numbers can enter it.
    CREATE TABLE IF NOT EXISTS approved (
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      extra TEXT NOT NULL DEFAULT '',
      added_at BIGINT NOT NULL,
      PRIMARY KEY (quiz_id, phone)
    );

    -- Uploaded images (questions, quiz logos and backgrounds), used only when no Vercel Blob store is connected.
    CREATE TABLE IF NOT EXISTS images (
      name TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      organiser_id INTEGER,
      created_at BIGINT NOT NULL
    );
  `);
}

async function getSetting(key, fallback = null) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
}

module.exports = { db, withTransaction, ensureSchema, getSetting, setSetting };
