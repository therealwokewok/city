-- Residents see which month a bill covers without needing access to bill runs.
alter table bills add column period_start date, add column period_end date;
update bills b set period_start = r.period_start, period_end = r.period_end from bill_runs r where r.id = b.run_id;
