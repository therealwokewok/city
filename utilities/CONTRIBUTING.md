# Contributing

Thanks for helping. This project exists so any small city can run its utilities without an expensive vendor.

- `npm ci`, start PostgreSQL 16, create a database named `utilities_test` owned by a role `utilities_owner`
  (or set `TEST_DATABASE_URL`), then `npm test`.
- Every change that touches money, roles, or the database needs a test. A change that weakens a security
  rule needs a written reason in the pull request.
- Anything specific to one city or one state belongs in settings or a "state pack", not in the core.
- Keep user-facing words plain. The people using this are residents and city clerks, not engineers.
- Do not add dependencies lightly. Each one is code we have to trust.
- Screens live in `public/` with no build step. Test any screen change in the browser: see "Browser tests" in the README.
  New screens need a phone-size test, an accessibility scan, and plain wording a first-time resident can follow.
