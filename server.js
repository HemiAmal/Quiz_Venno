const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ensureSchema, db, getSetting, setSetting } = require('./db');
const { hashPassword, sweepExpired } = require('./lib/common');
const { SITE } = require('./lib/email');
const studentRouter = require('./routes/student');
const organiserRouter = require('./routes/organiser');
const ownerRouter = require('./routes/owner');

const PORT = Number(process.env.PORT) || 3000;

// Builds the Express app once. On a traditional host (local dev, Render, Railway: anywhere the process
// stays alive) this runs once at boot. On Vercel it runs once per cold start and the result is reused
// for every request the warm instance handles afterward (see the export at the bottom of this file).
async function buildApp() {
  // Two instances starting at the same moment on an empty database can collide while creating the
  // tables; the second try then finds them already there.
  await ensureSchema().catch(() => ensureSchema());

  // ---------- first-run setup ----------
  // The owner panel lives at a secret path. Nothing links to it.
  let OWNER_PATH = process.env.OWNER_PATH || await getSetting('owner_path');
  if (!OWNER_PATH) {
    OWNER_PATH = `/owner-${crypto.randomBytes(6).toString('hex')}`;
    await setSetting('owner_path', OWNER_PATH);
  }
  if (!OWNER_PATH.startsWith('/')) OWNER_PATH = `/${OWNER_PATH}`;
  OWNER_PATH = OWNER_PATH.replace(/\/+$/, '');

  if (!await db.get('SELECT 1 FROM owners LIMIT 1')) {
    const username = process.env.OWNER_USER || 'owner';
    const password = process.env.OWNER_PASSWORD || crypto.randomBytes(9).toString('base64url');
    try {
      await db.run('INSERT INTO owners (username, pass_hash, created_at) VALUES (?, ?, ?)', [username, hashPassword(password), Date.now()]);
      console.log('\n  First run: owner account created');
      console.log(`    username: ${username}`);
      if (!process.env.OWNER_PASSWORD) console.log(`    password: ${password}   (change it in the owner panel after logging in)`);
    } catch (e) {
      // Two cold starts racing to create the first owner at the same moment: the first one wins.
      if (!/unique/i.test(String(e.message))) throw e;
    }
  }

  // ---------- app ----------
  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel's proxy the real visitor address is in X-Forwarded-For; rate limits need it.
  const trustProxy = process.env.TRUST_PROXY || (process.env.VERCEL ? 'true' : '');
  if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? 1 : trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  // Backstop for expired attempts whose student closed the page: a long-running process keeps a
  // setInterval, but Vercel functions can't run code between requests, so Vercel calls this on a schedule
  // (see vercel.json). Students are still caught immediately on their own next request.
  app.get('/api/cron/sweep', noStore, async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
      await sweepExpired();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Motion (motion.dev, the framework-free build of Framer Motion) for the animations on every page.
  app.get('/vendor/motion.js', (req, res) => res.set('Cache-Control', 'public, max-age=86400')
    .sendFile(path.join(__dirname, 'node_modules', 'motion', 'dist', 'motion.js')));

  app.get('/api/config', noStore, (req, res) => res.json({ siteName: SITE, serverNow: Date.now() }));

  // Owner panel (secret path)
  app.use(`${OWNER_PATH}/api`, noStore, express.json({ limit: '50kb' }), ownerRouter(OWNER_PATH));
  app.use(OWNER_PATH, express.static(path.join(__dirname, 'owner'), { index: 'index.html' }));

  // Organiser app. SheetJS (Excel import/export) is served from node_modules, for organisers only.
  app.get('/organiser/vendor/xlsx.full.min.js', (req, res) => res.sendFile(require.resolve('xlsx/dist/xlsx.full.min.js')));
  app.use('/api/org', noStore, express.json({ limit: '5mb' }), organiserRouter);
  app.use('/organiser', express.static(path.join(__dirname, 'organiser'), { index: 'index.html' }));

  // Student side: every quiz has its own address /q/<slug>, all served by the same page.
  app.use('/api', noStore, express.json({ limit: '50kb' }), studentRouter);
  app.get('/q/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quiz.html')));

  // Uploaded images: kept in the database (or in Vercel Blob when a store is connected, in which case
  // the quiz holds the Blob URL and this route is not used). See routes/organiser.js.
  app.get('/uploads/:name', async (req, res, next) => {
    try {
      const img = await db.get('SELECT mime, data FROM images WHERE name = ?', [req.params.name]);
      if (!img) return res.status(404).type('text').send('Not found');
      res.set('Cache-Control', 'public, max-age=604800, immutable').type(img.mime).send(Buffer.from(img.data, 'base64'));
    } catch (e) { next(e); }
  });
  // CSS and JS are cached for an hour (their links carry ?v= numbers); pages are always rechecked so a
  // new release reaches visitors at once.
  const revalidateHtml = (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); };
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h', setHeaders: revalidateHtml }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err.status === 404) return res.status(404).type('text').send('Not found');
    if (err.expose && err.message) return res.status(err.status || 502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  console.log(`  Owner panel (keep this secret): ${OWNER_PATH}/`);
  return app;
}

let appPromise;
// A failed start (say the database was briefly unreachable) is not remembered: the next request tries again.
const getApp = () => {
  if (!appPromise) appPromise = buildApp().catch((e) => { appPromise = null; throw e; });
  return appPromise;
};

if (require.main === module) {
  // Traditional long-running host: local dev, Render, Railway, a VPS. Also runs the auto-submit sweep
  // on its own 15s interval here, since the process stays alive between requests.
  getApp().then((app) => {
    setInterval(sweepExpired, 15_000).unref();
    sweepExpired();
    app.listen(PORT, () => {
      console.log(`\n  ${SITE} running on http://localhost:${PORT}`);
      console.log(`  Organisers: http://localhost:${PORT}/organiser/`);
    });
  }).catch((e) => { console.error('Failed to start:', e); process.exit(1); });
} else {
  // Required as a module: this is the Vercel serverless entry point (see api/index.js).
  module.exports = async (req, res) => {
    let app;
    try { app = await getApp(); } catch (e) {
      console.error('Failed to start:', e);
      // Setup problems (no database connected) say what to do; anything else stays in the logs only.
      const error = e.setup ? e.message : 'The server could not start. Please try again in a moment.';
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ error }));
    }
    return app(req, res);
  };
}
