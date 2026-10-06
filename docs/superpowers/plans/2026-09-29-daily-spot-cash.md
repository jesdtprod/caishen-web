# Daily Spot Cash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add branch-scoped Daily Spot Cash opening-float CRUD with staff permission control and audit retention.

**Architecture:** A new Supabase table and protected RPC functions enforce branch isolation, permission, validation, uniqueness, and soft deletion. The static frontend loads only the active branch's active rows and renders the feature through the established view, form, confirmation, table, and staff-permission patterns.

**Tech Stack:** Static HTML/CSS/JavaScript, Supabase PostgreSQL/RLS/RPC, Supabase Edge Function, Node static checks.

**Spec:** `docs/superpowers/specs/2026-09-29-daily-spot-cash-design.md`

## Global Constraints

- Feature permission key is exactly `dailySpotCash`.
- A staff member can act only within their assigned branch; administrators retain all-branch access.
- One non-deleted row exists per `branch_id` and `business_date`.
- Deletes are soft and must create an `account_audit` record.
- Reuse the existing UI design system and shared controls.

## Review Focus

- Duplicate active rows for the same branch/date are rejected by the database.
- A permitted staff user is blocked from another branch, even if the browser payload is changed.
- A staff user without `dailySpotCash` cannot see or mutate the feature.
- Deleted rows no longer appear in normal history while remaining recoverable for audit.
- Zero is accepted as an opening cash amount; negative, blank, and invalid amounts are rejected.

---

### Task 1: Database and permission contract

**Files:**
- Create: `supabase/migrations/20260929100000_daily_spot_cash.sql`
- Modify: `supabase/functions/manage-account/index.ts`
- Modify: `scripts/check-pos.mjs`

**Interfaces:**
- Produces table `public.daily_spot_cash` and RPCs `create_daily_spot_cash(text, date, numeric, text)`, `update_daily_spot_cash(uuid, date, numeric, text)`, and `delete_daily_spot_cash(uuid)`.
- Produces the `dailySpotCash` profile permission accepted by account management.

- [ ] **Step 1: Write failing static checks**

Add checks for the new permission, branch/permission guards, active-row uniqueness, non-negative amount validation, soft-delete fields, audit inserts, and RPC grants.

- [ ] **Step 2: Run the static checks and verify the Daily Spot Cash checks fail**

Run: `node scripts/check-pos.mjs`

- [ ] **Step 3: Add the migration and account-permission allowlist**

Create the table with UUID primary key, `branch_id`, `business_date`, `opening_cash numeric(12,2)`, notes, created/updated/deleted metadata, and a partial unique index for active rows. Add RLS read policy for `dailySpotCash` plus branch access. Implement security-definer RPCs that validate permissions, branch access, active branch status, and input; write each mutation to `account_audit`; revoke default function access and grant authenticated execution. Add `dailySpotCash` to the Edge Function allowlist.

- [ ] **Step 4: Run the static checks and verify they pass**

Run: `node scripts/check-pos.mjs`

- [ ] **Step 5: Commit the database contract**

Commit message: `feat: add daily spot cash data contract`

### Task 2: Branch-scoped Daily Spot Cash UI

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `scripts/check-pos.mjs`

**Interfaces:**
- Consumes `daily_spot_cash` rows from `getAppData_(activeBranchId)` and the Task 1 RPCs.
- Produces view key `dailySpotCash`, renderer `renderDailySpotCash()`, and CRUD handlers.

- [ ] **Step 1: Write failing static checks**

Require the `dailySpotCash` view/menu, the staff permission checkbox/chip, active-branch data load, date-filtered history, and add/edit/delete handler bindings.

- [ ] **Step 2: Run the static checks and verify the UI checks fail**

Run: `node scripts/check-pos.mjs`

- [ ] **Step 3: Implement the view, form, and handlers**

Extend the existing app data mapping with active daily spot-cash records. Add Daily Spot Cash to staff-menu definitions, staff form permissions, valid views, sidebar navigation, and permission routing. Render the active branch, Business Date, Opening Cash, Notes, current-day summary, and history table. Reuse the shared form dialog for create/edit and `askConfirmation()` for delete; call Task 1 RPCs and refresh after success.

- [ ] **Step 4: Add responsive styling using existing shared classes**

Add only feature-specific layout rules needed for the summary/history while retaining the established buttons, dropdowns, datepicker, modal, and table treatment on desktop and mobile.

- [ ] **Step 5: Run static checks and JavaScript syntax verification**

Run: `node scripts/check-pos.mjs && node --check app.js && git diff --check`

- [ ] **Step 6: Commit the UI feature**

Commit message: `feat: add daily spot cash operations`

### Task 3: Deployment and acceptance verification

**Files:**
- Modify: `README.md` only if deployment instructions need the new migration/RPC noted.

**Interfaces:**
- Consumes Tasks 1 and 2.
- Produces verified local source and an explicit live-deployment checklist.

- [ ] **Step 1: Run full local verification**

Run: `node scripts/check-pos.mjs && node --check app.js && git diff --check`

- [ ] **Step 2: Inspect the final diff and migration**

Confirm that the migration protects branch access and the frontend uses the same `dailySpotCash` permission key throughout.

- [ ] **Step 3: Apply the SQL migration and deploy the Edge Function**

Apply `20260929100000_daily_spot_cash.sql` in Supabase and redeploy `manage-account`; source changes alone do not activate the live feature.

- [ ] **Step 4: Perform live branch/permission acceptance tests**

Verify an administrator can manage both branches; an allowed staff member can manage only their branch; a disallowed staff member cannot see or invoke the feature; duplicate same-day entry fails; and deletion disappears from history while audit data remains.

- [ ] **Step 5: Commit any deployment documentation change and push**

Commit message: `docs: document daily spot cash deployment`
