import { $, h, announce, fill } from './dom.js';
import { api, state, has, isStaff, office } from './api.js';
import { signIn } from './views/signin.js';
import * as resident from './views/resident.js';
import * as reader from './views/reader.js';
import * as staff from './views/staff.js';
import * as admin from './views/admin.js';
import * as security from './views/security.js';

// ---------- text size (remembered on this device) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
function setSize(s) {
  document.documentElement.dataset.size = s;
  for (const b of document.querySelectorAll('.textsize button')) b.setAttribute('aria-pressed', String(b.dataset.size === s));
  store.set('size', s);
}
setSize(store.get('size') || '100');
for (const b of document.querySelectorAll('.textsize button')) b.addEventListener('click', () => setSize(b.dataset.size));

// ---------- routes ----------
const routes = [
  [/^$|^\/$/, home],
  [/^\/signin$/, () => signIn(afterSignIn)],
  [/^\/link$/, resident.link],
  [/^\/account\/([\w-]+)$/, resident.account],
  [/^\/pay\/([\w-]+)$/, resident.pay],
  [/^\/bill\/([\w-]+)\/([\w-]+)$/, resident.bill],
  [/^\/requests$/, resident.requests],
  [/^\/requests\/sent$/, resident.requestSent],
  [/^\/requests\/new\/(\w+)$/, resident.requestNew],
  [/^\/read$/, reader.list],
  [/^\/read\/orders$/, reader.workOrders],
  [/^\/read\/([\w-]+)$/, reader.entry],
  [/^\/staff$/, staff.dashboard],
  [/^\/staff\/readings$/, staff.readings],
  [/^\/staff\/runs$/, staff.runs],
  [/^\/staff\/runs\/([\w-]+)$/, staff.run],
  [/^\/staff\/approvals$/, staff.approvals],
  [/^\/staff\/plans$/, staff.plans],
  [/^\/staff\/accounts$/, staff.accounts],
  [/^\/staff\/accounts\/([\w-]+)$/, staff.account],
  [/^\/staff\/disputes$/, staff.disputes],
  [/^\/staff\/requests$/, staff.requests],
  [/^\/staff\/shutoffs$/, staff.shutoffs],
  [/^\/me\/signin$/, security.mySignIn],
  [/^\/admin$/, admin.hub],
  [/^\/admin\/settings$/, admin.settings],
  [/^\/admin\/city$/, admin.city],
  [/^\/admin\/database$/, admin.database],
  [/^\/admin\/people$/, admin.people],
  [/^\/admin\/rates$/, admin.rates],
  [/^\/admin\/printing$/, admin.printing],
  [/^\/admin\/audit$/, admin.audit],
  [/^\/admin\/appearance$/, admin.appearance],
  [/^\/admin\/updates$/, admin.updates],
];

async function home() {
  if (!state.me) return signIn(afterSignIn);
  if (has('meter_reader') && !has('resident', 'billing_clerk', 'city_admin', 'approver', 'cashier', 'customer_service', 'auditor', 'site_admin')) { location.hash = '#/read'; return null; }
  if (isStaff() && !has('resident') || (isStaff() && store.get('mode') === 'staff')) { location.hash = '#/staff'; return null; }
  return resident.home();
}
function afterSignIn() { location.hash = '#/'; render(); }

