-- Refunds of a credit balance go through the same approval path as adjustments (a different person approves).
alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check check (kind in ('adjustment','charge','refund'));
