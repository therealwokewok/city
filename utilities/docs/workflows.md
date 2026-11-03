# Who does what: every role and its workflows

This is the reference for how the utility system is meant to be used, role by role. Use it to train staff, to check a
new version before trusting it (the checklist at the end), and to settle "should I be able to do this?" questions.
The rule throughout: money moves only when two different people agree, every change is written to a log that cannot
be edited, and nobody sees more than their job needs.

Everyone signs in the same way: type your email, get an 8-digit code by email, type it in. There are no passwords.
A code works for 10 minutes and 5 tries; an email can ask for 3 codes in 10 minutes. Staff can add a passkey
(fingerprint, face or PIN on their own device) under "My sign-in options" at the bottom of every page; the emailed
code always keeps working. A session lasts 12 hours. "Risky" actions ask for a fresh emailed code (a "safety check"),
which then lasts for the number of minutes set by the city (1 to 30, usually 10).

One person can hold several roles. Someone who is both staff and a resident sees both sets of pages, but on the
resident pages they can only act on accounts linked to them, like any other resident.

---

## Resident (a customer)

**Sees:** My bills, Service requests, Add an account.

### Connect an account
1. Sign in with any email address. A new address is simply a new resident with nothing linked yet.
2. Add an account: type the account number and the link code printed on the paper bill (or given by City Hall).
3. Five wrong codes lock that person out of linking for an hour. City Hall can print a new code on the next bill.

### See bills and history
- My bills lists every linked account with what is owed, and "See my bills and history" shows each bill as
  Paid, Partly paid (with what is left), or Not paid yet, plus every payment, charge, adjustment and late charge.
- Open a bill to see each line (service, usage, amount) and press "Something looks wrong" to send a question to City
  Hall. The question appears in the staff queue; the resident sees the answer on the same page later.

### Pay
1. Press Pay. Choose "Pay everything I owe", the payment-plan amount (if on a plan), or "Pay a different amount"
   (at least $1.00, at most $10,000.00). Part payments are fine; what is left stays on the account.
2. Type a card or a US bank account into Stripe's boxes on the page. The city never sees or stores these details.
3. Press "Review my payment". The page shows exactly what will be charged: the bill payment, any fee the city passes
   on (credit card, all cards, or bank, depending on city settings; debit cards never pay a credit-card fee), and
   the total. Switching to a different card or bank updates the fee.
4. Press Pay. A declined card shows a plain message and the resident can try another card on the same page. A bank
   payment shows "started" and posts to the account when the bank confirms it, usually a few business days later.
5. Only the bill amount is credited to the account. The fee is recorded on the payment, not on the balance.

### Autopay
- Set up autopay by saving a card or bank account in Stripe's boxes on the account page. The city keeps only a label
  such as "Visa card ending 4242". Turn it off any time.
- When a bill is due, the city collects it (a staff member presses a button, or a scheduled job runs). Each bill is
  collected at most once. If the charge fails, the resident is emailed and pays by hand; the city never retries.

### Ask for a payment plan
1. On the account page, press "Ask for a payment plan", choose 2 to 12 monthly payments, and say why.
2. City Hall decides and emails the answer. While it is waiting, the resident can take the request back.
3. An approved plan shows its schedule and the next payment. Any payment counts toward the plan. While the resident
   keeps up, the bills in the plan get no late charge and the plan amount does not count toward a shutoff.
   Falling behind turns both back on. A resident cannot cancel an approved plan; they call the city.

### Service requests
- New service, stop service, move out (with a forwarding address for the final bill), move to a new address, or
  report a leak. Each shows its status and any note from City Hall. A request never changes a bill by itself.

### Paper bills
- "Stop mailing me a paper bill": the bill is emailed instead. Turn paper back on any time.

### A resident must NOT be able to
- See, pay, or set up autopay or a plan on an account that is not linked to them (the app answers "not found").
- Change anything on the account other than the paper-bill switch.
- Reach any staff page or staff data.
- Cancel an approved plan, re-open a declined one, or change its terms.