function tabsFor() {
  const t = [];
  const path = currentPath();
  if (!state.me) return t;
  if (has('resident')) t.push(['#/', 'My bills'], ['#/requests', 'Service requests'], ['#/link', 'Add an account']);
  if (has('meter_reader')) t.push(['#/read', 'Meter reading']);
  if (has('billing_clerk', 'city_admin', 'approver', 'cashier', 'customer_service', 'auditor')) {
    t.push(['#/staff', 'Staff home']);
    if (has('billing_clerk')) t.push(['#/staff/readings', 'Review readings']);
    if (has('billing_clerk', 'city_admin', 'approver', 'auditor')) t.push(['#/staff/runs', 'Bill runs']);
    if (has('approver', 'billing_clerk', 'cashier', 'customer_service', 'city_admin', 'auditor')) t.push(['#/staff/approvals', 'Approvals']);
    if (has('approver')) t.push(['#/staff/plans', 'Payment plans']);
    t.push(['#/staff/accounts', 'Accounts']);
  } else if (has('site_admin')) t.push(['#/staff', 'Staff home']);
  if (has('city_admin', 'site_admin', 'auditor', 'billing_clerk')) t.push(['#/admin', 'Administration']);
  void path;
  return t;
}
const currentPath = () => location.hash.replace(/^#/, '');

let renderId = 0;
async function render() {
  const my = ++renderId; // a slower, older screen must never overwrite a newer one
  const main = $('#main');
  let path = currentPath();
  // Return trips from the payment page arrive as real addresses, not hash routes.
  if (/^\/pay\/(done|cancelled)$/.test(location.pathname) && !path) {
    const result = location.pathname.endsWith('done') ? 'done' : 'cancelled';
    const p = new URLSearchParams(location.search).get('p');
    history.replaceState(null, '', '/');
    return show(await resident.payResult(result, p), 'Payment');
  }
  if (!state.me && path !== '/signin') path = '/signin';
  let node = null;
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      main.classList.toggle('wide', path.startsWith('/staff') || path.startsWith('/admin'));
      try { node = await fn(...m.slice(1)); }
      catch (e) { node = h('div', {}, h('h1', {}, 'Something went wrong'), h('p', { class: 'error', role: 'alert' }, e.message), h('a', { class: 'btn secondary', href: '#/' }, 'Go to the start')); }
      break;
    }
  }
  if (my !== renderId) return;
  if (!node && node !== null) node = h('div', {}, h('h1', {}, 'Page not found'), h('a', { class: 'btn', href: '#/' }, 'Go to the start'));
  if (node) show(node);
  drawChrome();
}

let firstRender = true;
function show(node, title) {
  const main = $('#main');
  fill(main, node);
  const h1 = main.querySelector('h1');
  document.title = `${h1?.textContent || title || 'Home'} - ${state.city?.name || 'Utilities'}`;
  // After the first screen, move focus to the new page heading so keyboard and screen reader users know the page changed.
  if (h1 && !firstRender) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); announce(h1.textContent); }
  firstRender = false;
  window.scrollTo(0, 0);
  drawChrome();
}

function drawChrome() {
  drawFooter();
  $('#signout').hidden = !state.me;
  const tabs = $('#tabs');
  const items = tabsFor();
  tabs.hidden = items.length < 2;
  fill(tabs, ...items.map(([href, label]) => {
    const active = currentPath() === href.slice(1) || (href.length > 3 && currentPath().startsWith(href.slice(1)) && href !== '#/staff');
    return h('a', { href, 'aria-current': active ? 'page' : null }, label);
  }));
}

$('#signout').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout', {}); } catch { /* already out */ }
  state.me = null; location.hash = '#/signin'; render();
});

function drawFooter() {
  const c = state.city || {};
  const foot = $('#foot');
  fill(foot, 
    h('p', {}, h('strong', {}, 'Need help? '), c.phone ? [`Call ${office()} at `, h('a', { href: 'tel:' + c.phone.replace(/[^\d+]/g, '') }, c.phone), '. '] : `Please call ${office()}. `,
      c.office_hours ? `Hours: ${c.office_hours}.` : ''),
    c.return_address ? h('p', {}, c.return_address.split('\n').join(', ')) : null,
    state.me ? h('p', {}, h('a', { href: '#/me/signin' }, 'My sign-in options')) : null);
}

window.addEventListener('hashchange', render);

// ---------- start ----------
(async function start() {
  try { state.city = await api('GET', '/api/city'); } catch { state.city = { name: 'City utilities' }; }
  { const b = $('#brand'); b.textContent = ''; const n = document.createElement('span'); n.className = 'brand-name'; n.textContent = state.city.name; const u = document.createElement('span'); u.className = 'brand-sub'; u.textContent = state.city.brand_sub || 'Utilities'; b.append(n, u); }
  if (state.city.has_logo) { const img = document.createElement('img'); img.src = '/api/city/logo'; img.alt = ''; img.className = 'brand-logo'; $('#brand').prepend(img); }
  if (state.city.demo) { const d = $('#demo'); d.hidden = false; d.textContent = ''; const st = document.createElement('strong'); st.textContent = 'Demo site.'; d.append(st, ` This is not the official ${state.city.name} utility system. No real bills or payments.`); document.body.classList.add('is-demo'); }
  drawFooter();
  try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('offline', () => { const b = $('#banner'); b.hidden = false; b.textContent = 'You are offline. Anything you save stays on this phone until you have signal again.'; });
  window.addEventListener('online', () => { $('#banner').hidden = true; });
  if (!navigator.onLine) window.dispatchEvent(new Event('offline'));
  render();
})();
