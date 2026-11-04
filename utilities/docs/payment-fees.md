# Online payment fees

Stripe keeps part of every online payment, for example 2.9% + 30 cents for a card and 0.8% (at most $5) for a bank account. A city can absorb that cost (the default) or pass it on to the customer as its own line on the payment.

Turn it on under **Administration > City settings > Fees for paying online**.

## What the customer sees

1. On the pay page: a short note, such as "Credit cards have a fee. Debit cards do not. You will see the exact amount before you pay."
2. They type their card or bank account and press **Review my payment**.
3. The app looks at what they typed (card or bank, credit or debit) and shows:

   | | |
   |---|---|
   | Bill payment | $100.00 |
   | Credit card fee | $3.00 |
   | **Total charged** | **$103.00** |

4. They press **Pay $103.00**. Only the bill amount goes toward their balance; the fee is kept on the payment record.

The fee is worked out on the server from the card itself. Nothing the browser sends about the fee is trusted.

## How the fee is worked out

The fee is grossed up so the city receives the whole bill amount after Stripe's cut: `total = (bill + fixed) / (1 - percent)`. A $100.00 card payment at 2.9% + 30 cents becomes $103.30. A cap (3% by default) keeps a card fee within card company limits, and bank fees stop at the largest fee you set.

## Rules to check before turning a card fee on

This is a summary, not legal advice. Confirm with Stripe and the city attorney.

- **Credit cards only ("surcharge"):** card company rules allow a surcharge on credit cards only, never debit or prepaid cards, at most 3% for Visa. Visa and the city's processor must be told at least 30 days before starting. Some states limit or ban surcharges; check Missouri's current law.
- **All cards ("service fee"):** Visa's Service Fee Program covers utilities (category 4900) and has its own rules. Use the "all cards" setting only after the city has enrolled.
- **Bank (ACH) payments** are not covered by card company rules.
- Autopay charges never add a fee. If the city wants a fee on autopay, the customer must be told when they sign up.

## Apple Pay and Google Pay

Both work inside the same Stripe payment boxes, with no new setup for Google Pay: it appears on its own on Android
phones and in Chrome. Apple Pay appears on iPhones, iPads and Safari once the city's web address has been checked
by Stripe. A city administrator does that with one button in City settings ("Turn on Apple Pay for this web
address"); the app serves the file Apple looks for at `/.well-known/apple-developer-merchantid-domain-association`
(Stripe publishes it; it holds no secret), registers the address with Stripe, and reports whether Apple Pay is on.
Do it once per address people use (for example both `utilities.city.gov` and `www.utilities.city.gov`).

The fee rules apply to the card inside the wallet: a debit card in Apple Pay pays no credit-card fee, and the review
step says so ("Paying with: Apple Pay, Visa debit card ending 4242").

Card safety (PCI): nothing changes. The phone hands the card to Stripe directly; the city's server never sees a card
number, with or without a wallet, so the city stays in the simplest category (SAQ A), the same as with the card
boxes alone.