---

## Meter reader (field crew)

**Sees:** Meter reading. Nothing else.

### Take readings
1. Open Meter reading. The list shows each meter's service, serial number, location and last reading. No names,
   balances or account numbers, ever.
2. Type the new reading. A reading lower than the last one asks twice before saving (it may be a rollover).
3. Readings save on the phone when there is no signal and send themselves when it comes back. Sending twice never
   makes a duplicate.
4. A reading much higher than usual is flagged for review; the reader does not need to do anything.

### Shutoff and reconnect orders
1. Open Meter reading, then Orders. Each shows the address, what to do (shut off or reconnect) and the clerk's note.
2. Do the work, add a note ("Meter locked off 4:15 PM, tag on door"), press Done. The order leaves the list.

### A meter reader must NOT be able to
- See any customer name, balance, bill, account number or payment.
- Review or accept a reading, including their own.
- Reach any staff, admin or resident page.

---

## Billing clerk

**Sees:** Staff home, Review readings, Bill runs, Approvals, Accounts, Administration (rates and printing only).

### Review readings
1. Review readings lists readings waiting, flagged ones first, with the service, meter, account and address.
2. Accept, or Reject with a note. A reading lower than the last one must be accepted with the real usage typed in
   (rollover or meter swap). The clerk who took a reading cannot review it.

