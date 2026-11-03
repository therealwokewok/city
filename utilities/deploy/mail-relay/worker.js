// Mail relay for a hosted demo, as a Cloudflare Worker on the free plan.
// The free plan only sends to verified addresses, so every message goes to one inbox and the
// intended recipient is put in the subject. Only the demo server may call it (checked by IP).
// Needs an Email Service binding named MAIL. Optional variable ALLOWED_IPS (comma separated).
// Point the app at it with EMAIL_API_URL=https://<worker>.workers.dev, any EMAIL_API_TOKEN, and EMAIL_FROM.
const FROM = 'utilities-demo@osceolamo.com';   // an address on a domain with Email Routing turned on
const INBOX = 'coryscline@gmail.com';          // a verified Email Routing destination address

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('utilities mail relay');
    const ip = request.headers.get('cf-connecting-ip') || '';
    const allowed = (env.ALLOWED_IPS || '51.81.14.164').split(',').map((s) => s.trim());
    if (!allowed.includes(ip)) return new Response('forbidden', { status: 403 });
    let body;
    try { body = await request.json(); } catch { return new Response('bad request', { status: 400 }); }
    const to = String(body.to || '').slice(0, 200);
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
