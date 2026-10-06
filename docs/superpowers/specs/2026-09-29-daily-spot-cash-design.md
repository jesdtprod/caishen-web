# Daily Spot Cash Design

## Goal

Provide an auditable opening-cash record for each branch and business date before daily operations begin.

## Scope

Daily Spot Cash is a Branch Operations feature. It records the opening cash float only; it does not calculate sales totals, end-of-day cash, expenses, or net income. Those are later features.

## Record model

Each active record contains:

- immutable UUID identity;
- `branch_id`, tied to an active branch;
- `business_date`, stored as a date;
- non-negative `opening_cash` amount;
- optional notes;
- `created_at` / `created_by` and `updated_at` / `updated_by`;
- soft-delete fields (`deleted_at`, `deleted_by`) so deletion removes the entry from normal history without destroying its audit trail.

Only one non-deleted Daily Spot Cash record may exist for a branch and business date. The database, rather than the browser, enforces this rule.

## Access and audit

- Administrators can view and manage records for every branch.
- A staff member must have the new `dailySpotCash` permission and may only view, add, edit, or delete records for their assigned branch.
- A disallowed staff member cannot see the navigation item or invoke the protected database actions.
- Create, edit, and delete actions write an `account_audit` entry. A delete is soft, retaining the original amount and its creator for audit purposes.

## User interface

- Add **Daily Spot Cash** under Branch Operations and use the established shared branch selector.
- Show the active branch and today's record prominently. The entry form uses Business Date, Opening Cash, and Notes.
- Show a date-filtered history for the active branch with amount, notes, recorded/updated metadata, and Edit/Delete actions.
- Reuse existing button, datepicker, dropdown, dialog, table, confirmation, and responsive styles; do not introduce a parallel design system.
- The Staff Accounts permission form and permission chips include **Daily Spot Cash** as an allow/disallow option.

## Data flow

The app loads non-deleted Daily Spot Cash rows for `activeBranchId` with its existing branch data. Protected database functions validate active status, branch access, permission, amount, and the one-record-per-day rule before mutation. After a successful mutation, the app refreshes the selected branch data.

## Acceptance criteria

1. Creating a record for Branch A never exposes it in Branch B.
2. A permitted staff member cannot create, edit, or delete a record outside their assigned branch.
3. A second active record for the same branch/date is rejected.
4. Edit updates the visible amount/notes and audit metadata.
5. Delete removes the record from normal history but preserves an audit trail.
6. Removing `dailySpotCash` from a staff account hides the feature and blocks its data actions.
