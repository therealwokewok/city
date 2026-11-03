-- Cashiers and customer service answer questions about bills, so staff who can read accounts see posted bills.
-- Draft bills (a run not yet approved) stay with the people who run billing.
drop policy b_sel on bills;
create policy b_sel on bills for select using (city_id = app_city() and (app_perm('runs.read')
  or (status = 'posted' and app_perm('accounts.read'))
  or (status = 'posted' and exists (select 1 from account_links l where l.account_id = bills.account_id and l.user_id = app_user()))));
