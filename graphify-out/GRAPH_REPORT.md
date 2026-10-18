# Graph Report - caishen-web  (2026-10-18)

## Corpus Check
- 65 files · ~103,623 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 12 file(s) not represented in the graph (top: (none) 3, .css 3, .graphify-bak 1)

## Summary
- 315 nodes · 741 edges · 27 communities (20 shown, 7 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f382e66e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- setView
- initCustomDropdowns
- buildSalesPdfReport_
- showToast
- FR Merchandise POS
- Review Focus
- What You Must Do When Invoked
- renderCart
- index.ts
- check-branch-registration.mjs
- isMobileScreen
- compilerOptions
- alignTableBadges
- escapeHtml
- service-worker.js
- graphify reference: extra exports and benchmark
- graphify reference: query, path, explain
- Daily Spot Cash Design
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- extraction-spec.md
- renderBranchSelector

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 47 edges
2. `renderInventory()` - 37 edges
3. `showToast()` - 28 edges
4. `api()` - 26 edges
5. `money()` - 25 edges
6. `refresh()` - 21 edges
7. `renderPaginationControls_()` - 19 edges
8. `askConfirmation()` - 16 edges
9. `renderCart()` - 16 edges
10. `renderDashboard()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Task 2: Branch-scoped Daily Spot Cash UI` --references--> `askConfirmation()`  [INFERRED]
  docs/superpowers/plans/2026-09-29-daily-spot-cash.md → app.js
- `Task 2: Branch-scoped Daily Spot Cash UI` --references--> `renderDailySpotCash()`  [INFERRED]
  docs/superpowers/plans/2026-09-29-daily-spot-cash.md → app.js
- `Graphify Workflow` --references--> `FR Merchandise POS`  [INFERRED]
  AGENTS.md → README.md
- `Backup and Restore` --rationale_for--> `FR Merchandise POS`  [INFERRED]
  docs/OPERATIONS.md → README.md
- `Release Procedure` --rationale_for--> `FR Merchandise POS`  [INFERRED]
  docs/OPERATIONS.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **FIFO Auditability Workflow** — readme_fifo_selling_price_batches, tasks_bundle_sales, docs_operations_backup_and_restore [INFERRED 0.75]

## Communities (27 total, 7 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.03
Nodes (69): actionConfirmDialog, actionConfirmSubmitBtn, adminAccounts, allProducts, appShell, backdrop, bindQuarantineFilterChips_(), branches (+61 more)

### Community 1 - "setView"
Cohesion: 0.42
Nodes (10): ensureCreditsDateDefaults(), ensureDailyExpensesDateDefaults(), ensureDailySpotCashDateDefaults(), ensureQuarantineDateDefaults(), ensureSalesDateDefaults(), ensureTransfersDateDefaults(), formatDateInput(), setView() (+2 more)

### Community 2 - "initCustomDropdowns"
Cohesion: 0.18
Nodes (13): closeDatePicker(), closeDropdown(), initCustomDatePickers(), initCustomDropdowns(), initSidebarBranchSwitcher(), openDatePicker(), openDropdown(), openSaleCheckout() (+5 more)

### Community 3 - "buildSalesPdfReport_"
Cohesion: 0.17
Nodes (17): buildSalesPdfReport_(), exportSalesPdf(), formatTransferQuantity(), generateInventoryReportPdf(), generateQuarantinePdf(), generateSalesPdf(), getInventoryReportMovement(), getInventoryReportRows() (+9 more)

### Community 4 - "showToast"
Cohesion: 0.14
Nodes (38): api(), applySession(), askConfirmation(), backgroundRefresh(), calculateOutstandingCreditAccounts(), changeOwnPassword(), completeRequiredPasswordChange(), deleteCreditPayment() (+30 more)

### Community 5 - "FR Merchandise POS"
Cohesion: 0.20
Nodes (10): Graphify Workflow, Backup and Restore, Release Procedure, FIFO Selling Price Batches, FR Merchandise POS, Google Apps Script Web App, Google Sheets, Bundle Sales (+2 more)

### Community 6 - "Review Focus"
Cohesion: 0.29
Nodes (6): Daily Spot Cash Implementation Plan, Global Constraints, Review Focus, Task 1: Database and permission contract, Task 2: Branch-scoped Daily Spot Cash UI, Task 3: Deployment and acceptance verification

### Community 7 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 8 - "renderCart"
Cohesion: 0.27
Nodes (10): addToCart(), cartItemTotal(), displayedSellingPrice(), getCartPriceBreakdown(), hasSellingPriceOverride(), openProductPriceOverride(), renderCart(), saleSubtotal() (+2 more)

### Community 9 - "index.ts"
Cohesion: 0.40
Nodes (5): ref_npm_supabase, allowedPermissions, corsHeaders, fail(), json()

### Community 10 - "check-branch-registration.mjs"
Cohesion: 0.17
Nodes (9): ref_node_assert, ref_node_crypto, ref_node_fs, ref_node_vm, apiSource, main, checks, failures (+1 more)

### Community 11 - "isMobileScreen"
Cohesion: 0.50
Nodes (4): handleMenuToggle(), handleSidebarCollapse(), initSidebarState(), isMobileScreen()

### Community 14 - "escapeHtml"
Cohesion: 0.25
Nodes (33): bindPaginationEvents_(), displayCustomerName(), escapeHtml(), formatDateTime(), getCustomerInitials(), getQuarantineReportData_(), money(), openCreditHistory() (+25 more)

### Community 17 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 18 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 19 - "Daily Spot Cash Design"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Access and audit, Daily Spot Cash Design, Data flow, Goal, Record model, Scope, User interface

### Community 20 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 21 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 22 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 27 - "renderBranchSelector"
Cohesion: 0.83
Nodes (4): renderBranchSelector(), renderSidebarBranchMenu(), setActiveBranch(), updateActiveBranchLabels()

## Knowledge Gaps
- **119 isolated node(s):** `supabaseClient`, `products`, `allProducts`, `branches`, `customers` (+114 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 145 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Task 2: Branch-scoped Daily Spot Cash UI` connect `Review Focus` to `showToast`, `escapeHtml`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `renderDailySpotCash()` connect `escapeHtml` to `app.js`, `setView`, `showToast`, `Review Focus`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `supabaseClient`, `products`, `allProducts` to the rest of the system?**
  _119 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.02702702702702703 - nodes in this community are weakly interconnected._
- **Should `showToast` be split into smaller, more focused modules?**
  _Cohesion score 0.1422475106685633 - nodes in this community are weakly interconnected._
- **Should `What You Must Do When Invoked` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._