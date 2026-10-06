# Graph Report - frmerchandise  (2026-09-28)

## Corpus Check
- 58 files · ~81,096 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 3, .css 2, .graphify-bak 1)

## Summary
- 199 nodes · 514 edges · 18 communities (12 shown, 6 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7a9dd2fb`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- api
- renderDashboard
- escapeHtml
- money
- FR Merchandise POS
- initCustomDropdowns
- renderCart
- initCustomDatePickers
- index.ts
- check-pos.mjs
- isMobileScreen
- compilerOptions
- alignTableBadges
- renderStockInHistoryTable
- service-worker.js
- graphify-hook-test.js

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 41 edges
2. `renderInventory()` - 27 edges
3. `api()` - 26 edges
4. `showToast()` - 25 edges
5. `refresh()` - 21 edges
6. `money()` - 19 edges
7. `renderCart()` - 15 edges
8. `askConfirmation()` - 13 edges
9. `displayCustomerName()` - 13 edges
10. `openForm()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Graphify Workflow` --references--> `FR Merchandise POS`  [INFERRED]
  AGENTS.md → README.md
- `Backup and Restore` --rationale_for--> `FR Merchandise POS`  [INFERRED]
  docs/OPERATIONS.md → README.md
- `Release Procedure` --rationale_for--> `FR Merchandise POS`  [INFERRED]
  docs/OPERATIONS.md → README.md
- `Bundle Sales` --conceptually_related_to--> `FIFO Selling Price Batches`  [EXTRACTED]
  TASKS.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **FIFO Auditability Workflow** — readme_fifo_selling_price_batches, tasks_bundle_sales, docs_operations_backup_and_restore [INFERRED 0.75]

## Communities (18 total, 6 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.04
Nodes (43): actionConfirmDialog, actionConfirmSubmitBtn, adminAccounts, allProducts, appShell, backdrop, branches, bundleAvailability (+35 more)

### Community 1 - "api"
Cohesion: 0.14
Nodes (35): api(), applySession(), askConfirmation(), backgroundRefresh(), changeOwnPassword(), completeRequiredPasswordChange(), deleteProduct(), downloadOperationalBackup() (+27 more)

### Community 2 - "renderDashboard"
Cohesion: 0.13
Nodes (24): bindQuarantineFilterChips_(), ensureQuarantineDateDefaults(), ensureSalesDateDefaults(), formatDateInput(), formatTransferQuantity(), generateInventoryReportPdf(), generateQuarantinePdf(), generateSalesPdf() (+16 more)

### Community 3 - "escapeHtml"
Cohesion: 0.31
Nodes (15): escapeHtml(), formatDateTime(), handleTransferAction(), openForm(), openTransferReceiptDialog_(), renderAdminAccount(), renderBranches(), renderInventory() (+7 more)

### Community 4 - "money"
Cohesion: 0.27
Nodes (14): calculateOutstandingCreditAccounts(), deleteCreditPayment(), displayCustomerName(), money(), openCreditHistory(), openCreditPayment(), openSaleReturnDialog(), renderCreditPayments() (+6 more)

### Community 5 - "FR Merchandise POS"
Cohesion: 0.20
Nodes (10): Graphify Workflow, Backup and Restore, Release Procedure, FIFO Selling Price Batches, FR Merchandise POS, Google Apps Script Web App, Google Sheets, Bundle Sales (+2 more)

### Community 6 - "initCustomDropdowns"
Cohesion: 0.19
Nodes (15): closeDropdown(), initCustomDropdowns(), initSidebarBranchSwitcher(), openDropdown(), openSaleCheckout(), positionDropdownMenu(), renderBranchSelector(), renderSidebarBranchMenu() (+7 more)

### Community 7 - "renderCart"
Cohesion: 0.29
Nodes (8): addToCart(), cartItemTotal(), displayedSellingPrice(), getCartPriceBreakdown(), renderCart(), saleSubtotal(), updateCartScrollFade(), updateQty()

### Community 8 - "initCustomDatePickers"
Cohesion: 0.67
Nodes (3): closeDatePicker(), initCustomDatePickers(), openDatePicker()

### Community 9 - "index.ts"
Cohesion: 0.40
Nodes (5): ref_npm_supabase, allowedPermissions, corsHeaders, fail(), json()

### Community 10 - "check-pos.mjs"
Cohesion: 0.40
Nodes (4): ref_node_fs, checks, failures, files

### Community 11 - "isMobileScreen"
Cohesion: 0.50
Nodes (4): handleMenuToggle(), handleSidebarCollapse(), initSidebarState(), isMobileScreen()

## Knowledge Gaps
- **53 isolated node(s):** `graphifyHookTest`, `actionConfirmDialog`, `actionConfirmSubmitBtn`, `adminAccounts`, `allProducts` (+48 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 66 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `escapeHtml()` connect `escapeHtml` to `app.js`, `api`, `renderDashboard`, `money`, `initCustomDropdowns`, `renderCart`, `renderStockInHistoryTable`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `api()` connect `api` to `app.js`, `escapeHtml`, `money`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `renderInventory()` connect `escapeHtml` to `app.js`, `api`, `renderDashboard`, `money`, `renderCart`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `graphifyHookTest`, `actionConfirmDialog`, `actionConfirmSubmitBtn` to the rest of the system?**
  _53 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.041666666666666664 - nodes in this community are weakly interconnected._
- **Should `api` be split into smaller, more focused modules?**
  _Cohesion score 0.1361344537815126 - nodes in this community are weakly interconnected._
- **Should `renderDashboard` be split into smaller, more focused modules?**
  _Cohesion score 0.13405797101449277 - nodes in this community are weakly interconnected._