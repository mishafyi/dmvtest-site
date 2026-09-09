// dmvtest.fyi: static pages plus two Resend-backed routes — the support form and the inbound-mail
// forwarder that makes support@dmvtest.fyi land in a real inbox.
import express from 'express';
import { Resend } from 'resend';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const resend = new Resend(env('RESEND_API_KEY'));
const webhookSecret = env('RESEND_WEBHOOK_SECRET');
const inbox = env('CONTACT_TO');
const from = 'DMV Prep <support@dmvtest.fyi>';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.set('trust proxy', 1); // Traefik terminates TLS in front of us
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (req.hostname === 'www.dmvtest.fyi') return res.redirect(301, `https://dmvtest.fyi${req.originalUrl}`);
  return next();
});

// ponytail: in-memory per-IP limit, 5 messages an hour; one container, so no shared store needed.
const recent = new Map();
const withinLimit = (ip) => {
  const now = Date.now();
  const stamps = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.set(ip, [...stamps, now]);
  return stamps.length < 5;
};

app.post('/api/contact', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
  const { email, message, website } = req.body;
  if (website) return res.redirect(303, '/sent'); // honeypot filled in: a bot, pretend it worked
  const valid = typeof email === 'string' && emailPattern.test(email) && email.length <= 254
    && typeof message === 'string' && message.trim().length >= 10 && message.length <= 5000;
  if (!valid) return res.status(400).type('text').send('Please enter a valid email address and a message of at least 10 characters.');
  if (!withinLimit(req.ip)) return res.status(429).type('text').send('Too many messages from this address. Please try again in an hour.');
  const { error } = await resend.emails.send({
    from,
    to: inbox,
    replyTo: email,
    subject: `DMV Prep support form: ${email}`,
    text: `${message.trim()}\n\n—\nFrom: ${email}\nSent from https://dmvtest.fyi/support`,
  });
  if (error) {
    console.error(JSON.stringify({ route: 'contact', error }));
    return res.status(502).type('text').send('Sending failed. Please email support@dmvtest.fyi instead.');
  }
  return res.redirect(303, '/sent');
});

// Resend Inbound: every message to *@dmvtest.fyi arrives as an email.received event; forward it on.
app.post('/api/inbound', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = resend.webhooks.verify({
      payload: req.body,
      headers: { id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature') },
      webhookSecret,
    });
  } catch (err) {
    console.error(JSON.stringify({ route: 'inbound', error: String(err) }));
    return res.status(400).send('Invalid signature');
  }
  if (event.type !== 'email.received') return res.status(204).end();
  const emailId = event.data.email_id;
  const { error } = await resend.emails.receiving.forward({ emailId, to: inbox, from });
  if (error) {
    console.error(JSON.stringify({ route: 'inbound', emailId, error }));
    return res.status(502).send(error.message);
  }
  return res.status(204).end();
});

app.use(express.static('public', { extensions: ['html'] }));

app.listen(3000, () => console.log('dmvtest-site listening on 3000'));
