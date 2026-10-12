# Graph Report - caishen-web  (2026-10-12)

## Corpus Check
- 64 files · ~103,244 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 12 file(s) not represented in the graph (top: (none) 3, .css 3, .graphify-bak 1)

## Summary
- 308 nodes · 735 edges · 27 communities (20 shown, 7 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6106cfc1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- initCustomDatePickers
- initCustomDropdowns
- setView
- showToast
- FR Merchandise POS
- Review Focus
- What You Must Do When Invoked
- renderCart
- index.ts
- check-pos.mjs
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
7. `renderPaginationControls_()` - 20 edges
8. `askConfirmation()` - 16 edges
9. `renderDashboard()` - 16 edges
10. `renderCart()` - 16 edges

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
Nodes (61): actionConfirmDialog, actionConfirmSubmitBtn, adminAccounts, allProducts, appShell, backdrop, bindQuarantineFilterChips_(), branches (+53 more)

### Community 1 - "initCustomDatePickers"
Cohesion: 0.67
Nodes (3): closeDatePicker(), initCustomDatePickers(), openDatePicker()

### Community 2 - "initCustomDropdowns"
Cohesion: 0.32
Nodes (8): closeDropdown(), initCustomDropdowns(), initSidebarBranchSwitcher(), openDropdown(), positionDropdownMenu(), repositionOpenDropdowns(), sortSelectOptionsAtoZ_(), updateCustomDropdown()

### Community 3 - "setView"
Cohesion: 0.12
Nodes (28): buildSalesPdfReport_(), ensureCreditsDateDefaults(), ensureDailyExpensesDateDefaults(), ensureDailySpotCashDateDefaults(), ensureQuarantineDateDefaults(), ensureSalesDateDefaults(), ensureTransfersDateDefaults(), exportSalesPdf() (+20 more)

### Community 4 - "showToast"
Cohesion: 0.11
Nodes (44): api(), applySession(), askConfirmation(), backgroundRefresh(), calculateOutstandingCreditAccounts(), changeOwnPassword(), completeRequiredPasswordChange(), deleteCreditPayment() (+36 more)

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
Cohesion: 0.21
Nodes (12): addToCart(), cartItemTotal(), displayedSellingPrice(), getCartPriceBreakdown(), hasSellingPriceOverride(), openProductPriceOverride(), openSaleCheckout(), renderCart() (+4 more)

### Community 9 - "index.ts"
Cohesion: 0.40
Nodes (5): ref_npm_supabase, allowedPermissions, corsHeaders, fail(), json()

### Community 10 - "check-pos.mjs"
Cohesion: 0.40
Nodes (4): ref_node_fs, checks, failures, files

### Community 11 - "isMobileScreen"
Cohesion: 0.50
Nodes (4): handleMenuToggle(), handleSidebarCollapse(), initSidebarState(), isMobileScreen()

### Community 14 - "escapeHtml"
Cohesion: 0.25
Nodes (34): bindPaginationEvents_(), deleteDailyExpense(), deleteDailySpotCash(), displayCustomerName(), escapeHtml(), formatDateTime(), getCustomerInitials(), money() (+26 more)

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
- **117 isolated node(s):** `supabaseClient`, `products`, `allProducts`, `branches`, `customers` (+112 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 140 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Task 2: Branch-scoped Daily Spot Cash UI` connect `Review Focus` to `showToast`, `escapeHtml`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `renderDailySpotCash()` connect `escapeHtml` to `app.js`, `setView`, `Review Focus`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `supabaseClient`, `products`, `allProducts` to the rest of the system?**
  _117 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.030303030303030304 - nodes in this community are weakly interconnected._
- **Should `setView` be split into smaller, more focused modules?**
  _Cohesion score 0.12169312169312169 - nodes in this community are weakly interconnected._
- **Should `showToast` be split into smaller, more focused modules?**
  _Cohesion score 0.10570824524312897 - nodes in this community are weakly interconnected._
- **Should `What You Must Do When Invoked` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._