# Quiz Venno

A platform where teachers, lecturers and quiz masters run secure online quizzes. Organisers sign up with their email, build a quiz, and share one link and password. Students take it on any phone or laptop browser, with nothing to install.

## Who uses it

| Who | Where | What they do |
|---|---|---|
| **Organiser** (teacher, quiz master) | `/organiser/` | Sign up and confirm their email with a 6-digit code. Create quizzes, add questions (by hand or from Excel), choose the colours and logo, publish, share the link and password, watch live, download results |
| **Student** | `/q/<code>` (the link from their organiser) | Enter the quiz password, their name, mobile and one optional extra detail. Wait for the opening time, take the quiz, submit, and see whatever the organiser chose to show |
| **Owner** (you, running the site) | a secret address printed at startup | See every organiser and quiz. Suspend, reactivate or delete organisers, or confirm an email by hand |

The home page `/` explains the platform, links to organiser sign-up, and has a "Taking a quiz?" box where students paste a link or code.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

The first start prints the **owner panel address** and the owner username and password. Keep them private. To choose the password yourself, set `OWNER_PASSWORD` before the very first start (PowerShell: `$env:OWNER_PASSWORD='choose-a-strong-password'; npm start`).

Without `RESEND_API_KEY`, emails are not sent. The verification and reset codes are printed in the server console instead, so you can still sign up and test locally.

## What an organiser can set per quiz

- **Schedule:** opening time, closing time, and minutes per student. A student who starts late only gets the time left until closing. Unfinished quizzes submit automatically at the deadline, even if the page was closed.
- **Questions:** 2–6 options, one correct answer, category, difficulty, marks and an optional image. Bulk upload from Excel/CSV (download the template, or start from `sample-questions.csv`).
- **Questions per student:** all of them, or a random set from a bigger pool. The order of questions and options is shuffled for each student.
- **Password:** generated automatically, or chosen by the organiser. It can be changed at any time; students already inside stay in.
- **Extra detail on the student form:** for example "Class & division" or "Roll number". Leave it empty to ask only for name and mobile.
- **Approved list (optional):** upload the mobile numbers allowed in. While it is empty, anyone with the link and password can enter.
- **What students see after submitting:** nothing, their score, or their score plus the correct answers. Answers are shown only after the quiz closes for everyone.
- **Anti-cheating:** after how many app or tab switches the quiz auto-submits (0 = never).
- **Design:** background, text and accent colours (or one of 8 presets), font, corner style, logo and a background picture, with a live preview. The editor warns when colours are hard to read.

**Share** gives a ready-to-send message with the link and password for WhatsApp or email. **Duplicate** copies a quiz and its questions as a new draft with its own link and password.

## Anti-cheating

| Measure | How it works |
|---|---|
| One attempt per mobile number per quiz | Entering the same number again resumes the same attempt |
| One device at a time | Signing in on another device logs out the first, and the organiser sees "Logged in on another device" |
| App/tab switch detection | Each switch shows a warning and is logged. After the limit, the quiz auto-submits |
| Full screen on laptops | Leaving full screen counts as a switch |
| Shuffled questions and options, random subsets | Every student gets a different paper |
| Answers checked on the server | Correct answers never reach the student's device while the quiz is running |
| Server-controlled timer | Changing the phone clock or reloading doesn't add time |
| Copy, paste and right-click blocked | Attempts are logged. Printing shows nothing |
| Name watermark | The student's name and number are tiled faintly over the quiz |

No website can stop a second phone or help from someone in the room. These measures deter cheating and record it for the organiser to review.

## Putting it online (Vercel)

1. Push to GitHub and import the repo in Vercel. `vercel.json` already sets the routing, so leave the build settings empty.
2. In the project's **Storage** tab, create a Postgres (Neon) database and connect it. That adds `POSTGRES_URL`. Use a new database, not the one from an older project.
3. In **Settings → Environment Variables**, add the variables below, then redeploy.

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | API key from [resend.com](https://resend.com), for verification and password-reset emails |
| `EMAIL_FROM` | Sender, e.g. `Quiz Venno <no-reply@yourdomain.com>`. The domain must be verified in Resend. Until then, Resend only delivers to your own Resend account's email |
| `OWNER_PATH` | Secret owner panel path, e.g. `/owner-a8f3k2x9` |
| `OWNER_USER`, `OWNER_PASSWORD` | The owner login. Only used when the database has no owner yet |
| `CRON_SECRET` | Any random string. Protects the daily clean-up endpoint |
| `SITE_NAME` | Optional. The name used in emails (default "Quiz Venno") |

Optional: connect a **Blob** store and uploaded images go there (`BLOB_READ_WRITE_TOKEN`). Without it they are kept in the database.

## Project layout

```
server.js            app setup, security headers, routing, first owner account
db.js                Postgres (Neon on Vercel, PGlite locally) and the schema
lib/common.js        passwords, codes, cookies, rate limits, grading, auto-submit sweep
lib/email.js         email through Resend (printed to the console when no key is set)
lib/theme.js         quiz theme defaults and validation
routes/organiser.js  organiser API: sign up, verify, log in, quizzes, questions, students, live, results
routes/student.js    student API for one quiz: enter, lobby, attempt, autosave, warnings, result
routes/owner.js      owner panel API
public/              home page, quiz page (quiz.html/js/css), shared styles (app.css), theme-apply.js
organiser/           organiser app
owner/               owner panel
```
