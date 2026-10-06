# FR Merchandise POS Tasks

## Completed In Code

- [x] Preserve FIFO selling-price batches during stock transfers, including mixed-batch dispatch and receipt.
- [x] Lock a staff account's assigned branch after account creation. Administrators cannot change it through account editing, and a database trigger rejects direct changes.
- [x] Allow administrators to edit permitted administrator profile details.
- [x] Allow an administrator to reset another administrator's password and require a new password at the next sign-in.
- [x] Add a repeatable source-contract check: `node scripts/check-pos.mjs`.
- [x] Document release, backup, restore, and Supabase CLI migration procedures in `docs/OPERATIONS.md`.

## Before Production Use

- [ ] Create and test a Supabase database backup and restore procedure.
- [ ] Create a second active administrator account and securely retain both recovery credentials.
- [ ] Reconcile imported inventory, sales totals, and outstanding credit balances against the source workbook.
- [ ] Test the deployed GitHub Pages application, including staff creation, password reset enforcement, transfers, and logout.

## Follow-Up

- [x] Replace the Product Catalog's fixed selling price with FIFO Stock In batch selling prices: use the oldest available batch's price in the catalog, split mixed-batch cart quantities into their applicable batch prices, recalculate totals as quantities change, and retain the exact batch-price breakdown on completed sales.
- [ ] Configure Supabase CLI access and run the documented migration deployment on a future release.
- [ ] Expand source-contract checks into live Supabase integration tests when a non-production project is available.

## Planned: Returns, Replacements, and Bundles

> Complete and review one phase before starting the next phase.

### Phase 0 — Confirm business rules

- [ ] Confirm empty-shell ownership and the exact Full Set, Refill, and Exchange rules.
- [ ] Confirm which returned conditions may be restocked, supplier-returned, or disposed.
- [ ] Confirm cash and credit refund authorization rules.

### Phase 1 — Individual item returns

- [ ] Add return inventory states: sellable, quarantine, supplier return, and disposed.
- [ ] Add return, refund, replacement, inspection, restock, supplier-return, and disposal records.
- [ ] Link every return/refund/replacement to its original sale and FIFO allocation.
- [ ] Support partial quantities and customer credit adjustments.

### Phase 2 — Bundle product setup

- [ ] Add Individual Item and Bundle / Set product types.
- [ ] Add bundle recipes: component product and required quantity.
- [ ] Add a bundle-specific selling price.
- [ ] Calculate available bundle quantity from sellable component stock only.

### Phase 3 — Bundle sales

- [ ] Sell a bundle as one receipt line at its own price.
- [ ] Deduct each component through FIFO and retain the allocation audit trail.
- [ ] Restore component batches when a bundle sale is cancelled.

### Phase 4 — Bundle transfers

- [ ] Transfer a bundle by allocating and moving its components.
- [ ] Preserve FIFO cost and selling-price portions across the destination receipt.
- [ ] Recalculate bundle availability at both branches.

### Phase 5 — Bundle returns and replacements

- [ ] Process bundle returns component-by-component into the correct return state.
- [ ] Support bundle replacement and refund against the original bundle sale.
- [ ] Add LPG Full Set, Refill, and Exchange workflows.

### Phase 6 — Reports, audit, and recovery

- [ ] Add bundle sales, component consumption, returns, quarantine, supplier-return, and disposal reports.
- [ ] Extend audit history and backup/restore for all new records and FIFO allocations.
- [ ] Run local, Supabase, and browser workflow tests for every completed phase.
