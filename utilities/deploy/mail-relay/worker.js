// Mail relay for a hosted demo, as a Cloudflare Worker on the free plan.
// The free plan only sends to verified addresses, so every message goes to one inbox and the
// intended recipient is put in the subject. Only the demo server may call it: the caller's IP must be
// listed AND, when the Worker has a MAIL_TOKEN secret, the request must carry it as a bearer token.
// Needs an Email Service binding named MAIL. Variables: ALLOWED_IPS (comma separated), MAIL_TOKEN (secret).
// Point the app at it with EMAIL_API_URL=https://<worker>.workers.dev, EMAIL_API_TOKEN=<the same token>, and EMAIL_FROM.
const FROM = 'utilities-demo@osceolamo.com';   // an address on a domain with Email Routing turned on
const INBOX = 'coryscline@gmail.com';          // a verified Email Routing destination address
const PER_MINUTE = 60;                         // more than this in a minute is a runaway, not a demo

const recent = []; // send times in this isolate; a best-effort brake, not an accounting system
const enc = new TextEncoder();
async function sameToken(a, b) {
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('utilities mail relay');
    const ip = request.headers.get('cf-connecting-ip') || '';
    const allowed = (env.ALLOWED_IPS || '51.81.14.164').split(',').map((s) => s.trim());
    if (!allowed.includes(ip)) return new Response('forbidden', { status: 403 });
    if (env.MAIL_TOKEN) {
      const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!(await sameToken(given, env.MAIL_TOKEN))) return new Response('forbidden', { status: 403 });
    }
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length >= PER_MINUTE) return new Response('too many', { status: 429 });
    recent.push(now);
    let body;
    try { body = await request.json(); } catch { return new Response('bad request', { status: 400 }); }
    const to = String(body.to || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const subject = String(body.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const text = String(body.text || '').slice(0, 20000);
    try {
      await env.MAIL.send({ from: FROM, to: INBOX, subject: '[' + to + '] ' + subject, text: 'Sent by the utilities demo to ' + to + '\n\n' + text });
    } catch (e) {
      console.error('send failed', String(e));
      return new Response('send failed', { status: 502 });
    }
    return Response.json({ ok: true });
  },
};
