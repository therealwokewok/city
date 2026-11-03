# Collecting autopay on a schedule

Residents who set up autopay are charged when their bill comes due. Staff can run it by hand from the billing screen, and you can run it every day automatically.

Each bill is tried once, ever, so running it daily is safe. A failed charge is not retried; the resident is emailed and the bill shows as unpaid like any other.

## Run it

```
DATABASE_URL=... STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... \
EMAIL_API_URL=... EMAIL_API_TOKEN=... EMAIL_FROM=... \
npm run autopay -- utilities.example.gov
```

In the container image:

```
docker compose run --rm app node dist/src/autopayCli.js utilities.example.gov
```

Give it the city's host name (more than one is fine). It prints how many bills were charged, failed or skipped. The exit code is 1 if any charge failed, so your scheduler can alert you.

## Schedule it

Once a day in the morning is plenty. Any scheduler works, for example cron:

```
15 9 * * *  cd /srv/utilities && docker compose run --rm app node dist/src/autopayCli.js utilities.example.gov
```

The charge only becomes money on the account when Stripe confirms it through the signed webhook, the same as every other payment.

If the city is still in demo mode, the script refuses to charge real cards.
