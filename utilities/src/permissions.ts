export const ROLES = ['site_admin', 'city_admin', 'billing_clerk', 'cashier', 'meter_reader', 'approver',
  'auditor', 'customer_service', 'resident'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Role to permission map. A person can hold several roles; their permissions are the union.
 * site_admin runs the system (users, settings) but gets no access to customer accounts or money.
 * meter_reader gets meters and readings only, never customer names or balances.
 */
export const ROLE_PERMS: Record<Role, string[]> = {
  site_admin: ['users.read', 'users.manage', 'settings.manage', 'services.toggle', 'city.manage', 'system.manage'],
  city_admin: ['users.read', 'users.manage', 'settings.manage', 'settings.money', 'services.toggle', 'city.manage', 'rates.manage', 'accounts.read',
    'accounts.manage', 'meters.read', 'runs.read', 'approvals.read', 'audit.read', 'print.read', 'print.manage', 'requests.review'],
  billing_clerk: ['accounts.read', 'accounts.manage', 'meters.read', 'readings.review', 'runs.read', 'runs.manage',
    'adjustments.request', 'approvals.read', 'charges.create', 'disputes.review', 'requests.review', 'print.read', 'print.run'],
  cashier: ['accounts.read', 'payments.record', 'adjustments.request', 'approvals.read'],
  meter_reader: ['meters.read', 'readings.submit', 'workorders.field'],
  approver: ['accounts.read', 'runs.read', 'runs.approve', 'approvals.read', 'approvals.decide', 'arrangements.decide'],
  auditor: ['accounts.read', 'runs.read', 'approvals.read', 'audit.read', 'users.read'],
  customer_service: ['accounts.read', 'accounts.manage', 'adjustments.request', 'approvals.read', 'charges.create',
    'disputes.review', 'requests.review'],
  resident: [],
};

/** Actions that need a recent re-confirmation by email code, even inside a live session. */
export const STEP_UP_ACTIONS = ['roles.grant', 'settings.update', 'run.approve', 'approval.decide', 'linkcode.regen',
  'rates.create', 'services.toggle', 'user.deactivate', 'arrangement.decide', 'ledger.reverse', 'city.update', 'database.update'] as const;

export function permsFor(roles: string[]): string[] {
  const s = new Set<string>();
  for (const r of roles) for (const p of ROLE_PERMS[r as Role] ?? []) s.add(p);
  return [...s];
}

/** Which roles a holder of a given role may hand out. site_admin cannot grant money roles. */
export const GRANTABLE_BY: Record<Role, Role[]> = {
  site_admin: ['city_admin'],
  city_admin: ['city_admin', 'billing_clerk', 'cashier', 'meter_reader', 'approver', 'auditor', 'customer_service'],
  billing_clerk: [], cashier: [], meter_reader: [], approver: [], auditor: [], customer_service: [], resident: [],
};

export function canGrant(granterRoles: string[], role: string): boolean {
  return granterRoles.some((g) => (GRANTABLE_BY[g as Role] ?? []).includes(role as Role));
}
