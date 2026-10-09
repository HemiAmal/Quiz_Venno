# Development notes

How to run Quiz Venno locally and the decisions already made. See README.md for features and deployment.

## Run locally

Needs Node.js 18+ (tested on Node 24).

```powershell
npm install
$env:PORT=3100; npm start
```

- Home page: `http://localhost:3100`. Organisers: `/organiser/`. Owner panel: the secret address printed at startup (stored in the database, so it stays the same).
- **Emails:** without `RESEND_API_KEY`, verification and reset codes are printed in the server console. Use them to finish sign-up.
- **Database:** PGlite (Postgres inside Node) with files in `data/venno-pg`. Delete that folder to start fresh. On Vercel it is the connected Neon database. Same SQL for both. (`data/` may also hold old files from the earlier single-event version. The app doesn't use them.)
- **Vercel has no disk and no background timer:** images are stored in the database (or Vercel Blob), rate limits are counted in the database, and overdue attempts are submitted on the student's next request, on any organiser request and by a daily cron. Locally a 15-second timer also runs.
- No build step and no auto-reload. Restart the server after changing `server.js`, `db.js`, `lib/` or `routes/`. Front-end files only need a browser refresh (bump the `?v=` on their links when you change them, because static files are cached for an hour).

## Decisions already made

- **Organisers verify their email only** (6-digit code, valid 15 minutes, 5 tries). There is no manual review of proof documents. The owner can suspend anyone, and can confirm an email by hand if the code never arrives.
- **Everything is per organiser.** Every organiser route checks ownership through `router.param` (`quizId`, `questionId`, `studentId`, `attemptId`). Another organiser's ids return 404.
- **Students belong to one quiz.** The same mobile number in two quizzes is two separate students. The student cookie is scoped to `/api/q/<slug>/`.
- **Quiz address and password:** `slug` is 8 random lowercase characters (`/q/<slug>`). The password is 6 easy-to-read characters, case-insensitive, and the organiser can change it. Wrong passwords are rate-limited per visitor and quiz. The entry limit is generous (300 per 15 minutes per IP) because a whole class may share one school Wi-Fi address.
- **A link ending in `#pw=CODE`** fills in the password on the student page. The hash never reaches the server.
- **Results shown to students:** `none`, `score`, or `full` (score now, answers only after `end_at`).
- **Theme:** `lib/theme.js` validates it (hex colours, a font from a fixed list, image URLs only from `/uploads/` or `https://`). `public/theme-apply.js` turns it into CSS variables, and both the quiz page and the organiser's live preview use it, so they always match.
- **Platform look** (home, organiser, owner): `public/app.css`, one violet brand colour, follows the device's light/dark setting.

## Testing a change quickly

1. Sign up at `/organiser/#signup` and take the code from the server console.
2. Create a quiz that opens a minute ago, bulk-upload `sample-questions.csv`, and publish it.
3. Open the quiz link in a private window, enter the password and test details, and take the quiz.
4. Check Students, Live and Results in the organiser app.
