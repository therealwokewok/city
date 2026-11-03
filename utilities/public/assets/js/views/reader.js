import { h, field, showError, busy, confirmDialog, announce, plainDate, fill } from '../dom.js';
import { api, ApiError } from '../api.js';

// Readings are saved on the phone first, then sent. A dead zone never loses work.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r-' + Date.now() + '-' + Math.random().toString(16).slice(2));

export async function loadMeters() {
  try {
    const { meters } = await api('GET', '/api/field/meters');
    store.set('meters', { at: Date.now(), meters });
    return { meters, cached: false };
  } catch (e) {
    const c = store.get('meters', null);
    if (c && e.status === 0) return { meters: c.meters, cached: true, at: c.at };
    throw e;
  }
}

export async function syncQueue() {
  const queue = store.get('queue', []);
  if (!queue.length || !navigator.onLine) return { sent: 0, left: queue.length };
  let results;
  try { ({ results } = await api('POST', '/api/field/readings/batch', { readings: queue.slice(0, 200).map(({ label, ...r }) => r) })); }
  catch (e) { if (e.status === 0) return { sent: 0, left: queue.length, offline: true }; throw e; }
  const sent = store.get('sent', {});
  const keep = [];
  let ok = 0;
  queue.slice(0, 200).forEach((q, i) => {
    const r = results[i];
    if (r && r.ok) { ok++; sent[q.meter_id] = { value: q.value, at: q.read_at }; }
    else keep.push({ ...q, error: r?.error || 'not sent' });
  });
  store.set('queue', [...keep, ...queue.slice(200)]);
  store.set('sent', sent);
  return { sent: ok, left: keep.length + Math.max(0, queue.length - 200) };
}

export async function list() {
  let data;
  try { data = await loadMeters(); } catch (e) { return h('div', {}, h('h1', {}, 'Meter readings'), h('p', { class: 'error', role: 'alert' }, e.message)); }
  const statusHost = h('div', { role: 'status' });
  const refreshStatus = (msg) => {
    const q = store.get('queue', []);
    const bad = q.filter((x) => x.error);
    fill(statusHost, 
      msg ? h('p', { class: 'notice' }, msg) : null,
      q.length ? h('p', { class: 'notice warn' }, `${q.length} reading${q.length === 1 ? ' is' : 's are'} saved on this phone and not sent yet.${bad.length ? ` ${bad.length} need a look.` : ''}`) : null,
      data.cached ? h('p', { class: 'notice warn' }, `Showing the list saved on this phone. No signal right now.`) : null);
  };
  const sendBtn = h('button', { class: 'btn secondary', type: 'button' }, 'Send saved readings now');
  sendBtn.addEventListener('click', async () => {
    const r = await busy(sendBtn, 'Sending...', syncQueue).catch((e) => ({ err: e.message }));
    refreshStatus(r.err ? null : r.offline ? 'Still no signal. Your readings are safe on this phone.' : `Sent ${r.sent} reading${r.sent === 1 ? '' : 's'}.`);
    if (r.err) showError(statusHost, r.err);
    renderRows();
  });
  const search = h('input', { type: 'search', id: 'find', autocomplete: 'off', 'aria-controls': 'meter-list' });
  const rows = h('ul', { class: 'list', id: 'meter-list' });
  const renderRows = () => {
    const q = store.get('queue', []), sent = store.get('sent', {});
    const term = search.value.trim().toLowerCase();
    const shown = data.meters.filter((m) => !term || `${m.location} ${m.serial} ${m.service_code}`.toLowerCase().includes(term));
    fill(rows, ...(shown.length ? shown.map((m) => {
      const queued = q.find((x) => x.meter_id === m.id);
      const done = sent[m.id];
      return h('li', {}, h('a', { class: 'row2', href: `#/read/${m.id}` },
        h('span', {}, h('strong', {}, m.location || 'No address on file'), h('br'), h('span', { class: 'muted' }, `${m.service_name || m.service_code} meter ${m.serial}`)),
        queued ? h('span', { class: `status ${queued.error ? 'bad' : 'warn'}` }, queued.error ? '! Needs a look' : 'Saved') : done ? h('span', { class: 'status ok' }, '✓ Sent') : h('span', { class: 'muted' }, `Last: ${m.last_value ?? 'none'}`)));
    }) : [h('li', { class: 'muted' }, 'No meters match.')]));
  };
  search.addEventListener('input', renderRows);
  refreshStatus(); renderRows();
  syncQueue().then((r) => { if (r.sent) { refreshStatus(`Sent ${r.sent} saved reading${r.sent === 1 ? '' : 's'}.`); renderRows(); } }).catch(() => {});
  return h('div', {},
    h('h1', {}, 'Meter readings'), h('p', {}, h('a', { href: '#/read/orders' }, 'Shutoff and reconnect orders')), statusHost,
    h('div', { class: 'field' }, h('label', { for: 'find' }, 'Find a meter'), h('p', { class: 'hint' }, 'Type part of an address or meter number'), search),
    rows, h('div', { class: 'actions' }, sendBtn));
}

