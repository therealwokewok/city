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
    appearance: {
      theme: 'stripe',
      labels: 'above',
      variables: {
        colorPrimary: cssVar('--accent', '#0b4f8a'), colorText: cssVar('--text', '#1a1a1a'), colorDanger: '#9b1c1c',
        colorBackground: '#ffffff', fontFamily: '"Libre Franklin", "Segoe UI", Arial, sans-serif', fontSizeBase: '18px',
        borderRadius: '6px', spacingUnit: '5px', focusBoxShadow: '0 0 0 3px #ffbf47',
      },
      rules: { '.Input': { border: '3px solid #8a857b', padding: '14px' }, '.Label': { fontWeight: '700' }, '.Tab': { border: '3px solid #d9d4c9' } },
    },
  });
  const pe = elements.create('payment', { layout: 'tabs' });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The secure payment form is taking too long. Please try again, or call City Hall.')), 20000);
    pe.on('ready', () => { clearTimeout(t); resolve(); });
    pe.on('loaderror', (e) => { clearTimeout(t); reject(new Error(e?.error?.message || 'The secure payment form could not load.')); });
    pe.mount(host);
  });
  return { stripe, elements, element: pe };
}
