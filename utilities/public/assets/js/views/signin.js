import { h, field, showError, busy, fill } from '../dom.js';
import { api, state } from '../api.js';
import { passkeysSupported, usePasskey } from '../webauthn.js';

/** Sign in with an emailed code. No passwords, for anyone. */
export function signIn(done) {
  const box = h('div');
  const askEmail = (prefill = '', note = '') => {
    const form = h('form', { novalidate: true, autocomplete: 'on' },
      note ? h('p', { class: 'notice' }, note) : null,
      field({ id: 'email', label: 'Your email address', hint: "We'll email you a code. There is no password to remember.", type: 'email', value: prefill, autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true }),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Email me a code')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.querySelector('#email').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showError(form, 'Please type your full email address, like name@example.com.'); form.querySelector('#email').focus(); return; }
      try {
        await busy(form.querySelector('button'), 'Sending...', () => api('POST', '/api/auth/request-code', { email }));
        askCode(email);
      } catch (err) { showError(form, err.message); }
    });
    const pkMsg = h('div');
    const pk = passkeysSupported() ? h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', id: 'use-passkey', onclick: async (e) => {
      try {
        const options = await busy(e.target, 'One moment...', () => api('POST', '/api/auth/passkey/options', {}));
        const response = await usePasskey(options);
        await api('POST', '/api/auth/passkey/verify', response);
        state.me = await api('GET', '/api/me');
        done();
      } catch (err) { showError(pkMsg, err.name === 'NotAllowedError' ? 'That was cancelled. You can use an emailed code instead.' : err.message); }
    } }, 'Sign in with a passkey')) : null;
    const ssoBox = h('div');
    api('GET', '/api/auth/sso/info').then((i) => { if (i.enabled) fill(ssoBox, h('div', { class: 'actions' }, h('a', { class: 'btn secondary', href: '/api/auth/sso/start' }, `Sign in with your ${i.name}`))); }).catch(() => {});
    const ssoFailed = new URLSearchParams(location.search).get('sso') === 'failed' ? h('p', { class: 'error', role: 'alert' }, 'That sign-in did not work. Your account may not be set up yet. You can still use an emailed code.') : null;
    fill(box, h('h1', {}, 'Sign in'), ssoFailed, h('p', {}, 'Pay your bill, see your usage, and get help, all in one place.'), form, pk ? h('p', { class: 'muted' }, 'Or, if you set one up before:') : null, pk, pkMsg, ssoBox);
    form.querySelector('#email').focus();
  };
  const askCode = (email) => {
    const form = h('form', { novalidate: true },
      h('p', {}, 'We sent a code to ', h('strong', {}, email), '. It can take a minute. Check your spam or junk folder if you do not see it.'),
      h('p', { class: 'hint' }, 'Asked for several codes? Use the newest email. If nothing comes, wait 10 minutes and try again.'),
      field({ id: 'code', label: 'Type the 8 numbers from the email', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 9, class: 'code', required: true }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'submit' }, 'Sign in'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => askEmail(email) }, 'Use a different email or get a new code')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = form.querySelector('#code').value.replace(/\D/g, '');
      if (code.length !== 8) { showError(form, 'The code has 8 numbers. Please check the email and try again.'); form.querySelector('#code').focus(); return; }
      try {
        const r = await busy(form.querySelector('button[type=submit]'), 'Checking...', () => api('POST', '/api/auth/verify', { email, code }));
        state.me = await api('GET', '/api/me');
        void r;
        done();
      } catch (err) { showError(form, err.message); form.querySelector('#code').select(); }
    });
    fill(box, h('h1', {}, 'Check your email'), form);
    form.querySelector('#code').focus();
  };
  askEmail();
  return box;
}