export async function entry(meterId) {
  const { meters } = await loadMeters().catch(() => ({ meters: store.get('meters', { meters: [] }).meters }));
  const m = meters.find((x) => x.id === meterId);
  if (!m) return h('div', {}, h('h1', {}, 'Meter not found'), h('a', { class: 'btn', href: '#/read' }, 'Back to the list'));
  const form = h('form', { novalidate: true },
    h('p', { class: 'muted' }, `${m.service_name || m.service_code} meter ${m.serial}`),
    h('p', {}, 'Last reading: ', h('strong', {}, m.last_value ?? 'none yet')),
    field({ id: 'val', label: 'What does the meter say now?', hint: 'Numbers only', inputmode: 'decimal', autocomplete: 'off', required: true, class: 'code' }),
    field({ id: 'note', label: 'Note (only if needed)', hint: 'For example: dog in yard, meter buried', tag: 'textarea', maxlength: 500 }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save this reading'), h('a', { class: 'btn secondary', href: '#/read' }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = form.querySelector('#val').value.trim().replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(raw)) { showError(form, 'Please type just the numbers on the meter.'); form.querySelector('#val').focus(); return; }
    const value = parseFloat(raw);
    if (m.last_value != null && value < m.last_value) {
      const ok = await confirmDialog({ title: 'Lower than last time', body: `The last reading was ${m.last_value} and you typed ${value}. Is that right?`, yes: 'Yes, that is what it says', no: 'No, let me fix it' });
      if (!ok) { form.querySelector('#val').focus(); return; }
    } else if (m.last_value != null && value - m.last_value > Math.max(m.last_value * 0.5, 5000)) {
      const ok = await confirmDialog({ title: 'That is a big jump', body: `The last reading was ${m.last_value} and you typed ${value}. Is that right?`, yes: 'Yes, that is what it says', no: 'No, let me fix it' });
      if (!ok) { form.querySelector('#val').focus(); return; }
    }
    const queue = store.get('queue', []).filter((x) => x.meter_id !== m.id);
    queue.push({ client_id: uid(), meter_id: m.id, value, read_at: new Date().toISOString(), note: form.querySelector('#note').value.trim() || undefined });
    if (!store.set('queue', queue)) { showError(form, 'This phone has no room left to save. Please send the saved readings first.'); return; }
    let msg = 'Saved on this phone.';
    try { const r = await syncQueue(); if (r.sent) msg = 'Saved and sent.'; } catch (err) { if (!(err instanceof ApiError)) throw err; }
    announce(msg);
    location.hash = '#/read';
  });
  return h('div', {}, h('a', { href: '#/read' }, '← Back to the list'), h('h1', {}, m.location || 'Meter'), form);
}
void plainDate;


// ---------- shutoff and reconnect orders (address only, no names or balances) ----------
export async function workOrders() {
  const host = h('div'), msg = h('div', { role: 'status' });
  const load = async () => {
    const { orders } = await api('GET', '/api/field/work-orders');
    fill(host, orders.length ? h('ul', { class: 'list' }, orders.map((o) => {
      const note = h('input', { type: 'text', id: `n-${o.id}`, autocomplete: 'off' });
      return h('li', { class: 'card' }, h('h2', {}, `${o.kind === 'shutoff' ? 'Shut off' : 'Turn back on'}: ${o.address}`), o.note ? h('p', {}, o.note) : null,
        h('div', { class: 'field' }, h('label', { for: `n-${o.id}` }, 'Anything to tell the office? (optional)'), note),
        h('button', { class: 'btn', type: 'button', 'aria-label': `Mark done: ${o.address}`, onclick: async () => {
          const ok = await confirmDialog({ title: 'Is this done?', body: `${o.kind === 'shutoff' ? 'Service is shut off' : 'Service is back on'} at ${o.address}.`, yes: 'Yes, it is done', no: 'Not yet' });
          if (!ok) return;
          try { await api('POST', `/api/field/work-orders/${o.id}/done`, { note: note.value.trim() }); announce('Marked done.'); await load(); } catch (e) { showError(msg, e.message); }
        } }, 'Mark done'));
    })) : h('p', { class: 'notice' }, '✓ No shutoff or reconnect orders right now.'));
  };
  await load();
  return h('div', {}, h('a', { href: '#/read' }, '← Meter readings'), h('h1', {}, 'Shutoffs and reconnects'), msg, host);
}
