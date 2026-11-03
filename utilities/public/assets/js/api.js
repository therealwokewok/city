import { $, h, field, showError, busy, fill } from './dom.js';

export const state = { me: null, city: null };

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(state.me && method !== 'GET' ? { 'x-csrf-token': state.me.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("We can't reach the city's computer right now. Check your internet and try again.", 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'stepup_required') {
      const ok = await askStepUp();
      if (!ok) throw new ApiError('That action needs a quick safety check first.', 401);
      return api(method, url, body);
    }
    if (res.status === 401 && state.me) { state.me = null; location.hash = '#/signin'; throw new ApiError('You were signed out to keep your account safe. Please sign in again.', 401); }
    const friendly = { 403: "You don't have permission to do that.", 404: "We couldn't find that.", 429: 'Too many tries. Please wait a minute.' };
    throw new ApiError(data?.error || friendly[res.status] || 'Something went wrong. Please try again, or call City Hall.', res.status);
  }
  return data;
}

/** Extra email-code check before risky actions such as approving bills or changing rates. */
function askStepUp() {
  const dlg = $('#dlg');
  return new Promise(async (resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; if (dlg.open) dlg.close(); resolve(v); } };
    const form = h('form', { novalidate: true });
    const render = () => {
      fill(form, 
        h('h2', { id: 'dlg-title' }, 'A quick safety check'),
        h('p', {}, `For your safety we sent a code to ${state.me.email}. Type it below.`),
        field({ id: 'sc', label: 'Code from your email', hint: '8 numbers', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, class: 'code' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'submit' }, 'Confirm'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => finish(false) }, 'Cancel')));
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      try {
        await busy(btn, 'Checking...', () => api('POST', '/api/auth/stepup/verify', { code: form.querySelector('#sc').value.replace(/\D/g, '') }));
        finish(true);
      } catch (err) { showError(form, err.message); }
    });
    fill(dlg, form);
    render();
    dlg.addEventListener('close', () => finish(false), { once: true });
    dlg.showModal();
    try { await api('POST', '/api/auth/stepup/request', {}); } catch (err) { showError(form, err.message); }
    form.querySelector('#sc')?.focus();
  });
}

export const isStaff = () => !!state.me && state.me.roles.some((r) => r !== 'resident');
export const has = (...roles) => !!state.me && roles.some((r) => state.me.roles.includes(r));
