-- A fee the city passed on to the customer for paying online. It is charged with the payment but is not credited to
-- the account: amount_cents pays the bill, fee_cents covers the processor's cost.
alter table payments add column fee_cents bigint not null default 0 check (fee_cents >= 0);
grant update (fee_cents) on payments to utilities_app;
