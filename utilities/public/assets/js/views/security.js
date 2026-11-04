import { h, field, showError, busy, confirmDialog, announce, plainDate, fill } from '../dom.js';
import { api } from '../api.js';
import { createPasskey, passkeysSupported } from '../webauthn.js';

/** "My sign-in": add or remove passkeys. The emailed code always keeps working. */
export async function mySignIn() {
  const host = h('div'), msg = h('div', { role: 'status' });
  const load = async () => {
    const { passkeys } = await api('GET', '/api/me/passkeys');
    const name = field({ id: 'pkname', label: 'Name for this device', hint: 'For example "My phone". Only you see this.', value: '', autocomplete: 'off', maxlength: 60 });
    const add = h('button', { class: 'btn', type: 'button' }, 'Add a passkey to this device');
    add.addEventListener('click', async () => {
      try {
        const options = await api('POST', '/api/me/passkeys/options', {});
        const response = await createPasskey(options);
        await busy(add, 'Saving...', () => api('POST', '/api/me/passkeys/verify', { response, name: name.querySelector('input').value.trim() || 'This device' }));
        announce('Passkey added.'); await load();
      } catch (e) {
        showError(msg, e.name === 'NotAllowedError' ? 'That was cancelled. Nothing was changed.' : e.message || 'We could not add a passkey on this device.');
      }
    });
    fill(host,
      h('section', { class: 'card', 'aria-labelledby': 'pk-h' }, h('h2', { id: 'pk-h' }, 'Passkeys'),
        h('p', {}, 'A passkey lets you sign in with your fingerprint, face or phone PIN instead of waiting for an email. It stays on your device.'),
        passkeys.length ? h('ul', { class: 'list' }, passkeys.map((k) => h('li', {}, h('div', { class: 'row2' }, h('span', {}, h('strong', {}, k.name), h('br'), h('span', { class: 'muted' }, `Added ${plainDate(k.created_at)}${k.last_used ? ', last used ' + plainDate(k.last_used) : ''}`)),
          h('button', { class: 'btn secondary', type: 'button', 'aria-label': `Remove passkey ${k.name}`, onclick: async () => {
            const ok = await confirmDialog({ title: 'Remove this passkey?', body: 'You can still sign in with an emailed code.', yes: 'Yes, remove it', no: 'No, keep it' });
            if (!ok) return;
            try { await api('DELETE', `/api/me/passkeys/${k.id}`); announce('Passkey removed.'); await load(); } catch (e) { showError(msg, e.message); }
          } }, 'Remove'))))) : h('p', { class: 'muted' }, 'No passkeys yet.'),
        passkeysSupported() ? h('div', {}, name, h('div', { class: 'actions' }, add)) : h('p', { class: 'notice warn' }, 'This browser does not support passkeys. Emailed codes still work.')));
  };
  await load();
  return h('div', {}, h('a', { href: '#/' }, '← Back'), h('h1', {}, 'My sign-in'), msg, host, h('p', { class: 'hint' }, 'An emailed code always works too, so you can never be locked out.'));
}
