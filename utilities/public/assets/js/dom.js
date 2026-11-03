// Tiny helpers. No innerHTML anywhere: text is always inserted as text, so page content cannot run code.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** Replace an element's contents; skips null and false instead of printing them. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);

export function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
export function plainDate(iso) { // 'YYYY-MM-DD' or a timestamp, shown the same everywhere, no time zone surprises
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function announce(msg) { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 50); }

/** A labeled text field: label above, hint, input, and a place for a message. */
export function field({ id, label, hint, type = 'text', value = '', ...rest }) {
  const hintId = hint ? id + '-hint' : null;
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null,
    h(rest.tag === 'textarea' ? 'textarea' : 'input', { id, name: id, type: rest.tag === 'textarea' ? null : type, value: rest.tag === 'textarea' ? null : value, 'aria-describedby': hintId, ...omit(rest, 'tag') }, rest.tag === 'textarea' ? value : null));
}
const omit = (o, k) => { const c = { ...o }; delete c[k]; return c; };

export function errorBox(msg) { return h('p', { class: 'error', role: 'alert' }, msg); }
export function showError(host, msg) {
  host.querySelector('.error')?.remove();
  const box = errorBox(msg);
  host.prepend(box);
  box.scrollIntoView({ block: 'nearest' });
}

/** Disable a button while work happens so a double tap cannot send twice. */
export async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

export function confirmDialog({ title, body, yes = 'Yes, continue', no = 'No, go back' }) {
  const dlg = $('#dlg');
  return new Promise((resolve) => {
    dlg.replaceChildren(
      h('h2', { id: 'dlg-title' }, title), h('p', {}, body),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); resolve(true); } }, yes),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { dlg.close(); resolve(false); } }, no)));
    dlg.addEventListener('close', () => resolve(false), { once: true });
    dlg.showModal();
  });
}
