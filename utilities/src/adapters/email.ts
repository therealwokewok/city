/** Email adapter. Implement send() for SMTP or any email API; the app only ever calls this. */
export interface EmailAdapter {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Prints to the console. For local development only; never use in production. */
export class ConsoleEmail implements EmailAdapter {
  async send(to: string, subject: string, text: string) {
    console.log(`\n--- email to ${to} ---\n${subject}\n${text}\n---`);
  }
}

/** Keeps messages in memory so tests can read the sign-in codes. */
export class MemoryEmail implements EmailAdapter {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) { this.sent.push({ to, subject, text }); }
  lastCode(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    const code = m?.text.match(/\b(\d{8})\b/)?.[1];
    if (!code) throw new Error('no code sent to ' + to);
    return code;
  }
}

/** Minimal HTTPS email API sender (for example Postmark, Mailgun or Resend style JSON endpoints). */
export class HttpEmail implements EmailAdapter {
  constructor(private url: string, private token: string, private from: string) {}
  async send(to: string, subject: string, text: string) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to, subject, text }),
    });
    if (!res.ok) throw new Error('email provider returned ' + res.status);
  }
}
