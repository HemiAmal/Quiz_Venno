// Sends email through Resend (https://resend.com). Set RESEND_API_KEY, and EMAIL_FROM to an address on a
// domain you verified in Resend, e.g. "Quiz Venno <no-reply@yourdomain.com>". Until a domain is verified,
// Resend's test sender "onboarding@resend.dev" only delivers to the email address of your Resend account.
//
// Without RESEND_API_KEY (local development) nothing is sent: the message is printed in the server
// console instead, so sign-up and password reset can still be tried out.
const SITE = process.env.SITE_NAME || 'Quiz Venno';

async function sendEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n  [email not sent: RESEND_API_KEY is not set]\n  To: ${to}\n  Subject: ${subject}\n  ${text.replace(/\n/g, '\n  ')}\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || `${SITE} <onboarding@resend.dev>`, to: [to], subject, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Resend error ${res.status}: ${detail}`);
    const e = new Error('We could not send the email right now. Please try again in a few minutes.');
    e.expose = true;
    throw e;
  }
}

function sendCode(to, name, code, purpose) {
  const first = String(name || '').split(' ')[0] || 'there';
  if (purpose === 'reset') {
    return sendEmail({
      to,
      subject: `${code} is your ${SITE} password reset code`,
      text: `Hi ${first},\n\nYour code to reset your ${SITE} password is:\n\n    ${code}\n\nIt expires in 15 minutes. If you didn't ask for this, you can ignore this email; your password has not changed.\n\n${SITE}`,
    });
  }
  return sendEmail({
    to,
    subject: `${code} is your ${SITE} verification code`,
    text: `Hi ${first},\n\nWelcome to ${SITE}. Enter this code to confirm your email address:\n\n    ${code}\n\nIt expires in 15 minutes. If you didn't create an account, you can ignore this email.\n\n${SITE}`,
  });
}

module.exports = { sendEmail, sendCode, SITE };