### Monthly billing (the bill run)
1. Bill runs: type the first and last day billed, and the due date (defaults to the city's "days until due").
2. Calculate bills. The run prices every active account from accepted readings and the rates in force on the last
   day of the period, adds flat charges and one-time charges, and shows the count, total and any warnings
   ("no accepted meter reading", "no rate set"). Recalculate as often as needed; nothing is posted yet.
3. "See the lines" shows every bill. Fix readings or rates and recalculate until it is right.
4. A different person with the Approver role approves the run. The clerk who started it cannot.
5. After approval: Print bills, Print envelopes (choose a layout; include or skip paperless customers), and
   "Email bills to paperless customers". Emailing twice sends nothing the second time.

### Late charges and shutoffs
1. On or after a due date, add late charges (the city's percentage, rounded up, once per bill, never for a date
   that has not come yet). Bills in a payment plan the customer is keeping up with are skipped.
2. Shutoffs lists accounts past due and past the notice period, minus any amount still owed on a plan they are
   keeping up with. Order a shutoff; it goes to the field crew. Ordering twice is refused.
3. When the customer pays up, order a reconnect. It is refused while anything is still owed.

### Accounts
- Find a customer by name, address or number. Add an account (the link code is shown once; print it on the first
  bill). Add, stop or restart services and quantities (two security lights). Add meters. Make a new link code
  (safety check).
- Take nothing at the counter: that is the cashier's job.
- Ask for an adjustment (a different person approves), add a one-time charge (a large one, or small credits that add
  up to a large one, go for approval), ask for
  a refund of a credit (a different person approves; the city pays by check or its own bank).
- Set up a payment plan for a customer who calls (an approver decides; it cannot be the clerk).
- Fix a wrong meter reading: pick the reading, type the right number, "Show what changes" (usage change and the
  credit or charge, worked out with the rate that applied), "Send the fix". An approver approves; only then is the
  reading changed and the money posted. A reading not billed yet, or billed only in a run that is not approved yet,
  is fixed at once with no money involved (recalculate the run afterwards).
- End a payment plan that is not being kept up.

### Questions and requests
- Bill questions from residents: answer each with a note the resident sees (resolved or rejected).
- Service requests: schedule, mark done, or decline with a reason the resident sees.

### Collect autopay
- Bill runs: "Collect autopay for bills that are due" (safety check). Charges each enrolled, due bill once.
  Failed charges email the customer. A scheduled job can do the same thing daily.

### A billing clerk must NOT be able to
- Approve anything: a bill run, an adjustment, a refund, a reading fix or a payment plan.
- Review a reading they submitted.
- Record a counter payment, change people or roles, change city settings, or read the activity log.
- Add late charges for a future date, or attach meters, services or roles to another city's records.

---

## Cashier

**Sees:** Staff home, Approvals (read only), Accounts.

### Take a payment at the counter
1. Find the account. The page shows the balance and each bill's paid status.
2. Take a payment: amount, cash or check, check number. It posts to the account at once.
3. Ask for an adjustment if something is wrong (a different person approves).

### A cashier must NOT be able to
- Approve or decline anything, add charges, start bill runs, change settings, see the activity log or people.
- See draft bills from a run that is not approved yet.

---

## Customer service

**Sees:** Staff home, Approvals (read only), Accounts.

Everything a cashier can see, plus the account changes a clerk can make (services, meters, link codes, adjustments,
charges, refunds, payment plans), answering bill questions and working the service-request queue. Customer service
cannot take counter payments, review readings, run billing, add late charges, order shutoffs or fix readings.

---

## Approver

**Sees:** Staff home, Bill runs (read), Approvals, Payment plans, Accounts (read).

Every approval asks for a fresh emailed code first.

### Approve a bill run
- Open the run, check the count and total, "Approve N bills". The bills become real money on every account.
  The person who started the run cannot approve it.

### Decide adjustments, charges, refunds and reading fixes
- Approvals lists each request with the account, amount and reason. Approve or Decline.
- Above the city's approval limit, a second, different approver must also approve.
- Nobody can decide a request they made. A refund is refused if the customer no longer has that much credit.
- Approving a reading fix also changes the reading and the next reading's usage.

### Decide payment plans
- Payment plans lists requests with the balance, the reason and the proposed schedule. Change the number of
  payments or the first date if needed (the first payment must be within 3 months), then Approve, or Decline with a
  note the customer sees. The customer is emailed either way.

### Reverse a mistaken ledger entry
- On an account's history, an approver can reverse an entry (a payment typed on the wrong account, for example).
  The reversal is a new entry; nothing is ever deleted. An entry can be reversed only once.

### An approver must NOT be able to
- Start a bill run, take payments, add charges, change settings, people or rates, or read the activity log.
- Give the second approval to something they gave the first approval to.

---

## City administrator

**Sees:** Staff home, Bill runs (read), Approvals (read), Accounts, Administration.

### People and roles
- Add a staff member by email and name; give or take away roles (safety check). Nobody can change their own
  roles. Every role change is emailed to the other administrators. Turn off someone who left; their sessions end.
- A city administrator may give any staff role except site administrator, including city administrator, so the
  city is never down to one. The only city administrator cannot be removed or turned off; add another first.

### City settings
- Phone, office hours, return address, where to mail payments, days until due, late charge percent, shutoff notice
  days, approval limit, sales tax, high-use flag, safety-check minutes (1 to 30), and the online payment fees.
  Saving asks for a safety check. Only a city administrator can change the money settings.

### Services and rates
- Turn services on or off for the city. Add a rate for a service starting on a date (rates are never edited; add a
  later one). Metered rates have a base charge, included units, tiers, an optional named adjustment line, the unit
  ("gallons", "kWh"), and can be billed per meter or on another service's usage (sewer on water).

### Printing
- Add bill and envelope layouts for the paper and envelopes the city actually owns. A new layout starts filled in.
  Print a test page and hold it up to the paper. Layouts can place text, boxes and lines; the list of charges prints
  as a table. An empty layout cannot be saved.

### Colors, logo, demo mode and updates
- Match the city's website colors (the app refuses colors too light for white text), upload a logo, and switch the
  demo notice. See whether a newer version is available.

### A city administrator must NOT be able to
- Approve or decline anything, take payments, start bill runs, review readings or fix readings.
- Change their own roles, give the site-administrator role, or remove the last city administrator.

---

## Site administrator (the person who runs the server)

**Sees:** Staff home, Administration (people, settings except money, appearance, updates).

- Names the first city administrator when a city is set up. After that, only a city administrator adds, removes or
  turns off a city administrator; the site administrator cannot.
- Can change non-money settings, colors, logo, demo mode and the update source.
- Must NOT be able to see any customer account, balance, bill, payment, approval, plan or work order, or change any
  money setting. Role changes they make are emailed to the city administrators.

---

## Auditor

**Sees:** Staff home, Bill runs (read), Approvals (read), Accounts (read), Administration (people and activity log).

- Reads everything about money and people; changes nothing. The activity log lists who did what and when, and
  "Check the record" confirms the log has not been edited (each entry is chained to the one before it).
- Must NOT be able to write anything: every save, approve, pay, charge or setting returns "not allowed".

---

## The money rules, in one place

- Every bill, payment, charge, adjustment, late charge, refund and reversal is a ledger entry. Entries are never
  edited or deleted; a mistake is fixed by a reversal entry.
- Bills become money only when a second person approves the run. Adjustments and refunds need a different person
  to approve, and above the limit a third. Payment plans and reading fixes go through the same approvals.
- Late charges apply once per bill, only after the due date, never to a bill in a plan being kept up.
- Online payments credit only the bill amount; a pass-through fee stays on the payment record. The processor's
  own records are the source of truth; the app asks it before marking anything paid, and events that change nothing
  are not remembered so they can be sent again.
- Card and bank numbers never reach the server. Autopay keeps only an opaque reference and a label.

---

## Manual test checklist (run after any update, on the demo first)

Use the test users `role_1@…` and `role_2@…`. Expected result in brackets.

**Sign-in**
- [ ] Wrong code [plain message]; sixth wrong code [locked for 10 minutes]; code reused [refused].
- [ ] Sign out, press Back [sign-in page, not the old screen].

**Resident**
- [ ] Link with a wrong code x5 [locked for an hour]; link with the right code [account appears].
- [ ] Pay part of a bill by debit card [no fee, bill shows Partly paid]; credit card [fee line, total matches Stripe].
- [ ] Decline card then good card on the same page [one payment, no leftover fee].
- [ ] Bank account [started; posts after Stripe confirms].
- [ ] Ask for a plan; take it back; ask again.
- [ ] Try another account's id in the address bar [not found].

**Meter reader**
- [ ] Reading list shows no names or balances. Lower reading asks twice. Offline reading sends later, once.
- [ ] Complete a shutoff order with a note.

**Clerk**
- [ ] Accept a flagged reading with usage typed in. Cannot accept own reading.
- [ ] Start, calculate, recalculate a run; cannot approve it.
- [ ] Add late charges today [once]; for next month [refused].
- [ ] Shutoff list respects notice period and plans. Order shutoff; second order refused; reconnect refused until paid.
- [ ] Print bills and envelopes [nothing blank, town line on envelopes, total matches]; email bills twice [second sends 0].
- [ ] Fix a reading: preview amount is right; cannot approve own fix.

**Cashier**
- [ ] Counter cash and check post at once. Approve, charge, run, settings, log [all refused].

**Customer service**
- [ ] Answer a dispute and a request; resident sees the notes. Refund larger than credit [refused].

**Approver**
- [ ] Every approval asks for the emailed code. Cannot approve own request. Second approver needed above the limit.
- [ ] Approve a plan with a changed schedule; 2099 start date [refused]; customer emailed.
- [ ] Reverse a ledger entry once; second reversal [refused].

**City administrator**
- [ ] Add a person, give a role [other admins emailed]; cannot change own roles.
- [ ] Save settings [safety check]; safety-check minutes 100 [refused]. Add a rate with a unit. Empty print layout [refused].

**Site administrator**
- [ ] Any account page [refused]; money setting [refused]; non-money setting [saved].

**Auditor**
- [ ] Activity log opens and the check says intact. Any write [refused].
