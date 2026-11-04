// Stripe's Payment Element: card and bank fields shown inside our page, in Stripe's own secure frames.
// The script is loaded only on the pages that take a payment, and only from js.stripe.com (Stripe requires that).
let loading;
function loadStripe() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error('Stripe did not load')));
    s.onerror = () => { loading = undefined; reject(new Error('The secure payment form could not load. Check your internet connection and try again.')); };
    document.head.append(s);
  });
  return loading;
}

const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Stripe draws its own boxes, so it is told the page's colors. In dark mode that means its "night" theme with our
// card color behind the fields, or the tabs (Card, Apple Pay, US bank account) turn white with pale, unreadable labels.
function appearance() {
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const card = cssVar('--card', dark ? '#1b2128' : '#ffffff');
  const text = cssVar('--text', dark ? '#f3f3f3' : '#1a1a1a');
  const line = dark ? cssVar('--line', '#8b95a1') : '#8a857b';
  const soft = dark ? cssVar('--soft-line', '#3a434d') : '#d9d4c9';
  return {
    theme: dark ? 'night' : 'stripe',
    labels: 'above',
    variables: {
      colorPrimary: cssVar('--accent', dark ? '#8cc4ff' : '#0b4f8a'), colorText: text, colorTextSecondary: cssVar('--muted', dark ? '#cfd3d8' : '#5a5a5a'),
      colorTextPlaceholder: dark ? '#9aa3ad' : '#767676', colorDanger: dark ? '#ffb0b0' : '#9b1c1c', colorBackground: card,
      fontFamily: '"Libre Franklin", "Segoe UI", Arial, sans-serif', fontSizeBase: '18px', borderRadius: '6px', spacingUnit: '5px', focusBoxShadow: '0 0 0 3px #ffbf47',
    },
    rules: {
      '.Input': { border: `3px solid ${line}`, padding: '14px', backgroundColor: card, color: text },
      '.Label': { fontWeight: '700', color: text },
      '.Tab': { border: `3px solid ${soft}`, backgroundColor: card, color: text },
      '.Tab:hover': { color: text },
      '.Tab--selected': { borderColor: cssVar('--accent', '#0b4f8a'), color: text },
      '.TabIcon': { fill: text }, '.TabIcon--selected': { fill: cssVar('--accent', '#0b4f8a') },
      '.TabLabel': { color: text }, '.TabLabel--selected': { color: cssVar('--accent', '#0b4f8a') },
      '.Block': { backgroundColor: card, borderColor: soft },
    },
  };
}

/** Shows the Payment Element in `host`. Returns { stripe, elements } for confirming. */
// With `amount` (and no clientSecret) the form only collects the details; the charge is made later by the server,
// after any fee is worked out. With `clientSecret` it works on a payment or setup that already exists.
export async function mountPaymentElement(host, { publishableKey, clientSecret, amount }) {
  const Stripe = await loadStripe();
  const stripe = Stripe(publishableKey);
  const font = (file, weight) => ({ family: 'Libre Franklin', weight: String(weight), src: `url(${location.origin}/assets/fonts/${file})` });
  const elements = stripe.elements({
    ...(clientSecret ? { clientSecret } : { mode: 'payment', amount, currency: 'usd', paymentMethodTypes: ['card', 'us_bank_account'] }),
    fonts: [font('libre-franklin-latin-400-normal.woff2', 400), font('libre-franklin-latin-600-normal.woff2', 600), font('libre-franklin-latin-700-normal.woff2', 700)],
    appearance: appearance(),
  });
  const pe = elements.create('payment', { layout: 'tabs' });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The secure payment form is taking too long. Please try again, or call the office.')), 20000);
    pe.on('ready', () => { clearTimeout(t); resolve(); });
    pe.on('loaderror', (e) => { clearTimeout(t); reject(new Error(e?.error?.message || 'The secure payment form could not load.')); });
    pe.mount(host);
  });
  return { stripe, elements, element: pe };
}
