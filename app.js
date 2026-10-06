const ACTIVE_BRANCH_KEY = 'ce-pos-active-branch';
const ACTIVE_VIEW_KEY = 'ce-pos-active-view';
let activeBranchId = localStorage.getItem(ACTIVE_BRANCH_KEY) || 'MAIN';
const ADMIN_SESSION_KEY = 'ce-pos-admin-session';
const INITIAL_ADMIN_KEY = 'ce-pos-initial-admin';
const INITIAL_ADMIN_REGISTERED_KEY = 'ce-pos-initial-admin-registered';
const supabaseConfig = window.CE_POS_SUPABASE || {};
const supabaseClient = window.supabase?.createClient?.(supabaseConfig.url, supabaseConfig.publishableKey);
let products = [];
let allProducts = [];
let branches = [];
let customers = [];
let transfers = [];
let creditAccounts = [];
let creditPayments = [];
let openingCreditAccounts = [];
let pendingCreditAccount = null;
let salesHistory = [];
let saleReturns = [];
let saleReturnItems = [];
let inventoryReturnLots = [];
let inventoryQuarantineCases = [];
let inventoryQuarantineItems = [];
let inventoryReportData = {};
let stockInHistory = [];
let dailySpotCash = [];
let dailyExpenses = [];
let sellingPriceBatches = [];
let bundleComponents = [];
let bundleAvailability = {};
let cart = [];
let activeForm = '';
let activeView = 'pos';
let currentSession = null;
let staffAccounts = [];
let adminAccount = null;
let adminAccounts = [];
let editingProductId = '';
let pendingActionConfirmResolver = null;
let toastTimer = null;
let refreshInFlight = false;
let pendingTransferReceipt = null;
let activeQuarantineFilter = 'all';

// Utility: debounce — delays fn execution until after `wait` ms of silence
function debounce(fn, wait = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// Fire a silent background refresh (no skeleton, non-blocking)
function backgroundRefresh() {
  refresh(false).catch(() => {});
}

const PRODUCT_CATEGORIES = ['Supplies', 'Rice', 'Water', 'Catering'];
const PRODUCT_UNITS = ['bag', 'bottle', 'box', 'can', 'case', 'drum', 'g', 'gallon', 'kg', 'L', 'mL', 'pack', 'pc', 'sack', 'tray'];
const DAILY_EXPENSE_CATEGORIES = ['Rent', 'Utilities', 'Salaries & Wages', 'Transportation', 'Fuel', 'Supplies', 'Repairs & Maintenance', 'Marketing & Advertising', 'Delivery & Freight', 'Government Fees & Taxes', 'Professional Fees', 'Food & Refreshments', 'Miscellaneous'];

const $ = (selector) => document.querySelector(selector);
const money = (value) => `PHP ${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let badgeAlignmentFrame = 0;
function alignTableBadges() {
  const table = $('#inventoryTable');
  if (!table) return;
  const badges = [...table.querySelectorAll('.stock-pill, .low-stock-pill, .category-badge, .transfer-quantity, .credit-sale-badge, .payment-collected-badge')]
    .filter((badge) => badge.getBoundingClientRect().width > 0);

  badges.forEach((badge) => {
    badge.style.width = '';
    badge.style.justifyContent = '';
  });
  if (window.matchMedia('(max-width: 640px)').matches) return;

  const columns = new Map();
  badges.forEach((badge) => {
    const rect = badge.getBoundingClientRect();
    const key = Math.round(rect.left / 4) * 4;
    const column = columns.get(key) || { width: 0, badges: [] };
    column.width = Math.max(column.width, rect.width);
    column.badges.push(badge);
    columns.set(key, column);
  });
  columns.forEach((column) => column.badges.forEach((badge) => {
    badge.style.width = `${Math.ceil(column.width)}px`;
    badge.style.justifyContent = badge.classList.contains('transfer-quantity') ? 'flex-start' : 'center';
  }));
}

function scheduleBadgeAlignment() {
  cancelAnimationFrame(badgeAlignmentFrame);
  badgeAlignmentFrame = requestAnimationFrame(alignTableBadges);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function displayCustomerName(value) {
  return String(value ?? '').toUpperCase();
}

function sortByName_(rows, key = 'name') {
  return [...rows].sort((left, right) => String(left[key] || '').localeCompare(String(right[key] || ''), 'en', { sensitivity: 'base' }));
}

function readBundleComponents_(formEl, productType) {
  if (productType !== 'bundle') return [];
  const rows = [...formEl.querySelectorAll('[data-bundle-component-row]')].map((row) => ({
    productId: row.querySelector('[name="bundleComponentProduct"]')?.value || '',
    qty: Number(row.querySelector('[name="bundleComponentQty"]')?.value || 0),
  }));
  if (!rows.length || rows.some((item) => !item.productId || !Number.isFinite(item.qty) || item.qty <= 0)) {
    throw new Error('Add at least one component and enter a quantity for each one.');
  }
  if (new Set(rows.map((item) => item.productId)).size !== rows.length) throw new Error('A component can only be added once to a bundle.');
  return rows;
}

function readTransferLines_(formEl) {
  const lines = [...formEl.querySelectorAll('[data-transfer-line]')].map((row) => ({
    productId: row.querySelector('[name="transferProduct"]')?.value || '',
    qty: Number(row.querySelector('[name="transferQty"]')?.value || 0),
  }));
  if (!lines.length || lines.some((line) => !line.productId || !Number.isFinite(line.qty) || line.qty <= 0)) throw new Error('Add at least one valid transfer line.');
  if (new Set(lines.map((line) => line.productId)).size !== lines.length) throw new Error('Add each product or bundle only once per transfer.');
  return lines;
}

function readStockInLines_(formEl) {
  const lines = [...formEl.querySelectorAll('[data-stock-in-line]')].map((row) => ({
    productId: row.querySelector('[name="productId"]')?.value || '', qty: Number(row.querySelector('[name="qty"]')?.value || 0),
    quarantineQty: Number(row.querySelector('[name="quarantineQty"]')?.value || 0), sellingPrice: Number(row.querySelector('[name="sellingPrice"]')?.value || 0),
    quarantineReason: row.querySelector('[name="quarantineReason"]')?.value || '',
  }));
  if (!lines.length || lines.some((line) => !line.productId || line.qty <= 0 || line.quarantineQty < 0 || line.quarantineQty > line.qty || line.sellingPrice < 0 || (line.quarantineQty > 0 && !line.quarantineReason.trim()))) throw new Error('Complete every stock-in line and add a reason for quarantined units.');
  if (new Set(lines.map((line) => line.productId)).size !== lines.length) throw new Error('Add each product only once per stock-in receipt.');
  return lines;
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureSalesDateDefaults() {
  const dateFrom = $('#salesDateFrom');
  const dateTo = $('#salesDateTo');
  if (!dateFrom || !dateTo) return;

  const today = new Date();
  if (!dateFrom.value) dateFrom.value = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  if (!dateTo.value) dateTo.value = formatDateInput(today);
  syncCustomDatePicker(dateFrom);
  syncCustomDatePicker(dateTo);
}

function ensureQuarantineDateDefaults() {
  const dateFrom = $('#quarantineDateFrom');
  const dateTo = $('#quarantineDateTo');
  if (!dateFrom || !dateTo) return;

  const today = new Date();
  if (!dateFrom.value) dateFrom.value = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  if (!dateTo.value) dateTo.value = formatDateInput(today);
  syncCustomDatePicker(dateFrom);
  syncCustomDatePicker(dateTo);
}

function saleDateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatDateInput(date);
}

function calculateOutstandingCreditAccounts(sales, payments, openingAccounts = []) {
  const paidByCredit = payments.reduce((totals, payment) => {
    const creditId = payment.creditId || payment.saleId;
    totals[creditId] = (totals[creditId] || 0) + Number(payment.amount || 0);
    return totals;
  }, {});
  const saleAccounts = sales
    .filter((sale) => String(sale.paymentType || '').toLowerCase() === 'credit')
    .map((sale) => {
      const total = Number(sale.total || 0);
      const paid = paidByCredit[sale.saleId] || 0;
      return { creditId: sale.saleId, saleId: sale.saleId, sourceType: 'sale', sourceLabel: 'Credit Sale', customerId: sale.customerId, customerName: sale.customerName, date: sale.date, total, paid, balance: Math.max(total - paid, 0) };
    });
  const migrationAccounts = openingAccounts.map((account) => {
    const total = Number(account.total || 0);
    const paid = paidByCredit[account.creditId] || 0;
    return { ...account, sourceType: 'previous_balance', sourceLabel: 'Previous Balance', total, paid, balance: Math.max(total - paid, 0) };
  });
  return [...saleAccounts, ...migrationAccounts]
    .filter((account) => account.balance > 0.00001)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function updateSalesPrintPeriod() {
  const period = $('#salesPrintPeriod');
  const dateFrom = $('#salesDateFrom')?.value || '';
  const dateTo = $('#salesDateTo')?.value || '';
  if (!period) return;

  const formatDate = (value) => value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { dateStyle: 'long' })
    : 'All dates';
  period.textContent = `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`;
}

function updateQuarantinePrintPeriod() {
  const period = $('#salesPrintPeriod');
  const dateFrom = $('#quarantineDateFrom')?.value || '';
  const dateTo = $('#quarantineDateTo')?.value || '';
  if (!period) return;

  const formatDate = (value) => value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { dateStyle: 'long' })
    : 'All dates';
  period.textContent = `Period: ${formatDate(dateFrom)} to ${formatDate(dateTo)}`;
}

function getReportDocumentHtml_(htmlContent, title = 'Report', isExport = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    @page {
      size: 8.5in 13in;
      margin: 10mm 12mm 12mm 12mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #0f172a;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    ${isExport ? `
      html, body {
        width: 816px !important;
        min-width: 816px !important;
        max-width: 816px !important;
        background: #ffffff !important;
      }
      .report-page {
        width: 816px !important;
        min-width: 816px !important;
        max-width: 816px !important;
        height: 1248px !important;
        min-height: 1248px !important;
        max-height: 1248px !important;
        background: #ffffff !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        padding: 10mm 14mm !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        overflow: hidden !important;
        margin: 0 !important;
      }
    ` : `
    @media screen {
      html {
        background: #08111e;
      }
      body {
        padding: 28px 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 28px;
        background: #08111e;
        min-height: 100vh;
      }
      .report-page {
        width: 8.5in;
        height: 13in;
        min-height: 13in;
        max-height: 13in;
        background: #ffffff;
        box-shadow: 0 14px 45px rgba(0, 0, 0, 0.45);
        border-radius: 4px;
        padding: 10mm 14mm;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        overflow: hidden;
      }
    }
    `}
    @media print {
      @page {
        size: 8.5in 13in;
        margin: 8mm 12mm 8mm 12mm;
      }
      html, body {
        background: #ffffff !important;
        background-color: #ffffff !important;
        background-image: none !important;
        color: #0f172a !important;
        width: 100% !important;
        height: auto !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        display: block !important;
        overflow: visible !important;
      }
      .report-page {
        width: 100% !important;
        height: auto !important;
        min-height: calc(13in - 16mm) !important;
        max-height: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        margin: 0 !important;
        border-radius: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        box-sizing: border-box !important;
      }
      .report-page:last-child,
      .report-page:last-of-type {
        page-break-after: auto !important;
        break-after: auto !important;
        page-break-after: avoid !important;
        break-after: avoid !important;
        min-height: 0 !important;
        margin-bottom: 0 !important;
        padding-bottom: 0 !important;
      }
    }
    .report-page-content {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .report-running-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #0f172a;
      margin-bottom: 10px;
    }
    .running-header-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .running-brand-title {
      font-size: 10px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      line-height: 1.2;
    }
    .running-brand-sub {
      font-size: 9px;
      color: #64748b;
      line-height: 1.2;
    }
    .running-meta-tag {
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #475569;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 2.5px 7px;
      white-space: nowrap;
    }
    .report-page-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 6px;
      border-top: 1px solid #cbd5e1;
      font-size: 8.5px;
      color: #64748b;
      margin-top: auto;
      flex-shrink: 0;
    }
    .page-footer-left {
      font-size: 8px;
      color: #64748b;
      letter-spacing: 0.2px;
    }
    .page-number-indicator {
      font-size: 9px;
      font-weight: 800;
      color: #0f172a;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.3px;
    }
    .report-page {
      font-size: 11.5px;
      line-height: 1.4;
      color: #1e293b;
    }
    .report-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #0f172a;
      margin-bottom: 12px;
    }
    .report-brand-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .report-badge-svg,
    .report-badge-img {
      width: 42px !important;
      height: 42px !important;
      max-width: 42px !important;
      max-height: 42px !important;
      object-fit: contain !important;
      flex-shrink: 0 !important;
    }
    .report-eyebrow {
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.8px;
      color: #0066f5;
      text-transform: uppercase;
      display: block;
      margin-bottom: 2px;
      line-height: 1.1;
    }
    .report-title {
      font-size: 17px;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 2px;
      letter-spacing: -0.2px;
      line-height: 1.2;
    }
    .report-subtitle {
      font-size: 10.5px;
      color: #64748b;
      margin: 0;
      line-height: 1.2;
    }
    .report-meta-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 6px 12px;
      text-align: right;
      font-size: 10px;
      min-width: 210px;
    }
    .report-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 1.5px 0;
    }
    .report-meta-row .meta-label { color: #64748b; }
    .report-meta-row .meta-val { color: #0f172a; font-weight: 600; }
    .report-kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }
    .report-kpi-card {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 7px 11px;
    }
    .report-kpi-grid > .report-kpi-card:nth-child(1) { order: 1; }
    .report-kpi-grid > .report-kpi-card:nth-child(2) { order: 2; }
    .report-kpi-grid > .report-kpi-card:nth-child(3) { order: 3; }
    .report-kpi-grid > .report-kpi-card:nth-child(9) { order: 4; }
    .report-kpi-grid > .report-kpi-card:nth-child(6) { order: 5; }
    .report-kpi-grid > .report-kpi-card:nth-child(10) { order: 6; }
    .report-kpi-grid > .report-kpi-card:nth-child(11) { order: 7; }
    .report-kpi-grid > .report-kpi-card:nth-child(12) { order: 8; }
    .report-kpi-grid > .report-kpi-card:nth-child(4) { order: 9; }
    .report-kpi-grid > .report-kpi-card:nth-child(5) { order: 10; }
    .report-kpi-grid > .report-kpi-card:nth-child(7) { order: 11; }
    .report-kpi-grid > .report-kpi-card:nth-child(8) { order: 12; }
    .report-kpi-card .kpi-label {
      font-size: 8.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #64748b;
      display: block;
      margin-bottom: 2px;
      line-height: 1.1;
    }
    .report-kpi-card .kpi-val {
      font-size: 14px;
      font-weight: 800;
      color: #0f172a;
      display: block;
      margin-bottom: 2px;
      line-height: 1.15;
    }
    .report-kpi-card .kpi-val.text-success { color: #059669; }
    .report-kpi-card .kpi-val.text-amber { color: #d97706; }
    .report-kpi-card .kpi-val.text-discount { color: #dc2626; }
    .report-kpi-card .kpi-val.text-cyan { color: #0284c7; }
    .report-kpi-card .kpi-sub { font-size: 8.5px; color: #94a3b8; line-height: 1.1; }
    .report-section-title-wrap {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 9px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e2e8f0;
    }
    .report-section-title {
      font-size: 11.5px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin: 0;
    }
    .report-count-badge {
      font-size: 9.5px;
      font-weight: 700;
      color: #475569;
      background: #e2e8f0;
      padding: 2px 7px;
      border-radius: 10px;
    }
    .report-tx-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .report-tx-card {
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background: #ffffff;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .report-tx-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #f1f5f9;
      padding: 6px 12px;
      border-bottom: 1px solid #e2e8f0;
    }
    .tx-head-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tx-id-badge {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .tx-index { font-size: 10px; font-weight: 700; color: #64748b; }
    .tx-receipt-no { font-size: 12px; font-weight: 800; color: #0f172a; font-family: monospace, sans-serif; }
    .tx-date { font-size: 10px; color: #475569; }
    .tx-head-mid { display: flex; align-items: center; gap: 7px; }
    .tx-customer-name { font-size: 11.5px; font-weight: 700; color: #0f172a; }
    .tx-payment-tag {
      font-size: 9px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .tx-payment-tag.is-cash { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .tx-payment-tag.is-credit { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
    .tx-head-right { text-align: right; }
    .tx-total-label { font-size: 8.5px; color: #64748b; text-transform: uppercase; display: block; line-height: 1; }
    .tx-total-amount { font-size: 13px; font-weight: 800; color: #0066f5; line-height: 1.1; }
    .report-tx-items-wrap { padding: 3px 12px; }
    .report-items-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
    .report-items-table th {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #64748b;
      padding: 4px 6px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
    }
    .report-items-table td {
      padding: 4px 6px;
      border-bottom: 1px dashed #f1f5f9;
      color: #334155;
      font-size: 10.5px;
    }
    .report-items-table tr:last-child td { border-bottom: none; }
    .col-num { color: #94a3b8; font-weight: 600; }
    .item-name { color: #0f172a; font-weight: 600; }
    .report-tx-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #f8fafc;
      padding: 5px 12px;
      border-top: 1px solid #e2e8f0;
      font-size: 9.5px;
      color: #64748b;
    }
    .report-sale-return-note {
      padding: 5px 12px;
      border-top: 1px solid #e2e8f0;
      background: #fffbeb;
      color: #92400e;
      font-size: 9.5px;
      line-height: 1.35;
    }
    .report-return-ledger { margin-top: 14px; page-break-inside: avoid; break-inside: avoid; }
    .report-return-table-wrap { border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
    .report-return-table { font-size: 9.5px; }
    .report-return-table th {
      padding: 7px 10px;
      background: #f8fafc;
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #475569;
      border-bottom: 1.5px solid #cbd5e1;
    }
    .report-return-table td {
      padding: 7px 10px;
      border-bottom: 1px dashed #e2e8f0;
      font-size: 10px;
      vertical-align: middle;
    }
    .report-return-table td span { color: #64748b; font-size: 8.5px; }
    .report-request-tag {
      display: inline-block;
      margin-top: 2px;
      font-weight: 700;
      font-size: 8.5px;
      padding: 1.5px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .report-request-tag.is-refund {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
    .report-request-tag.is-replacement {
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
    }
    .report-request-tag.is-return-only {
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #cbd5e1;
    }
    .report-return-outcomes {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-top: 7px;
      color: #475569;
      font-size: 9.5px;
    }
    .report-return-outcomes strong { color: #0f172a; }
    .tx-foot-details strong { color: #334155; }
    .tx-discount-note { color: #dc2626; font-weight: 600; margin-right: 8px; }
    .tx-items-count { font-weight: 600; }
    .report-document-summary-block {
      margin-top: 22px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .report-document-footer {
      margin-top: 22px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .report-final-totals {
      background: #f8fafc;
      border: 1.5px solid #0f172a;
      border-radius: 8px;
      padding: 14px 22px;
      width: 100%;
      max-width: 100%;
      margin-left: 0;
      margin-bottom: 20px;
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.04);
      box-sizing: border-box;
    }
    .final-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 4.5px 0;
      font-size: 10.5px;
      color: #475569;
      white-space: nowrap;
    }
    .final-row span {
      font-weight: 600;
    }
    .final-row strong {
      font-weight: 700;
      white-space: nowrap;
    }
    .final-row.text-discount {
      color: #dc2626;
    }
    .final-row.final-grand-total {
      border-top: 1.5px solid #cbd5e1;
      margin-top: 6px;
      padding-top: 6px;
      font-size: 11.5px;
      font-weight: 700;
      color: #0f172a;
    }
    .final-row.net-sales-row {
      border-top: 1.5px solid #0f172a;
      margin-top: 6px;
      padding-top: 8px;
      font-size: 12.5px;
    }
    .grand-total-val {
      color: #0066f5;
      font-size: 15px;
      font-weight: 800;
      white-space: nowrap;
    }
    .report-sign-block {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 48px;
      margin-top: 20px;
      margin-bottom: 14px;
      padding: 4px 20px 0;
    }
    .sign-column { text-align: center; }
    .sign-line {
      border-bottom: 1px solid #94a3b8;
      height: 30px;
      margin-bottom: 6px;
    }
    .sign-title { font-size: 9.5px; font-weight: 700; color: #0f172a; display: block; line-height: 1.2; }
    .sign-sub { font-size: 8.5px; color: #94a3b8; line-height: 1.2; }
    .report-disclaimer { text-align: center; border-top: 1px solid #e2e8f0; padding-top: 8px; font-size: 8px; color: #94a3b8; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;
}

function openReportInNewPage_(htmlContent, title = 'Report') {
  const documentHtml = getReportDocumentHtml_(htmlContent, title);

  const reportId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const reportStorageKey = `ce-pos-report-${reportId}`;
  const maxReportAge = 7 * 24 * 60 * 60 * 1000;

  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith('ce-pos-report-'))
      .forEach((key) => {
        try {
          const saved = JSON.parse(localStorage.getItem(key));
          if (!saved?.createdAt || Date.now() - saved.createdAt > maxReportAge) localStorage.removeItem(key);
        } catch {
          localStorage.removeItem(key);
        }
      });
    localStorage.setItem(reportStorageKey, JSON.stringify({ createdAt: Date.now(), documentHtml }));
  } catch {
    showToast('Unable to prepare the report for a reloadable tab. Please check browser storage settings.', 'error');
    return;
  }

  const reportUrl = new URL('report.html', window.location.href);
  reportUrl.searchParams.set('report', reportId);
  const reportWindow = window.open(reportUrl.href, '_blank');
  if (!reportWindow) showToast('Please allow popups to open the report in a new tab.', 'error');
}

function renderReportPageFooter(pageNumber, totalPages, generatedTime, reportType = 'Sales Audit') {
  return `
    <footer class="report-page-footer">
      <div class="page-footer-left">
        <span>CAISHEN ENTERPRISES OPERATIONS &bull; ${escapeHtml(reportType)} Audit Report &bull; Generated ${escapeHtml(generatedTime)}</span>
      </div>
      <div class="page-footer-right">
        <strong class="page-number-indicator">Page ${pageNumber} of ${totalPages}</strong>
      </div>
    </footer>
  `;
}

function renderReportRunningHeader(branchName, periodText, reportTitle = 'Branch Sales, Returns & Inventory Ledger') {
  return `
    <header class="report-running-header">
      <div class="running-header-brand">
        <img src="assets/ce-logo.png" class="report-badge-img" width="26" height="26" style="width:26px;height:26px;max-width:26px;max-height:26px;object-fit:contain;flex-shrink:0;" alt="Caishen Enterprises" />
        <div>
          <span class="running-brand-title">CAISHEN ENTERPRISES &bull; ${escapeHtml(reportTitle)}</span>
          <span class="running-brand-sub">${escapeHtml(branchName)} &bull; ${escapeHtml(periodText)}</span>
        </div>
      </div>
      <div class="running-meta-tag">
        <span>Official Long Bond Sheet</span>
      </div>
    </header>
  `;
}

function buildSalesPdfReport_() {
  ensureSalesDateDefaults();
  updateSalesPrintPeriod();

  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const dateFrom = $('#salesDateFrom')?.value || '';
  const dateTo = $('#salesDateTo')?.value || '';
  const branch = branches.find((item) => item.id === activeBranchId) || { name: 'Main Branch' };

  const sales = salesHistory.filter((sale) => {
    const matchesTerm = `${sale.saleId} ${sale.customerName} ${sale.paymentType}`.toLowerCase().includes(term);
    const saleDate = saleDateKey(sale.date);
    return matchesTerm && (!dateFrom || saleDate >= dateFrom) && (!dateTo || saleDate <= dateTo);
  });
  const eventInPeriod = (value) => {
    const eventDate = saleDateKey(value);
    return eventDate && (!dateFrom || eventDate >= dateFrom) && (!dateTo || eventDate <= dateTo);
  };
  const returnMatchesTerm = (record) => {
    const sale = salesHistory.find((item) => item.saleId === record.saleId);
    const actions = saleReturnItems.filter((item) => item.returnId === record.id).map((item) => item.actionType).join(' ');
    return !term || `${record.id} ${record.saleId} ${sale?.customerName || ''} ${actions} ${record.reason}`.toLowerCase().includes(term);
  };
  const returnsInPeriod = saleReturns.filter((record) => {
    return returnMatchesTerm(record) && eventInPeriod(record.createdAt);
  });
  const completedRefunds = saleReturns.filter((record) => saleReturnItems.some((item) => item.returnId === record.id && item.actionType === 'refund') && record.refundResolvedAt && returnMatchesTerm(record) && eventInPeriod(record.refundResolvedAt));
  const releasedReplacements = saleReturns.filter((record) => saleReturnItems.some((item) => item.returnId === record.id && item.actionType === 'replacement') && record.replacementReleasedAt && returnMatchesTerm(record) && eventInPeriod(record.replacementReleasedAt));
  const returnItemsInPeriod = returnsInPeriod.flatMap((record) => saleReturnItems.filter((item) => item.returnId === record.id));

  const totalSales = sales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalItemsCount = sales.reduce((sum, s) => sum + (s.items || []).reduce((iSum, i) => iSum + Number(i.qty || 1), 0), 0);
  const cashSales = sales.filter((s) => s.paymentType === 'cash');
  const creditSales = sales.filter((s) => s.paymentType === 'credit');
  const totalCash = cashSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalCredit = creditSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalDiscounts = sales.reduce((sum, s) => sum + Number(s.discount || 0), 0);
  const totalRefunds = completedRefunds.reduce((sum, record) => sum + Number(record.refundAmount || 0), 0);
  const cashRefunds = completedRefunds.filter((record) => salesHistory.find((sale) => sale.saleId === record.saleId)?.paymentType === 'cash').reduce((sum, record) => sum + Number(record.refundAmount || 0), 0);
  const creditRefunds = totalRefunds - cashRefunds;
  const netCashCollected = totalCash - cashRefunds;
  const expensesInPeriod = dailyExpenses.filter((e) => {
    if (!e.businessDate) return false;
    if (dateFrom && e.businessDate < dateFrom) return false;
    if (dateTo && e.businessDate > dateTo) return false;
    return true;
  });
  const totalExpenses = expensesInPeriod.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const totalSpotCash = dailySpotCash
    .filter((item) => {
      if (!item.businessDate) return false;
      if (dateFrom && item.businessDate < dateFrom) return false;
      if (dateTo && item.businessDate > dateTo) return false;
      return true;
    })
    .reduce((sum, item) => sum + Number(item.openingCash || 0), 0);
  const totalCashOnHand = netCashCollected + totalSpotCash - totalExpenses;
  const netSales = Math.max(totalSales - totalRefunds - totalExpenses, 0);
  const netIncome = netSales * 0.20;
  const returnedUnits = returnItemsInPeriod.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const replacementUnits = releasedReplacements.flatMap((record) => saleReturnItems.filter((item) => item.returnId === record.id)).reduce((sum, item) => sum + Number(item.replacementQty || 0), 0);
  const returnOutcomes = returnItemsInPeriod.reduce((totals, item) => {
    totals[item.condition] = (totals[item.condition] || 0) + Number(item.qty || 0);
    return totals;
  }, { quarantine: 0, restocked: 0, supplier_return: 0, disposed: 0 });

  const formatDate = (value) => value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'All dates';
  const periodText = (dateFrom || dateTo)
    ? `${formatDate(dateFrom)} to ${formatDate(dateTo)}`
    : 'All Recorded Dates';
  const generatedTime = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

  // Long Bond Paper (8.5in x 13in) pagination calculation
  const summaryBlockHeight = (returnsInPeriod.length ? (110 + returnItemsInPeriod.length * 32) : 55) + 265;
  const salesPages = [];
  let currentSaleIdx = 0;
  let isFirst = true;

  while (currentSaleIdx < sales.length || salesPages.length === 0) {
    const pageCapacity = isFirst ? 760 : 980;
    let usedHeight = 0;
    const chunk = [];

    while (currentSaleIdx < sales.length) {
      const sale = sales[currentSaleIdx];
      const items = sale.items || [];
      const linked = saleReturns.filter((r) => r.saleId === sale.saleId);
      const estCardHeight = 92 + items.length * 24 + (linked.length ? 26 : 0) + 10;

      if (chunk.length > 0 && (usedHeight + estCardHeight > pageCapacity)) {
        break;
      }
      chunk.push({ sale, globalIndex: currentSaleIdx + 1 });
      usedHeight += estCardHeight;
      currentSaleIdx++;
    }

    const isLastSales = currentSaleIdx >= sales.length;
    let hasSummary = false;

    if (isLastSales) {
      if (pageCapacity - usedHeight >= summaryBlockHeight) {
        hasSummary = true;
      }
    }

    salesPages.push({
      isFirstPage: isFirst,
      salesChunk: chunk,
      hasSummary
    });

    isFirst = false;

    if (isLastSales && !hasSummary) {
      salesPages.push({
        isFirstPage: false,
        salesChunk: [],
        hasSummary: true
      });
      break;
    }
  }

  const totalPages = salesPages.length;

  const renderedPagesHtml = salesPages.map((pageData, pageIndex) => {
    const pageNum = pageIndex + 1;
    let pageContentHtml = '';

    if (pageData.isFirstPage) {
      pageContentHtml += `
        <!-- Main Report Header -->
        <header class="report-header">
          <div class="report-brand-wrap">
            <div class="report-logo">
              <img src="assets/ce-logo.png" class="report-badge-img" width="42" height="42" style="width:42px;height:42px;max-width:42px;max-height:42px;object-fit:contain;flex-shrink:0;" alt="Caishen Enterprises" />
            </div>
            <div>
              <span class="report-eyebrow">CAISHEN ENTERPRISES OPERATIONS</span>
              <h1 class="report-title">Branch Sales, Returns & Inventory Ledger</h1>
              <p class="report-subtitle">Official sales, refund, replacement, and returned-stock audit report</p>
            </div>
          </div>

          <div class="report-meta-box">
            <div class="report-meta-row">
              <span class="meta-label">Branch:</span>
              <strong class="meta-val">${escapeHtml(branch.name || 'Main Branch')}</strong>
            </div>
            <div class="report-meta-row">
              <span class="meta-label">Period:</span>
              <strong class="meta-val">${escapeHtml(periodText)}</strong>
            </div>
            <div class="report-meta-row">
              <span class="meta-label">Generated:</span>
              <span class="meta-val">${escapeHtml(generatedTime)}</span>
            </div>
          </div>
        </header>

        <!-- KPI Metrics Strip -->
        <section class="report-kpi-grid">
          <div class="report-kpi-card">
            <span class="kpi-label">Gross Revenue</span>
            <strong class="kpi-val">${money(totalSales)}</strong>
            <span class="kpi-sub">${sales.length} transactions</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Net Cash Collected</span>
            <strong class="kpi-val text-success">${money(netCashCollected)}</strong>
            <span class="kpi-sub">${cashSales.length} cash sale${cashSales.length === 1 ? '' : 's'} less ${money(cashRefunds)} refunds</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Credit Charged</span>
            <strong class="kpi-val text-amber">${money(totalCredit)}</strong>
            <span class="kpi-sub">${creditSales.length} on credit · ${money(creditRefunds)} adjusted</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Total Units Sold</span>
            <strong class="kpi-val">${totalItemsCount}</strong>
            <span class="kpi-sub">Items dispensed</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Refunds Completed</span>
            <strong class="kpi-val text-discount">-${money(totalRefunds)}</strong>
            <span class="kpi-sub">${completedRefunds.length} completed refund${completedRefunds.length === 1 ? '' : 's'}</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Spot Cash</span>
            <strong class="kpi-val text-success">${money(totalSpotCash)}</strong>
            <span class="kpi-sub">Recorded opening cash</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Returned Units</span>
            <strong class="kpi-val text-amber">${returnedUnits.toLocaleString('en-PH')}</strong>
            <span class="kpi-sub">${returnsInPeriod.length} return case${returnsInPeriod.length === 1 ? '' : 's'} received</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Replacement Units</span>
            <strong class="kpi-val">${replacementUnits.toLocaleString('en-PH')}</strong>
            <span class="kpi-sub">${releasedReplacements.length} replacement release${releasedReplacements.length === 1 ? '' : 's'}</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Cash on Hand</span>
            <strong class="kpi-val text-cyan">${money(totalCashOnHand)}</strong>
            <span class="kpi-sub">Net cash collected + spot cash - expenses</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Operating Expenses</span>
            <strong class="kpi-val text-discount">-${money(totalExpenses)}</strong>
            <span class="kpi-sub">${expensesInPeriod.length} recorded expense${expensesInPeriod.length === 1 ? '' : 's'}</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Net Income</span>
            <strong class="kpi-val text-success">${money(netIncome)}</strong>
            <span class="kpi-sub">20% of net sales</span>
          </div>
          <div class="report-kpi-card">
            <span class="kpi-label">Discounts Granted</span>
            <strong class="kpi-val text-discount">-${money(totalDiscounts)}</strong>
            <span class="kpi-sub">Total price markdowns</span>
          </div>
        </section>
      `;
    } else {
      pageContentHtml += renderReportRunningHeader(branch.name || 'Main Branch', periodText, 'Branch Sales, Returns & Inventory Ledger');
    }

    if (pageData.salesChunk.length > 0 || (pageData.isFirstPage && sales.length === 0)) {
      pageContentHtml += `
        <section class="report-ledger-body">
          <div class="report-section-title-wrap">
            <h2 class="report-section-title">${pageData.isFirstPage ? 'Itemized Transaction Records' : 'Itemized Transaction Records (Continued)'}</h2>
            <span class="report-count-badge">${pageData.salesChunk.length > 0 ? `Showing ${pageData.salesChunk[0].globalIndex}–${pageData.salesChunk[pageData.salesChunk.length - 1].globalIndex} of ${sales.length}` : '0 Orders'}</span>
          </div>

          ${sales.length === 0 ? `
            <div class="report-empty-state">
              <p>No sales records found for the selected period.</p>
            </div>
          ` : `
            <div class="report-tx-list">
              ${pageData.salesChunk.map(({ sale, globalIndex }) => {
                const items = sale.items || [];
                const isCash = sale.paymentType === 'cash';
                const saleDateFormatted = sale.date
                  ? new Date(sale.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
                  : 'N/A';
                const customerDisplay = displayCustomerName(sale.customerName || 'Walk-in customer');
                const linkedReturns = saleReturns.filter((record) => record.saleId === sale.saleId);

                return `
                  <article class="report-tx-card">
                    <header class="report-tx-head">
                      <div class="tx-head-left">
                        <div class="tx-id-badge">
                          <span class="tx-index">#${globalIndex}</span>
                          <strong class="tx-receipt-no">${escapeHtml(sale.saleId)}</strong>
                        </div>
                        <span class="tx-date">${escapeHtml(saleDateFormatted)}</span>
                      </div>

                      <div class="tx-head-mid">
                        <strong class="tx-customer-name">${escapeHtml(customerDisplay)}</strong>
                        <span class="tx-payment-tag ${isCash ? 'is-cash' : 'is-credit'}">
                          ${isCash ? 'PAID CASH' : 'CREDIT CHARGED'}
                        </span>
                      </div>

                      <div class="tx-head-right">
                        <span class="tx-total-label">Total</span>
                        <strong class="tx-total-amount">${money(sale.total)}</strong>
                      </div>
                    </header>

                    <div class="report-tx-items-wrap">
                      <table class="report-items-table">
                        <thead>
                          <tr>
                            <th style="width: 40px;">#</th>
                            <th>Purchased Item Description</th>
                            <th style="width: 80px; text-align: center;">Qty</th>
                            <th style="width: 110px; text-align: right;">Unit Price</th>
                            <th style="width: 120px; text-align: right;">Line Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${items.length === 0 ? `
                            <tr>
                              <td colspan="5" style="text-align: center; color: #64748b; padding: 8px;">No line items detailed</td>
                            </tr>
                          ` : items.map((it, itIdx) => {
                            const itemQty = Number(it.qty || 1);
                            const itemPrice = Number(it.price || 0);
                            const lineTotal = itemQty * itemPrice;
                            return `
                              <tr>
                                <td class="col-num">${itIdx + 1}</td>
                                <td class="col-name">
                                  <strong class="item-name">${escapeHtml(it.name || 'Unknown item')}</strong>
                                </td>
                                <td class="col-qty" style="text-align: center;">${itemQty} ${escapeHtml(it.unit || 'pcs')}</td>
                                <td class="col-price" style="text-align: right;">${money(itemPrice)}</td>
                                <td class="col-total" style="text-align: right;"><strong>${money(lineTotal)}</strong></td>
                              </tr>
                            `;
                          }).join('')}
                        </tbody>
                      </table>
                    </div>

                    <footer class="report-tx-foot">
                      <div class="tx-foot-details">
                        ${isCash && Number(sale.cashTendered) > 0 ? `
                          <span>Cash Tendered: <strong>${money(sale.cashTendered)}</strong> &bull; Change Given: <strong>${money(sale.change || 0)}</strong></span>
                        ` : !isCash ? `
                          <span>Customer Balance Remaining: <strong>${money(sale.creditBalance || 0)}</strong></span>
                        ` : ''}
                      </div>
                      <div class="tx-foot-summary">
                        ${Number(sale.discount) > 0 ? `
                          <span class="tx-discount-note">Discount: -${money(sale.discount)}</span>
                        ` : ''}
                        <span class="tx-items-count">${items.length} item${items.length === 1 ? '' : 's'} (${items.reduce((acc, i) => acc + Number(i.qty || 1), 0)} units)</span>
                      </div>
                    </footer>
                    ${linkedReturns.length ? `<div class="report-sale-return-note">${linkedReturns.map((record) => `${escapeHtml(record.id)}: ${escapeHtml(record.type === 'refund' ? `Refund ${money(record.refundAmount)}` : 'Replacement')} · ${escapeHtml(record.status)}`).join(' &bull; ')}</div>` : ''}
                  </article>
                `;
              }).join('')}
            </div>
          `}
        </section>
      `;
    }

    if (pageData.hasSummary) {
      pageContentHtml += `
        <section class="report-ledger-body report-return-ledger">
          <div class="report-section-title-wrap">
            <h2 class="report-section-title">Return & Replacement Activity</h2>
            <span class="report-count-badge">${returnItemsInPeriod.length} returned item${returnItemsInPeriod.length === 1 ? '' : 's'}</span>
          </div>
          ${returnsInPeriod.length === 0 ? `<div class="report-empty-state"><p>No return activity recorded for the selected period.</p></div>` : `
            <div class="report-return-table-wrap"><table class="report-items-table report-return-table"><thead><tr><th style="width: 110px;">Return</th><th style="width: 140px;">SALES #</th><th style="width: 170px;">CUSTOMER</th><th>Returned Item</th><th style="width: 140px; text-align: right;">Financial Outcome</th></tr></thead><tbody>
              ${returnsInPeriod.flatMap((record) => {
                const originalSale = salesHistory.find((sale) => sale.saleId === record.saleId);
                const lines = saleReturnItems.filter((item) => item.returnId === record.id);
                return lines.map((line) => {
                  const product = allProducts.find((item) => item.id === line.productId);
                  const request = ({ refund: 'Refund', replacement: 'Replace', return: 'Return Only' }[line.actionType] || 'Return Only');
                  const requestClass = line.actionType === 'refund' ? 'is-refund' : line.actionType === 'replacement' ? 'is-replacement' : 'is-return-only';
                  const financial = line.actionType === 'refund'
                    ? (record.refundResolvedAt ? `Refunded ${money(line.refundAmount)}` : `Refund pending ${money(line.refundAmount)}`)
                    : line.actionType === 'replacement'
                      ? (record.replacementReleasedAt ? 'Replacement released' : 'Replacement pending')
                      : 'No financial action';
                  const conditionWords = String(line.condition || 'quarantine')
                    .replace(/_/g, ' ')
                    .split(' ')
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                    .join(' ');
                  const inventoryOutcome = `${conditionWords}: ${Number(line.qty || 0).toLocaleString('en-PH')}`;
                  return `
                    <tr>
                      <td>
                        <strong style="color: #0f172a;">${escapeHtml(record.id)}</strong><br>
                        <span style="color: #64748b; font-size: 8.5px;">${escapeHtml(record.createdAt ? new Date(record.createdAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '')}</span>
                      </td>
                      <td>
                        <strong style="font-family: monospace, sans-serif; font-size: 11px; color: #0f172a;">${escapeHtml(record.saleId)}</strong><br>
                        <span class="report-request-tag ${requestClass}">${escapeHtml(request)}</span>
                      </td>
                      <td>
                        <strong style="color: #0f172a; font-size: 10.5px;">${escapeHtml(displayCustomerName(originalSale?.customerName || 'Walk-in customer'))}</strong><br>
                        <span style="display: inline-block; margin-top: 2px; font-size: 9px; color: #475569; font-weight: 600;">${escapeHtml(inventoryOutcome)}</span>
                      </td>
                      <td>
                        <strong class="item-name">${escapeHtml(product?.name || line.productId)}</strong><br>
                        <span style="color: #64748b; font-size: 8.5px;">${Number(line.qty || 0).toLocaleString('en-PH')} ${escapeHtml(product?.unit || 'unit')}</span>
                      </td>
                      <td style="text-align: right;">
                        <strong style="color: ${line.actionType === 'refund' ? '#dc2626' : '#059669'}; font-size: 10.5px;">${escapeHtml(financial)}</strong>
                      </td>
                    </tr>
                  `;
                });
              }).join('')}
            </tbody></table></div>
          `}
          <div class="report-return-outcomes"><span>Quarantine: <strong>${Number(returnOutcomes.quarantine || 0).toLocaleString('en-PH')}</strong></span><span>Restocked: <strong>${Number(returnOutcomes.restocked || 0).toLocaleString('en-PH')}</strong></span><span>Supplier Return: <strong>${Number(returnOutcomes.supplier_return || 0).toLocaleString('en-PH')}</strong></span><span>Disposed: <strong>${Number(returnOutcomes.disposed || 0).toLocaleString('en-PH')}</strong></span></div>
        </section>

        <!-- Grand Totals Box & Sign-off Block -->
        <div class="report-document-summary-block">
          <div class="report-final-totals">
            <div class="final-row">
              <span>Sales Before Discounts:</span>
              <strong>${money(totalSales + totalDiscounts)}</strong>
            </div>
            ${totalDiscounts > 0 ? `
              <div class="final-row text-discount">
                <span>Total Discounts Granted:</span>
                <strong>-${money(totalDiscounts)}</strong>
              </div>
            ` : ''}
            <div class="final-row final-grand-total">
              <span>Gross Sales After Discounts:</span>
              <strong>${money(totalSales)}</strong>
            </div>
            <div class="final-row text-discount">
              <span>Less: Completed Refunds:</span>
              <strong>-${money(totalRefunds)}</strong>
            </div>
            ${totalExpenses > 0 ? `
              <div class="final-row text-discount">
                <span>Less: Operating Expenses:</span>
                <strong>-${money(totalExpenses)}</strong>
              </div>
            ` : ''}
            <div class="final-row final-grand-total net-sales-row">
              <span>Net Sales:</span>
              <strong class="grand-total-val">${money(netSales)}</strong>
            </div>
            <div class="final-row final-grand-total net-income-row">
              <span>Net Income:</span>
              <strong class="grand-total-val">${money(netIncome)}</strong>
            </div>
          </div>

          <div class="report-sign-block">
            <div class="sign-column">
              <div class="sign-line"></div>
              <span class="sign-title">Prepared By (Cashier / Staff)</span>
              <span class="sign-sub">Signature over printed name</span>
            </div>
            <div class="sign-column">
              <div class="sign-line"></div>
              <span class="sign-title">Audited & Verified By</span>
              <span class="sign-sub">Branch Manager / Operations</span>
            </div>
          </div>

          <div class="report-disclaimer">
            <p>CAISHEN ENTERPRISES SYSTEM-GENERATED SALES AUDIT REPORT &bull; CONFIDENTIAL &bull; ALL RIGHTS RESERVED</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="report-page">
        <div class="report-page-content">
          ${pageContentHtml}
        </div>
        ${renderReportPageFooter(pageNum, totalPages, generatedTime, 'Sales Audit')}
      </div>
    `;
  }).join('');

  return {
    renderedPagesHtml,
    periodText,
    dateFrom,
    dateTo,
    branch
  };
}

function generateSalesPdf() {
  const { renderedPagesHtml, periodText } = buildSalesPdfReport_();
  const printDoc = $('#salesPrintDocument');
  if (printDoc) printDoc.innerHTML = renderedPagesHtml;
  openReportInNewPage_(renderedPagesHtml, `Branch Sales Report - ${periodText}`);
}

function loadHtml2PdfLibrary_() {
  if (window.html2pdf) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Unable to load PDF export library.'));
    document.head.appendChild(script);
  });
}

async function exportSalesPdf() {
  const exportBtn = $('#exportSalesPdfButton');
  const originalHtml = exportBtn ? exportBtn.innerHTML : '';
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span class="btn-spinner"></span><span>Exporting PDF...</span>';
  }

  try {
    const { renderedPagesHtml, periodText, dateFrom, dateTo } = buildSalesPdfReport_();
    await loadHtml2PdfLibrary_();

    const filenamePeriod = `${dateFrom || 'all'}_to_${dateTo || 'all'}`.replace(/[^a-z0-9_-]/gi, '-');
    const filename = `branch-sales-report_${filenamePeriod}.pdf`;
    const fullHtml = getReportDocumentHtml_(renderedPagesHtml, `Branch Sales Report - ${periodText}`, true);

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '0';
    iframe.style.top = '0';
    iframe.style.width = '816px';
    iframe.style.height = '1248px';
    iframe.style.border = 'none';
    iframe.style.opacity = '0.01';
    iframe.style.zIndex = '-9999';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(fullHtml);
    doc.close();

    try {
      // Wait for the report's actual layout before rasterizing it into the PDF.
      await Promise.all([
        doc.fonts?.ready || Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 450))
      ]);

      const html2canvasLib = window.html2canvas || (await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        s.onload = () => res(window.html2canvas);
        s.onerror = () => rej(new Error('Failed to load html2canvas'));
        document.head.appendChild(s);
      }));

      const JsPdf = window.jspdf?.jsPDF || window.jsPDF;
      const pdf = new JsPdf({
        unit: 'in',
        format: [8.5, 13],
        orientation: 'portrait',
        compress: true
      });

      const pages = Array.from(doc.querySelectorAll('.report-page'));
      if (!pages.length) throw new Error('The sales report has no content to export.');

      for (let i = 0; i < pages.length; i++) {
        if (i > 0) pdf.addPage([8.5, 13], 'portrait');

        const canvas = await html2canvasLib(pages[i], {
          scale: 2,
          useCORS: true,
          logging: false,
          width: 816,
          height: 1248,
          windowWidth: 816,
          windowHeight: 1248,
          backgroundColor: '#ffffff'
        });

        const imgData = canvas.toDataURL('image/jpeg', 0.98);
        pdf.addImage(imgData, 'JPEG', 0, 0, 8.5, 13, undefined, 'FAST');
      }

      pdf.save(filename);
      showToast('Sales Audit Report PDF downloaded.', 'success');
    } finally {
      iframe.remove();
    }
  } catch (error) {
    showToast(error.message || 'Failed to download PDF export.', 'error');
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.innerHTML = originalHtml;
    }
  }
}

function generateInventoryReportPdf() {
  const printDoc = $('#salesPrintDocument');
  if (!printDoc) return;

  const branch = branches.find((item) => item.id === activeBranchId) || { name: 'Main Branch' };
  const rows = getInventoryReportRows();
  const generatedTime = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

  // Long Bond Paper (8.5in x 13in) pagination for Inventory rows
  const invSignoffHeight = 150;
  const inventoryPages = [];
  let currentRowIdx = 0;
  let isFirstInvPage = true;

  while (currentRowIdx < rows.length || inventoryPages.length === 0) {
    const pageCapacity = isFirstInvPage ? 820 : 980;
    let usedHeight = 0;
    const chunk = [];

    while (currentRowIdx < rows.length) {
      const rowHeight = 32;
      if (chunk.length > 0 && (usedHeight + rowHeight > pageCapacity)) {
        break;
      }
      chunk.push(rows[currentRowIdx]);
      usedHeight += rowHeight;
      currentRowIdx++;
    }

    const isLastRows = currentRowIdx >= rows.length;
    let hasSignoff = false;
    if (isLastRows) {
      if (pageCapacity - usedHeight >= invSignoffHeight) {
        hasSignoff = true;
      }
    }

    inventoryPages.push({
      isFirstPage: isFirstInvPage,
      rowsChunk: chunk,
      hasSignoff
    });

    isFirstInvPage = false;

    if (isLastRows && !hasSignoff) {
      inventoryPages.push({
        isFirstPage: false,
        rowsChunk: [],
        hasSignoff: true
      });
      break;
    }
  }

  const totalPages = inventoryPages.length;

  const renderedInventoryHtml = inventoryPages.map((pageData, pageIndex) => {
    const pageNum = pageIndex + 1;
    let pageContentHtml = '';

    if (pageData.isFirstPage) {
      pageContentHtml += `
        <header class="report-header">
          <div class="report-brand-wrap">
            <img src="assets/ce-logo.png" class="report-badge-img" width="42" height="42" style="width:42px;height:42px;max-width:42px;max-height:42px;object-fit:contain;flex-shrink:0;" alt="Caishen Enterprises" />
            <div>
              <span class="report-eyebrow">CAISHEN ENTERPRISES OPERATIONS</span>
              <h1 class="report-title">Branch Inventory Report</h1>
              <p class="report-subtitle">Stock movement and remaining inventory by product</p>
            </div>
          </div>
          <div class="report-meta-box">
            <div class="report-meta-row"><span class="meta-label">Branch:</span><strong class="meta-val">${escapeHtml(branch.name || 'Main Branch')}</strong></div>
            <div class="report-meta-row"><span class="meta-label">Scope:</span><strong class="meta-val">Active Branch Inventory</strong></div>
            <div class="report-meta-row"><span class="meta-label">Generated:</span><span class="meta-val">${escapeHtml(generatedTime)}</span></div>
          </div>
        </header>
      `;
    } else {
      pageContentHtml += renderReportRunningHeader(branch.name || 'Main Branch', 'Active Branch Inventory', 'Branch Inventory Report');
    }

    if (pageData.rowsChunk.length > 0 || (pageData.isFirstPage && rows.length === 0)) {
      pageContentHtml += `
        <section class="report-ledger-body">
          <div class="report-section-title-wrap">
            <h2 class="report-section-title">${pageData.isFirstPage ? 'Inventory Movement by Product' : 'Inventory Movement by Product (Continued)'}</h2>
            <span class="report-count-badge">${pageData.rowsChunk.length > 0 ? `Showing ${pageData.rowsChunk.length} of ${rows.length} Products` : '0 Products'}</span>
          </div>
          <div class="report-tx-card">
            <div class="report-tx-items-wrap">
              <table class="report-items-table inventory-report-table">
                <thead><tr><th>Product</th><th style="text-align:center;">Qty Sold</th><th style="text-align:center;">Qty Stock In</th><th style="text-align:center;">Qty Transfer</th><th style="text-align:center;">Qty Remaining</th><th style="text-align:right;">Status</th></tr></thead>
                <tbody>
                  ${pageData.rowsChunk.map((product) => {
                    const qty = Math.max(Number(product.qty) || 0, 0);
                    const status = getInventoryReportStatus(product);
                    const movement = getInventoryReportMovement(product.id);
                    return `<tr><td class="col-name"><strong class="item-name">${escapeHtml(product.name)}</strong><br><span>${escapeHtml(product.sku || product.id)} &bull; ${escapeHtml(product.unit || 'unit')}</span></td><td style="text-align:center;">${(Number(movement.qtySold) || 0).toLocaleString('en-PH')}</td><td style="text-align:center;">${(Number(movement.qtyStockIn) || 0).toLocaleString('en-PH')}</td><td style="text-align:center;">${formatTransferQuantity(movement)}</td><td style="text-align:center;"><strong>${qty.toLocaleString('en-PH')}</strong></td><td style="text-align:right;">${escapeHtml(status.label)}</td></tr>`;
                  }).join('') || '<tr><td colspan="6" style="text-align:center; padding:12px;">No inventory records found.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `;
    }

    if (pageData.hasSignoff) {
      pageContentHtml += `
        <footer class="report-document-footer">
          <div class="report-sign-block"><div class="sign-column"><div class="sign-line"></div><span class="sign-title">Prepared By (Cashier / Staff)</span><span class="sign-sub">Signature over printed name</span></div><div class="sign-column"><div class="sign-line"></div><span class="sign-title">Audited & Verified By</span><span class="sign-sub">Branch Manager / Operations</span></div></div>
          <div class="report-disclaimer"><p>CAISHEN ENTERPRISES SYSTEM-GENERATED INVENTORY REPORT &bull; CONFIDENTIAL &bull; ALL RIGHTS RESERVED</p></div>
        </footer>
      `;
    }

    return `
      <div class="report-page inventory-print-page">
        <div class="report-page-content">
          ${pageContentHtml}
        </div>
        ${renderReportPageFooter(pageNum, totalPages, generatedTime, 'Inventory')}
      </div>
    `;
  }).join('');

  printDoc.innerHTML = renderedInventoryHtml;
  openReportInNewPage_(printDoc ? printDoc.innerHTML : '', `Inventory Report - ${branch.name || 'Main Branch'}`);
}

function askConfirmation({
  title = 'Confirm Action',
  eyebrow = 'CONFIRM ACTION',
  subtitle = 'Please review before continuing',
  message = 'Are you sure you want to proceed?',
  warning = '',
  confirmText = 'Confirm',
  confirmType = 'primary',
  icon = null,
}) {
  return new Promise((resolve) => {
    pendingActionConfirmResolver = resolve;

    const dialog = $('#actionConfirmDialog');
    const titleEl = $('#actionConfirmTitle');
    const eyebrowEl = $('#actionConfirmEyebrow');
    const subtitleEl = $('#actionConfirmSubtitle');
    const textEl = $('#actionConfirmText');
    const warningBox = $('#actionConfirmWarningBox');
    const warningText = $('#actionConfirmWarning');
    const submitBtn = $('#actionConfirmSubmitBtn');
    const submitText = $('#actionConfirmSubmitText');
    const iconBadge = $('#actionConfirmIcon');

    if (titleEl) titleEl.textContent = title;
    if (eyebrowEl) {
      eyebrowEl.textContent = eyebrow;
      eyebrowEl.className = `modal-eyebrow confirm-eyebrow ${confirmType === 'primary' ? 'primary-theme' : confirmType === 'success' ? 'success-theme' : ''}`;
    }
    if (subtitleEl) subtitleEl.textContent = subtitle;
    if (textEl) textEl.innerHTML = message;

    if (warningBox && warningText) {
      if (warning) {
        warningText.textContent = warning;
        warningBox.hidden = false;
        warningBox.className = `confirm-warning-box ${confirmType === 'primary' ? 'info-theme' : confirmType === 'success' ? 'success-theme' : ''}`;
      } else {
        warningBox.hidden = true;
      }
    }

    if (submitText) submitText.textContent = confirmText;
    if (submitBtn) {
      submitBtn.className = `button ${
        confirmType === 'danger'
          ? 'modal-delete-btn'
          : confirmType === 'success'
          ? 'modal-success-btn'
          : 'modal-save-btn'
      }`;
    }

    if (iconBadge) {
      iconBadge.className = `modal-icon-badge ${
        confirmType === 'danger'
          ? 'confirm-danger-badge'
          : confirmType === 'success'
          ? 'confirm-success-badge'
          : 'confirm-primary-badge'
      }`;

      if (icon) {
        iconBadge.innerHTML = icon;
      } else if (confirmType === 'danger') {
        iconBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      } else if (confirmType === 'success') {
        iconBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      } else {
        iconBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
      }
    }

    if (dialog) dialog.showModal();
  });
}


/* ==========================================================================
   API CLIENT
   ========================================================================== */
function requireSupabase_() {
  if (!supabaseClient) throw new Error('Supabase configuration is unavailable. Refresh the page and try again.');
  return supabaseClient;
}

function throwIfError_(error) {
  if (error) throw new Error(error.message || 'Supabase request failed.');
}

async function throwIfFunctionError_(error) {
  if (!error) return;
  let message = error.message || 'Supabase function failed.';
  const response = error.context;
  if (response && typeof response.clone === 'function') {
    try {
      const payload = await response.clone().json();
      if (payload?.error) message = payload.error;
    } catch {
      try {
        const detail = await response.clone().text();
        if (detail) message = detail;
      } catch { /* Keep the original function error. */ }
    }
  }
  throw new Error(message);
}

function newPosId_(prefix) {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function newSku_() {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `SKU-${stamp}-${crypto.randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
}

function profileToAccount_(profile, token) {
  return {
    token,
    account: {
      id: profile.user_id,
      fullName: profile.full_name,
      username: profile.username,
      role: profile.role,
      branchId: profile.branch_id || '',
      permissions: profile.role === 'admin' ? ['*'] : (profile.permissions || []),
      mustChangePassword: Boolean(profile.must_change_password),
    },
  };
}

async function loadSupabaseSession_() {
  const client = requireSupabase_();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  throwIfError_(sessionError);
  if (!session) throw new Error('Your session has expired.');

  let { data: profile, error: profileError } = await client
    .from('profiles')
    .select('*')
    .eq('user_id', session.user.id)
    .maybeSingle();
  throwIfError_(profileError);

  if (!profile) {
    const pending = JSON.parse(localStorage.getItem(INITIAL_ADMIN_KEY) || 'null');
    if (!pending) throw new Error('This email has not been assigned to a POS account.');
    const { data, error } = await client.rpc('claim_initial_admin', {
      full_name_input: pending.fullName,
      username_input: pending.username,
    });
    throwIfError_(error);
    profile = Array.isArray(data) ? data[0] : data;
    localStorage.removeItem(INITIAL_ADMIN_KEY);
    localStorage.removeItem(INITIAL_ADMIN_REGISTERED_KEY);
  }
  if (!profile || profile.status !== 'Active') {
    await client.auth.signOut();
    throw new Error('This account has been deactivated. Contact an administrator for access.');
  }
  await client.rpc('record_login');
  return profileToAccount_(profile, session.access_token);
}

async function getAppData_(branchId) {
  const client = requireSupabase_();
  const results = await Promise.all([
    client.from('branches').select('*').order('name'),
    client.from('products').select('*'),
    client.from('branch_products').select('*').eq('branch_id', branchId),
    client.from('inventory').select('*').eq('branch_id', branchId),
    client.from('customers').select('*').eq('branch_id', branchId),
    client.from('stock_transfers').select('*').or(`source_branch_id.eq.${branchId},destination_branch_id.eq.${branchId}`),
    client.from('sales').select('*').eq('branch_id', branchId),
    client.from('sale_items').select('*'),
    client.from('credit_payments').select('*').eq('branch_id', branchId),
    client.from('customer_credit_accounts').select('*').eq('branch_id', branchId),
    client.from('stock_ins').select('*').eq('branch_id', branchId),
    client.rpc('get_branch_selling_price_batches', { target_branch_id: branchId }),
    client.from('product_bundle_components').select('*'),
    client.rpc('get_branch_bundle_availability', { target_branch_id: branchId }),
    client.from('sale_returns').select('*').eq('branch_id', branchId),
    client.from('sale_return_items').select('*'),
    client.from('inventory_return_lots').select('*').eq('branch_id', branchId),
    client.from('inventory_quarantine_cases').select('*').eq('branch_id', branchId),
    client.from('inventory_quarantine_items').select('*'),
    client.from('daily_spot_cash').select('*').eq('branch_id', branchId).is('deleted_at', null).order('business_date', { ascending: false }),
    client.from('daily_expenses').select('*').eq('branch_id', branchId).is('deleted_at', null).order('business_date', { ascending: false }),
  ]);
  results.forEach((result) => throwIfError_(result.error));
  const [branchRows, productRows, branchProductRows, inventoryRows, customerRows, transferRows, saleRows, saleItemRows, paymentRows, openingCreditRows, stockInRows, sellingPriceBatchRows, bundleComponentRows, bundleAvailabilityRows, saleReturnRows, saleReturnItemRows, returnLotRows, quarantineCaseRows, quarantineItemRows, dailySpotCashRows, dailyExpenseRows] = results.map((result) => result.data || []);
  const branchMap = Object.fromEntries(branchRows.map((row) => [row.branch_id, row]));
  const productMap = Object.fromEntries(productRows.map((row) => [row.product_id, row]));
  const customerMap = Object.fromEntries(customerRows.map((row) => [row.customer_id, row]));
  const branchProducts = Object.fromEntries(branchProductRows.map((row) => [row.product_id, row]));
  const quantities = Object.fromEntries(inventoryRows.map((row) => [row.product_id, Number(row.qty || 0)]));
  const bundleComponentsByProduct = bundleComponentRows.reduce((groups, row) => {
    (groups[row.bundle_product_id] ||= []).push({ productId: row.component_product_id, qty: Number(row.qty || 0), inventoryRole: row.inventory_role || 'standard' });
    return groups;
  }, {});
  const availableBundles = Object.fromEntries(bundleAvailabilityRows.map((row) => [row.product_id, Number(row.qty_available || 0)]));
  const products = productRows.map((row) => ({
    id: row.product_id, sku: row.sku || row.product_id, name: row.name, unit: row.unit,
    price: Number(row.price), category: row.category, lowStockLevel: Number(row.low_stock_level || 5), status: row.status || 'Active', archivedAt: row.archived_at || null,
    productType: row.product_type || 'individual', bundlePrice: row.bundle_price === null ? null : Number(row.bundle_price), components: bundleComponentsByProduct[row.product_id] || [],
  }));
  const batchesByProduct = sellingPriceBatchRows.reduce((groups, batch) => {
    (groups[batch.product_id] ||= []).push({ qty: Number(batch.qty_remaining), sellingPrice: Number(batch.selling_price) });
    return groups;
  }, {});
  const catalogProducts = products.filter((product) => !product.archivedAt);
  const inventory = catalogProducts.filter((product) => branchProducts[product.id]).map((product) => {
    const branchProduct = branchProducts[product.id];
    return {
      ...product,
      price: product.productType === 'bundle' ? Number(product.bundlePrice || 0) : (batchesByProduct[product.id]?.[0]?.sellingPrice ?? (branchProduct.price_override === null ? product.price : Number(branchProduct.price_override))),
      sellingPriceOverride: branchProduct.selling_price_override === null ? null : Number(branchProduct.selling_price_override),
      lowStockLevel: branchProduct.low_stock_level === null ? product.lowStockLevel : Number(branchProduct.low_stock_level),
      status: branchProduct.status || product.status,
      qty: product.productType === 'bundle' ? (availableBundles[product.id] || 0) : (quantities[product.id] || 0),
      tankInventory: product.productType === 'bundle' && product.category === 'LPG' && product.components.length >= 2 ? (() => {
        const filled = product.components.find((item) => item.inventoryRole === 'filled') || product.components[0];
        const empty = product.components.find((item) => item.inventoryRole === 'empty') || product.components.find((item) => item.productId !== filled.productId);
        return empty ? { filled: Number(quantities[filled.productId] || 0), empty: Number(quantities[empty.productId] || 0) } : null;
      })() : null,
    };
  });
  const paidBySale = paymentRows.reduce((totals, row) => {
    if (!row.sale_id) return totals;
    totals[row.sale_id] = (totals[row.sale_id] || 0) + Number(row.amount || 0);
    return totals;
  }, {});
  const salesHistory = saleRows.map((sale) => {
    const paymentType = String(sale.payment_type || 'cash').toLowerCase();
    const total = Number(sale.total || 0);
    const paid = paidBySale[sale.sale_id] || 0;
    return {
      saleId: sale.sale_id, branchId: sale.branch_id, date: sale.occurred_at, customerId: sale.customer_id || '',
      customerName: customerMap[sale.customer_id]?.name || 'Walk-in customer', subtotal: total + Number(sale.discount || 0),
      total, discount: Number(sale.discount || 0), paymentType, status: sale.status || 'completed',
      cashTendered: Number(sale.cash_tendered || 0), change: Number(sale.change || 0),
      creditPaid: paymentType === 'credit' ? paid : total, creditBalance: paymentType === 'credit' ? Math.max(total - paid, 0) : 0,
      items: saleItemRows.filter((item) => item.sale_id === sale.sale_id).map((item) => ({
        saleItemId: item.sale_item_id, productId: item.product_id, name: productMap[item.product_id]?.name || 'Unknown product', unit: productMap[item.product_id]?.unit || 'unit',
        qty: Number(item.qty || 0), price: Number(item.price || 0),
      })),
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
  const inventoryReport = {};
  const movement = (id) => inventoryReport[id] || (inventoryReport[id] = { qtySold: 0, qtyStockIn: 0, qtyTransferIn: 0, qtyTransferOut: 0 });
  const completedSales = new Set(saleRows.filter((sale) => sale.status === 'completed').map((sale) => sale.sale_id));
  saleItemRows.forEach((item) => { if (completedSales.has(item.sale_id)) movement(item.product_id).qtySold += Number(item.qty || 0); });
  stockInRows.forEach((item) => { if (item.status === 'Completed') movement(item.product_id).qtyStockIn += Number(item.qty || 0); });
  transferRows.forEach((item) => {
    if (item.source_branch_id === branchId && ['In Transit', 'Received'].includes(item.status)) movement(item.product_id).qtyTransferOut += Number(item.qty || 0);
    if (item.destination_branch_id === branchId && item.status === 'Received') movement(item.product_id).qtyTransferIn += Number(item.qty || 0);
  });
  return {
    branches: branchRows.map((row) => ({ id: row.branch_id, name: row.name, type: row.type, address: row.address || '', status: row.status || 'Active' })),
    inventory,
    products: catalogProducts,
    customers: customerRows.map((row) => ({ id: row.customer_id, branchId: row.branch_id, name: row.name, phone: row.phone || '', address: row.address || '', status: row.status || 'Active' })),
    transfers: transferRows.map((row) => ({ id: row.transfer_id, batchId: row.transfer_batch_id || '', sourceBranchId: row.source_branch_id, destinationBranchId: row.destination_branch_id, sourceBranchName: branchMap[row.source_branch_id]?.name || row.source_branch_id, destinationBranchName: branchMap[row.destination_branch_id]?.name || row.destination_branch_id, productId: row.product_id, productName: productMap[row.product_id]?.name || row.product_id, unit: productMap[row.product_id]?.unit || '', qty: Number(row.qty), status: row.status, createdAt: row.created_at, dispatchedAt: row.dispatched_at, receivedAt: row.received_at, notes: row.notes || '' })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    openingCreditAccounts: openingCreditRows.map((row) => ({ creditId: row.credit_account_id, sourceType: row.source_type || 'previous_balance', customerId: row.customer_id, customerName: customerMap[row.customer_id]?.name || 'Unknown customer', date: row.occurred_at, total: Number(row.original_amount || 0), reference: row.migration_reference || '' })),
    creditPayments: paymentRows.map((row) => ({ id: row.payment_id, creditId: row.credit_account_id || row.sale_id, saleId: row.sale_id || '', customerId: row.customer_id, customerName: customerMap[row.customer_id]?.name || 'Unknown customer', amount: Number(row.amount || 0), date: row.occurred_at, notes: row.notes || '' })).sort((a, b) => new Date(b.date) - new Date(a.date)),
    salesHistory,
    saleReturns: saleReturnRows.map((row) => ({
      id: row.return_id, saleId: row.original_sale_id, type: row.return_type, status: row.status, reason: row.reason || '', refundAmount: Number(row.refund_amount || 0),
      refundResolvedAt: row.refund_resolved_at || null, replacementReleasedAt: row.replacement_released_at || null, resolvedAt: row.resolved_at || null, createdAt: row.created_at,
    })),
    saleReturnItems: saleReturnItemRows.map((row) => ({
      id: row.return_item_id, returnId: row.return_id, saleItemId: row.original_sale_item_id, productId: row.product_id, qty: Number(row.qty || 0),
      actionType: row.action_type || 'return', refundAmount: Number(row.refund_amount || 0), condition: row.condition_state, replacementProductId: row.replacement_product_id || '', replacementQty: Number(row.replacement_qty || 0),
    })),
    inventoryReturnLots: returnLotRows.map((row) => ({
      id: row.return_lot_id, returnItemId: row.return_item_id, productId: row.product_id, qty: Number(row.qty || 0), state: row.state || 'quarantine',
      sellingPrice: row.selling_price === null ? null : Number(row.selling_price), resolvedAt: row.resolved_at || null, createdAt: row.created_at || null,
    })),
    inventoryQuarantineCases: quarantineCaseRows.map((row) => ({ id: row.case_id, branchId: row.branch_id, sourceType: row.source_type, reference: row.source_reference, sourceBranchId: row.source_branch_id || '', sourceBranchName: branchMap[row.source_branch_id]?.name || '', supplierReference: row.supplier_reference || '', reason: row.reason || '', status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at || null })),
    inventoryQuarantineItems: quarantineItemRows.map((row) => ({ id: row.quarantine_item_id, caseId: row.case_id, productId: row.product_id, productName: productMap[row.product_id]?.name || row.product_id, unit: productMap[row.product_id]?.unit || 'unit', qty: Number(row.qty || 0), sellingPrice: row.selling_price === null ? null : Number(row.selling_price), resolution: row.resolution || 'quarantine', resolvedAt: row.resolved_at || null })),
    dailySpotCash: dailySpotCashRows.map((row) => ({ id: row.spot_cash_id, branchId: row.branch_id, businessDate: row.business_date, openingCash: Number(row.opening_cash || 0), notes: row.notes || '', createdAt: row.created_at, updatedAt: row.updated_at })),
    dailyExpenses: dailyExpenseRows.map((row) => ({ id: row.expense_id, businessDate: row.business_date, category: row.category, description: row.description, amount: Number(row.amount), receiptReference: row.receipt_reference || '', updatedAt: row.updated_at })),
    inventoryReport,
    stockInHistory: stockInRows.map((row) => ({
      id: row.stock_in_id,
      productId: row.product_id,
      productName: productMap[row.product_id]?.name || row.product_id,
      unit: productMap[row.product_id]?.unit || 'unit',
      qty: Number(row.qty || 0),
      sellingPrice: row.selling_price !== null && row.selling_price !== undefined ? Number(row.selling_price) : (row.unit_cost !== null && row.unit_cost !== undefined ? Number(row.unit_cost) : null),
      supplierReference: row.supplier_reference || '',
      status: row.status || 'Completed',
      date: row.occurred_at,
    })).sort((a, b) => new Date(b.date) - new Date(a.date)),
    sellingPriceBatches: sellingPriceBatchRows.map((row) => ({ productId: row.product_id, qty: Number(row.qty_remaining), sellingPrice: Number(row.selling_price) })),
    bundleComponents: bundleComponentRows.map((row) => ({ bundleProductId: row.bundle_product_id, productId: row.component_product_id, qty: Number(row.qty || 0) })),
    bundleAvailability: availableBundles,
  };
}

async function api(action, payload = {}) {
  const client = requireSupabase_();
  if (action === 'getSetupStatus') {
    const { data, error } = await client.rpc('needs_initial_admin');
    throwIfError_(error);
    return { needsAdmin: Boolean(data) };
  }
  if (action === 'getAppData') return getAppData_(payload.branchId || 'MAIN');
  if (action === 'createFirstAdmin') {
    const email = String(payload.email || '').trim().toLowerCase();
    if (!payload.fullName || !payload.username || !email || !payload.password) throw new Error('Full name, username, email, and password are required.');
    if (String(payload.password).length < 8) throw new Error('Password must have at least 8 characters.');
    localStorage.setItem(INITIAL_ADMIN_KEY, JSON.stringify({ fullName: payload.fullName.trim(), username: payload.username.trim().toLowerCase() }));
    const { data, error } = await client.auth.signUp({
      email,
      password: payload.password,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    throwIfError_(error);
    if (!data.session) {
      localStorage.setItem(INITIAL_ADMIN_REGISTERED_KEY, 'true');
      return { awaitingEmailConfirmation: true };
    }
    return loadSupabaseSession_();
  }
  if (action === 'login') {
    const { data, error } = await client.auth.signInWithPassword({ email: String(payload.email || '').trim(), password: payload.password || '' });
    throwIfError_(error);
    if (!data.session) throw new Error('Invalid email or password.');
    return loadSupabaseSession_();
  }
  if (action === 'restoreSession') return loadSupabaseSession_();
  if (action === 'logout') { const { error } = await client.auth.signOut(); throwIfError_(error); return { loggedOut: true }; }
  if (action === 'changeOwnPassword') {
    const { data: { user } } = await client.auth.getUser();
    if (!user?.email) throw new Error('Your session has expired.');
    const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: payload.currentPassword || '' });
    throwIfError_(signInError);
    const { error } = await client.auth.updateUser({ password: payload.newPassword });
    throwIfError_(error);
    const { error: profileError } = await client.rpc('complete_own_password_change');
    throwIfError_(profileError);
    return { changed: true };
  }
  if (action === 'stockIn') {
    const { data, error } = await client.rpc('stock_in', {
      target_branch_id: payload.branchId,
      target_product_id: payload.productId,
      quantity: Number(payload.qty),
      selling_price_input: Number(payload.sellingPrice),
      supplier_reference_input: payload.supplierReference || '',
    });
    throwIfError_(error);
    return data;
  }
  if (action === 'receiveStockIn') {
    const { data, error } = await client.rpc('receive_stock_in_with_quarantine', {
      target_branch_id: payload.branchId, target_product_id: payload.productId, received_qty: Number(payload.qty),
      quarantine_qty: Number(payload.quarantineQty || 0), selling_price_input: Number(payload.sellingPrice),
      supplier_reference_input: payload.supplierReference || '', reason_input: payload.quarantineReason || '',
    });
    throwIfError_(error);
    return data;
  }
  if (action === 'receiveStockInBatch') {
    const { data, error } = await client.rpc('receive_stock_in_batch_with_quarantine', { target_branch_id: payload.branchId, receipt_lines: payload.lines, supplier_reference_input: payload.supplierReference || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'recordSale') {
    const { data, error } = await client.rpc('record_sale', {
      target_branch_id: payload.branchId,
      sale_lines: payload.items.map((item) => ({
        productId: item.productId,
        qty: Number(item.qty),
        ...(item.emptyReturn ? { emptyReturn: true } : {}),
        ...(Number.isFinite(Number(item.price)) ? { price: Number(item.price) } : {}),
      })),
      payment_type_input: payload.paymentType,
      customer_id_input: payload.customerId || null,
      discount_input: Number(payload.discount || 0),
      cash_tendered_input: Number(payload.cashTendered || 0),
    });
    throwIfError_(error);
    return data;
  }
  if (action === 'receiveSaleReturn') {
    const { data, error } = await client.rpc('receive_sale_return', {
      original_sale_id_input: payload.saleId,
      return_type_input: payload.returnType,
      return_lines: payload.lines,
      reason_input: payload.reason || '',
      refund_amount_input: Number(payload.refundAmount || 0),
    });
    throwIfError_(error);
    return data;
  }
  if (action === 'resolveSaleReturnItem') {
    const { data, error } = await client.rpc('resolve_return_item', { target_return_item_id: payload.returnItemId, resolution: payload.resolution });
    throwIfError_(error);
    return data;
  }
  if (action === 'resolveBundleReturnComponent') {
    const { data, error } = await client.rpc('resolve_bundle_return_component', { target_return_item_id: payload.returnItemId, target_product_id: payload.productId, resolution: payload.resolution });
    throwIfError_(error);
    return data;
  }
  if (action === 'completeSaleRefund') {
    const { data, error } = await client.rpc('resolve_sale_return_financially', { target_return_id: payload.returnId });
    throwIfError_(error);
    return data;
  }
  if (action === 'releaseSaleReplacement') {
    const { data, error } = await client.rpc('release_sale_replacement', { target_return_id: payload.returnId });
    throwIfError_(error);
    return data;
  }
  if (action === 'recordCreditPayment') {
    const { data, error } = await client.rpc('record_credit_payment', { target_branch_id: payload.branchId, target_sale_id: payload.saleId, payment_amount: Number(payload.amount), payment_notes: payload.notes || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'deleteCreditPayment') {
    const { data, error } = await client.rpc('delete_credit_payment', { target_branch_id: payload.branchId, target_payment_id: payload.paymentId });
    throwIfError_(error);
    return data;
  }
  if (action === 'createTransfer') {
    const { data, error } = await client.rpc('create_transfer', { source_branch_id_input: payload.sourceBranchId, destination_branch_id_input: payload.destinationBranchId, target_product_id: payload.productId, transfer_qty: Number(payload.qty), transfer_notes: payload.notes || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'createTransferBatch') {
    const { data, error } = await client.rpc('create_transfer_batch', { source_branch_id_input: payload.sourceBranchId, destination_branch_id_input: payload.destinationBranchId, transfer_lines: payload.lines, transfer_notes: payload.notes || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'dispatchTransfer' || action === 'receiveTransfer' || action === 'cancelTransfer') {
    const rpcName = { dispatchTransfer: 'dispatch_transfer', receiveTransfer: 'receive_transfer', cancelTransfer: 'cancel_transfer' }[action];
    const { data, error } = await client.rpc(rpcName, { target_transfer_id: payload.transferId });
    throwIfError_(error);
    return data;
  }
  if (action === 'processTransferBatch') {
    const { data, error } = await client.rpc('process_transfer_batch', { target_batch_id: payload.batchId, batch_action: payload.batchAction });
    throwIfError_(error);
    return data;
  }
  if (action === 'receiveTransferWithQuarantine') {
    const { data, error } = await client.rpc('receive_transfer_with_quarantine', { target_transfer_id: payload.transferId, accepted_qty_input: Number(payload.acceptedQty), quarantine_qty_input: Number(payload.quarantineQty), reason_input: payload.reason || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'receiveTransferBatchWithQuarantine') {
    const { data, error } = await client.rpc('receive_transfer_batch_with_quarantine', { target_batch_id: payload.batchId, receipt_lines: payload.lines, reason_input: payload.reason || '' });
    throwIfError_(error);
    return data;
  }
  if (action === 'resolveInventoryQuarantineItem') {
    const { data, error } = await client.rpc('resolve_inventory_quarantine_item', { target_quarantine_item_id: payload.itemId, resolution_input: payload.resolution });
    throwIfError_(error);
    return data;
  }
  if (action === 'createCustomer') {
    const { data, error } = await client.rpc('create_customer_with_previous_balance', {
      target_branch_id: payload.branchId,
      customer_name_input: String(payload.name).trim(),
      customer_phone_input: String(payload.phone || '').trim(),
      customer_address_input: String(payload.address || '').trim(),
      customer_status_input: payload.status || 'Active',
      previous_balance_input: Number(payload.previousBalance || 0),
    });
    throwIfError_(error);
    return { id: data.customerId, branchId: payload.branchId, name: String(payload.name).trim(), phone: String(payload.phone || '').trim(), address: String(payload.address || '').trim(), status: payload.status || 'Active', previousBalance: Number(data.previousBalance || 0) };
  }
  if (action === 'updateCustomer') {
    const { data, error } = await client.rpc('update_customer_with_previous_balance', {
      target_branch_id: payload.branchId,
      target_customer_id: payload.customerId,
      customer_name_input: String(payload.name).trim(),
      customer_phone_input: String(payload.phone || '').trim(),
      customer_address_input: String(payload.address || '').trim(),
      customer_status_input: payload.status || 'Active',
      previous_balance_input: Number(payload.previousBalance || 0),
    });
    throwIfError_(error);
    return { id: data.customerId, branchId: payload.branchId, name: String(payload.name).trim(), phone: String(payload.phone || '').trim(), address: String(payload.address || '').trim(), status: payload.status || 'Active', previousBalance: Number(data.previousBalance || 0) };
  }
  if (action === 'createBranch') {
    const row = { branch_id: newPosId_('BRN'), name: String(payload.name).trim(), type: payload.type, address: String(payload.address || '').trim(), status: 'Active' };
    const { data, error } = await client.from('branches').insert(row).select().single();
    throwIfError_(error);
    return { id: data.branch_id, name: data.name, type: data.type, address: data.address, status: data.status };
  }
  if (action === 'updateBranch') {
    const { data, error } = await client.from('branches').update({ name: String(payload.name).trim(), type: payload.type, address: String(payload.address || '').trim(), status: payload.status || 'Active' }).eq('branch_id', payload.branchId).select().single();
    throwIfError_(error);
    return { id: data.branch_id, name: data.name, type: data.type, address: data.address, status: data.status };
  }
  if (action === 'createProduct') {
    const productType = payload.productType === 'bundle' ? 'bundle' : 'individual';
    const bundlePrice = productType === 'bundle' ? Number(payload.bundlePrice) : null;
    if (productType === 'bundle' && (!Number.isFinite(bundlePrice) || bundlePrice < 0)) throw new Error('Enter a valid bundle selling price.');
    const product = { product_id: newPosId_('PRD'), sku: newSku_(), name: String(payload.name).trim(), unit: payload.unit, price: 0, category: payload.category, low_stock_level: Number(payload.lowStockLevel), status: payload.status || 'Active', product_type: productType, bundle_price: bundlePrice };
    const { data, error } = await client.from('products').insert(product).select().single();
    throwIfError_(error);
    const { error: branchError } = await client.from('branch_products').insert({ branch_id: payload.branchId, product_id: data.product_id, price_override: data.price, low_stock_level: data.low_stock_level, status: data.status });
    throwIfError_(branchError);
    if (productType === 'bundle') {
      const { error: componentError } = await client.rpc('save_bundle_components', { target_bundle_product_id: data.product_id, components: payload.bundleComponents || [] });
      throwIfError_(componentError);
    }
    return { id: data.product_id, sku: data.sku, name: data.name, unit: data.unit, price: Number(data.price), category: data.category, lowStockLevel: Number(data.low_stock_level), status: data.status, productType, bundlePrice, components: payload.bundleComponents || [] };
  }
  if (action === 'addProductToBranch') {
    const product = allProducts.find((item) => item.id === payload.productId);
    if (!product) throw new Error('Product not found.');
    const price = payload.price === '' || payload.price === undefined ? product.price : Number(payload.price);
    const lowStockLevel = payload.lowStockLevel === '' || payload.lowStockLevel === undefined ? product.lowStockLevel : Number(payload.lowStockLevel);
    const { error } = await client.from('branch_products').insert({ branch_id: payload.branchId, product_id: payload.productId, price_override: price, low_stock_level: lowStockLevel, status: payload.status || 'Active' });
    throwIfError_(error);
    return { ...product, price, lowStockLevel, status: payload.status || 'Active' };
  }
  if (action === 'updateProduct') {
    const productType = payload.productType === 'bundle' ? 'bundle' : 'individual';
    const bundlePrice = productType === 'bundle' ? Number(payload.bundlePrice) : null;
    if (productType === 'bundle' && (!Number.isFinite(bundlePrice) || bundlePrice < 0)) throw new Error('Enter a valid bundle selling price.');
    const { error: productError } = await client.from('products').update({ name: String(payload.name).trim(), category: payload.category, unit: payload.unit, bundle_price: bundlePrice }).eq('product_id', payload.productId);
    throwIfError_(productError);
    if (productType === 'bundle') {
      const { error: componentError } = await client.rpc('save_bundle_components', { target_bundle_product_id: payload.productId, components: payload.bundleComponents || [] });
      throwIfError_(componentError);
    }
    const { data, error } = await client.from('branch_products').update({ low_stock_level: Number(payload.lowStockLevel), status: payload.status || 'Active' }).eq('branch_id', payload.branchId).eq('product_id', payload.productId).select().single();
    throwIfError_(error);
    return { id: payload.productId, name: String(payload.name).trim(), category: payload.category, unit: payload.unit, price: productType === 'bundle' ? bundlePrice : Number(data.price_override || 0), lowStockLevel: Number(data.low_stock_level), status: data.status, productType, bundlePrice, components: payload.bundleComponents || [] };
  }
  if (action === 'setProductSellingPriceOverride') {
    const price = payload.price === '' || payload.price === undefined ? null : Number(payload.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error('Enter a valid selling price.');
    const { data, error } = await client.from('branch_products').update({ selling_price_override: price }).eq('branch_id', payload.branchId).eq('product_id', payload.productId).select().single();
    throwIfError_(error);
    return { id: payload.productId, sellingPriceOverride: data.selling_price_override === null ? null : Number(data.selling_price_override) };
  }
  if (action === 'deleteProduct') {
    const { data, error } = await client.rpc('delete_product', { target_product_id: payload.productId });
    throwIfError_(error);
    return data;
  }
  if (action === 'getTransferProducts') {
    const { data, error } = await client.rpc('get_shared_transfer_products', {
      source_branch_id_input: payload.sourceBranchId,
      destination_branch_id_input: payload.destinationBranchId,
    });
    throwIfError_(error);
    return (data || []).map((row) => ({ id: row.product_id, name: row.name, unit: row.unit, qty: Number(row.qty || 0) }));
  }
  if (action === 'getStaffAccounts' || action === 'getAdminAccounts' || action === 'getAdminAccount') {
    const query = client.from('profiles').select('*');
    const { data, error } = action === 'getAdminAccount' ? await query.eq('user_id', currentSession.account.id).single() : await query.eq('role', action === 'getStaffAccounts' ? 'staff' : 'admin');
    throwIfError_(error);
    const mapProfile = (row) => ({ id: row.user_id, fullName: row.full_name, username: row.username, branchId: row.branch_id || '', permissions: row.permissions || [], status: row.status || 'Active', mustChangePassword: Boolean(row.must_change_password), lastLogin: row.last_login_at || '', passwordResetAt: row.password_reset_at || '' });
    return action === 'getAdminAccount' ? mapProfile(data) : (data || []).map(mapProfile);
  }
  if (action === 'updateAdminAccount') {
    const { data, error } = await client.functions.invoke('manage-account', { body: { action, ...payload } });
    await throwIfFunctionError_(error);
    if (data?.error) throw new Error(data.error);
    return data;
  }
  if (['createOperationalBackup', 'restoreOperationalBackup'].includes(action)) {
    const { data, error } = await client.functions.invoke('manage-account', { body: { action, ...payload } });
    await throwIfFunctionError_(error);
    if (data?.error) throw new Error(data.error);
    return data;
  }
  if (['createStaffAccount', 'updateStaffAccount', 'resetStaffPassword', 'setStaffAccountStatus', 'createAdminAccount', 'setAdminAccountStatus'].includes(action)) {
    const { data, error } = await client.functions.invoke('manage-account', { body: { action, ...payload } });
    await throwIfFunctionError_(error);
    if (data?.error) throw new Error(data.error);
    return data;
  }
  throw new Error(`Supabase action not yet configured: ${action}.`);
}

/* ==========================================================================
   GLOBAL CENTRALIZED FLOATING TOAST NOTIFICATION
   (User Rule: Always use global and centralized floating toast notification)
   ========================================================================== */
function showToast(message, type = 'info') {
  const toast = $('#toast');
  const messageEl = $('#toastMessage');
  const iconWrap = $('#toastIconWrap');
  if (!toast || !messageEl || !iconWrap) return;

  const icons = {
    success: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
    error: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`,
    info: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  };

  iconWrap.innerHTML = icons[type] || icons.info;
  messageEl.textContent = message;
  toast.className = `toast show ${type}`;
  if (typeof toast.showPopover === 'function' && !toast.matches(':popover-open')) toast.showPopover();

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
    }, 300);
  }, 3200);
}

/* ==========================================================================
   SKELETON LOADING
   (User Rule: Always implement skeleton loading in every)
   ========================================================================== */
function renderSkeletonTable() {
  const table = $('#inventoryTable');
  if (!table) return;

  if (activeView === 'bundleMonitoring') {
    table.innerHTML = Array.from({ length: 6 }).map(() => `
      <div class="bundle-monitor-card bundle-skeleton-card">
        <div class="bundle-monitor-card-header">
          <div class="bundle-monitor-header-left">
            <div class="skeleton-shimmer bundle-skeleton-icon"></div>
            <div class="bundle-skeleton-title-col">
              <div class="skeleton-shimmer bundle-skeleton-line title"></div>
              <div class="skeleton-shimmer bundle-skeleton-line meta"></div>
            </div>
          </div>
          <div class="bundle-monitor-price-box" style="border-color: rgba(255,255,255,0.05); background: rgba(255,255,255,0.02);">
            <div class="skeleton-shimmer bundle-skeleton-line" style="width: 58px; height: 14px;"></div>
            <div class="skeleton-shimmer bundle-skeleton-line" style="width: 32px; height: 8px; margin-top: 2px;"></div>
          </div>
        </div>
        <div class="bundle-monitor-body">
          <div class="skeleton-shimmer bundle-skeleton-line label" style="width: 80px; height: 10px; margin-bottom: 6px;"></div>
          <div class="bundle-skeleton-rows">
            <div class="bundle-skeleton-row">
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 55%; height: 12px;"></div>
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 54px; height: 12px;"></div>
            </div>
            <div class="bundle-skeleton-row">
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 48%; height: 12px;"></div>
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 58px; height: 12px;"></div>
            </div>
          </div>
        </div>
        <div class="bundle-monitor-metrics">
          <div class="bundle-skeleton-stat">
            <div class="skeleton-shimmer bundle-skeleton-stat-icon"></div>
            <div class="bundle-skeleton-stat-text">
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 28px; height: 15px;"></div>
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 60px; height: 9px;"></div>
            </div>
          </div>
          <div class="bundle-skeleton-stat">
            <div class="skeleton-shimmer bundle-skeleton-stat-icon"></div>
            <div class="bundle-skeleton-stat-text">
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 28px; height: 15px;"></div>
              <div class="skeleton-shimmer bundle-skeleton-line" style="width: 65px; height: 9px;"></div>
            </div>
          </div>
        </div>
      </div>
    `).join('');
    return;
  }

  const headers = activeView === 'products'
    ? ['Product', 'Category', 'Selling price', 'Quantity in stock', 'Low stock', 'Status', 'Action']
    : activeView === 'inventory'
    ? ['Product', 'Category', 'Current stock', 'Stock warning', 'Status']
    : activeView === 'inventoryReports'
    ? ['Product', 'Qty sold', 'Qty stock in', 'Qty transfer', 'Qty remaining', 'Status']
    : activeView === 'quarantineReport'
    ? ['Product', 'Case / Date', 'Origin & Reference', 'Inspection Reason', 'Quantity', 'Disposition']
    : activeView === 'branches'
    ? ['Branch', 'Type', 'Address', 'Status', 'Action']
    : activeView === 'customers'
    ? ['Customer', 'Contact', 'Credit', 'Remaining Balance', 'Action']
    : activeView === 'transfers'
    ? ['Transfer', 'Route', 'Product', 'Status', 'Action']
    : activeView === 'dailySpotCash'
    ? ['Business Date', 'Opening Cash Float', 'Notes', 'Last Updated', 'Action']
    : activeView === 'dailyExpenses'
    ? ['Business Date', 'Category', 'Amount', 'Description & Receipt', 'Action']
    : activeView === 'credits'
    ? ['Customer', 'Credit Sale', 'Credit Date', 'Item Count', 'Credit Amount']
    : activeView === 'sales'
    ? ['Receipt', 'Date and Time', 'Customer', 'Payment', 'Total', 'Action']
    : activeView === 'staffAccounts'
    ? ['Staff Account', 'Assigned Branch', 'Menu Access', 'Status', 'Action']
    : activeView === 'adminAccount'
    ? ['Administrator', 'Username', 'Access', 'Status', 'Action']
    : ['Product', 'Selling price', 'Stock', 'Action'];

  const getSkeletonMiddleCells = () => {
    if (activeView === 'products') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:68px;height:24px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line price" style="width:92px;height:18px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:58px;height:24px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:52px;height:24px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:58px;height:24px;"></div></div>
      `;
    }
    if (activeView === 'inventory') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
      `;
    }
    if (activeView === 'inventoryReports') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
      `;
    }
    if (activeView === 'branches') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
        <div><div class="skeleton-shimmer skeleton-line text" style="width:130px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
      `;
    }
    if (activeView === 'customers') {
      return `
        <div class="skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:110px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:150px;"></div></div>
        <div class="skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:120px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:105px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line price" style="width:85px;height:18px;"></div></div>
      `;
    }
    if (activeView === 'transfers') {
      return `
        <div><div class="skeleton-shimmer skeleton-line text" style="width:140px;"></div></div>
        <div class="skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:110px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:60px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
      `;
    }
    if (activeView === 'dailySpotCash') {
      return `
        <div><div class="skeleton-shimmer skeleton-line price" style="width:85px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line text" style="width:140px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line text" style="width:95px;"></div></div>
      `;
    }
    if (activeView === 'dailyExpenses') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:110px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line price" style="width:85px;"></div></div>
        <div class="skeleton-col"><div class="skeleton-shimmer skeleton-line text" style="width:140px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:75px;"></div></div>
      `;
    }
    if (activeView === 'credits') {
      return `
        <div><div class="skeleton-shimmer skeleton-line text" style="width:105px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line text" style="width:90px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line qty" style="width:50px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line price" style="width:80px;"></div></div>
      `;
    }
    if (activeView === 'sales') {
      return `
        <span class="branch-address sales-date-text"><div class="skeleton-shimmer skeleton-line text" style="width:110px;"></div></span>
        <div class="product-cell sales-customer-cell skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:130px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:75px;"></div></div>
        <span class="stock-pill sales-payment-badge"><div class="skeleton-shimmer skeleton-line pill" style="width:55px;height:22px;border-radius:6px;"></div></span>
        <span class="price-text sales-total-price"><div class="skeleton-shimmer skeleton-line price" style="width:85px;"></div></span>
      `;
    }
    if (activeView === 'staffAccounts') {
      return `
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:110px;"></div></div>
        <div>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <div class="skeleton-shimmer skeleton-line pill" style="width:55px;height:22px;border-radius:6px;"></div>
            <div class="skeleton-shimmer skeleton-line pill" style="width:72px;height:22px;border-radius:6px;"></div>
            <div class="skeleton-shimmer skeleton-line pill" style="width:68px;height:22px;border-radius:6px;"></div>
          </div>
        </div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:70px;"></div></div>
      `;
    }
    if (activeView === 'adminAccount') {
      return `
        <div><div class="skeleton-shimmer skeleton-line text" style="width:110px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:140px;"></div></div>
        <div><div class="skeleton-shimmer skeleton-line pill" style="width:70px;"></div></div>
      `;
    }
    if (activeView === 'quarantineReport') {
      return `
        <div class="product-cell skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:105px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:75px;"></div></div>
        <div class="product-cell skeleton-col"><div class="skeleton-shimmer skeleton-line title" style="width:120px;"></div><div class="skeleton-shimmer skeleton-line meta" style="width:90px;"></div></div>
        <div class="product-cell"><div class="skeleton-shimmer skeleton-line text" style="width:140px;"></div></div>
        <div class="row-middle-cells" style="justify-content:center; display:flex;"><div class="skeleton-shimmer skeleton-line pill" style="width:48px;height:22px;"></div></div>
        <div class="row-action-cell" style="justify-content:center; display:flex;"><div class="skeleton-shimmer skeleton-line pill" style="width:90px;height:22px;"></div></div>
      `;
    }
    // Default / POS view:
    return `
      <div><div class="skeleton-shimmer skeleton-line price"></div></div>
      <div><div class="skeleton-shimmer skeleton-line pill"></div></div>
    `;
  };

  const hasAction = !['inventory', 'inventoryReports', 'credits', 'quarantineReport'].includes(activeView);

  const getSkeletonActionCell = () => {
    if (!hasAction) return '';
    if (activeView === 'products' || activeView === 'staffAccounts' || activeView === 'customers' || activeView === 'sales') {
      return `
        <div class="row-action-cell skeleton-action-cell">
          <span class="table-actions" style="display:flex;gap:6px;align-items:center;justify-content:center;width:100%;">
            <div class="skeleton-shimmer skeleton-line btn" style="width:32px;height:32px;border-radius:9px;flex-shrink:0;"></div>
            <div class="skeleton-shimmer skeleton-line btn" style="width:32px;height:32px;border-radius:9px;flex-shrink:0;"></div>
            <div class="skeleton-shimmer skeleton-line btn" style="width:32px;height:32px;border-radius:9px;flex-shrink:0;"></div>
          </span>
        </div>
      `;
    }
    if (activeView === 'dailySpotCash' || activeView === 'dailyExpenses') {
      return `
        <div class="row-action-cell skeleton-action-cell">
          <span class="table-actions" style="display:flex;gap:6px;align-items:center;">
            <div class="skeleton-shimmer skeleton-line btn" style="width:32px;height:32px;border-radius:9px;"></div>
            <div class="skeleton-shimmer skeleton-line btn" style="width:32px;height:32px;border-radius:9px;"></div>
          </span>
        </div>
      `;
    }
    return `
      <div class="row-action-cell skeleton-action-cell">
        <div class="skeleton-shimmer skeleton-line btn"></div>
      </div>
    `;
  };

  if (activeView === 'quarantineReport') {
    const quarantineRows = Array.from({ length: 5 }).map(() => `
      <div class="table-row skeleton-row">
        <div class="product-cell qr-product-cell skeleton-prod-col">
          <div class="skeleton-shimmer skeleton-line title"></div>
          <div class="skeleton-shimmer skeleton-line meta"></div>
        </div>
        <div class="product-cell qr-case-cell skeleton-col">
          <div class="skeleton-shimmer skeleton-line title" style="width: 105px;"></div>
          <div class="skeleton-shimmer skeleton-line meta" style="width: 75px;"></div>
        </div>
        <div class="product-cell qr-origin-cell skeleton-col">
          <div class="skeleton-shimmer skeleton-line title" style="width: 120px;"></div>
          <div class="skeleton-shimmer skeleton-line meta" style="width: 90px;"></div>
        </div>
        <div class="product-cell qr-reason-cell">
          <div class="skeleton-shimmer skeleton-line text" style="width: 140px;"></div>
        </div>
        <div class="row-middle-cells qr-qty-cell">
          <div class="skeleton-shimmer skeleton-line pill" style="width: 48px; height: 22px;"></div>
        </div>
        <div class="row-action-cell qr-disposition-cell">
          <div class="skeleton-shimmer skeleton-line pill" style="width: 90px; height: 22px;"></div>
        </div>
      </div>
    `).join('');

    table.innerHTML = `
      <div class="quarantine-filter-bar" style="pointer-events: none; opacity: 0.7;">
        <div class="skeleton-shimmer skeleton-line pill" style="width: 55px; height: 32px; border-radius: 9999px;"></div>
        <div class="skeleton-shimmer skeleton-line pill" style="width: 95px; height: 32px; border-radius: 9999px;"></div>
        <div class="skeleton-shimmer skeleton-line pill" style="width: 130px; height: 32px; border-radius: 9999px;"></div>
        <div class="skeleton-shimmer skeleton-line pill" style="width: 85px; height: 32px; border-radius: 9999px;"></div>
      </div>
      <div class="table-row table-header">
        ${headers.map((header) => `<span>${header}</span>`).join('')}
      </div>
      ${quarantineRows}
    `;
    return;
  }

  const rows = Array.from({ length: 5 }).map(() => `
    <div class="table-row skeleton-row">
      <div class="skeleton-col skeleton-prod-col">
        <div class="skeleton-shimmer skeleton-line title"></div>
        <div class="skeleton-shimmer skeleton-line meta"></div>
      </div>
      <div class="row-middle-cells skeleton-middle-cells">
        ${getSkeletonMiddleCells()}
      </div>
      ${getSkeletonActionCell()}
    </div>
  `).join('');

  table.innerHTML = `
    <div class="table-row table-header">
      ${headers.map((header) => `<span>${header}</span>`).join('')}
    </div>
    ${rows}
  `;
}

/* ==========================================================================
   SMOOTH CUSTOM DROPDOWN SYSTEM
   (User Requirement: Make everything smooth and the dropdown must be smooth)
   ========================================================================== */
function sortSelectOptionsAtoZ_(select) {
  if (!select || !select.options || select.options.length <= 1) return;
  if (select.dataset.noSort === 'true') return;

  const currentVal = select.value;
  const options = Array.from(select.options);
  const first = options[0];
  const hasPlaceholder = first && (!first.value || first.disabled);
  const toSort = hasPlaceholder ? options.slice(1) : options;

  toSort.sort((a, b) => a.text.trim().localeCompare(b.text.trim(), 'en', { sensitivity: 'base' }));

  const sorted = hasPlaceholder ? [first, ...toSort] : toSort;
  sorted.forEach((opt) => select.appendChild(opt));

  if (currentVal !== undefined && currentVal !== '') {
    select.value = currentVal;
  }
}

function initCustomDropdowns(container = document) {
  const selects = container.querySelectorAll('select:not([data-custom-enhanced])');

  selects.forEach((select) => {
    sortSelectOptionsAtoZ_(select);
    select.setAttribute('data-custom-enhanced', 'true');
    select.classList.add('native-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-dropdown';
    const isBranch = select.id === 'branchSelector' || select.classList.contains('branch-label');
    if (isBranch) {
      wrapper.classList.add('branch-dropdown');
    }

    const selectedOption = select.options[select.selectedIndex] || select.options[0];
    const initialText = selectedOption ? selectedOption.text : 'Select...';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dropdown-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      ${isBranch ? '<span class="status-pulse"></span>' : ''}
      <span class="dropdown-selected-text">${escapeHtml(initialText)}</span>
      <svg class="dropdown-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    `;

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Search bar header inside dropdown menu
    const searchWrap = document.createElement('div');
    searchWrap.className = 'dropdown-search-wrap';
    searchWrap.innerHTML = `
      <svg class="dropdown-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      <input type="text" class="dropdown-search-input" placeholder="Search..." autocomplete="off" spellcheck="false" />
      <button type="button" class="dropdown-search-clear" aria-label="Clear search" title="Clear search" tabindex="-1" style="display:none;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    `;

    const searchInput = searchWrap.querySelector('.dropdown-search-input');
    const searchClear = searchWrap.querySelector('.dropdown-search-clear');

    const optionsList = document.createElement('div');
    optionsList.className = 'dropdown-options-list';
    optionsList.setAttribute('role', 'listbox');

    const emptyState = document.createElement('div');
    emptyState.className = 'dropdown-empty-state';
    emptyState.textContent = 'No matching items';
    emptyState.style.display = 'none';

    const filterOptions = () => {
      const q = (searchInput.value || '').trim().toLowerCase();
      searchClear.style.display = q ? 'flex' : 'none';
      let visibleCount = 0;
      const opts = optionsList.querySelectorAll('.dropdown-option');
      opts.forEach((opt) => {
        const text = opt.querySelector('span')?.textContent.toLowerCase() || '';
        const match = !q || text.includes(q);
        opt.style.display = match ? 'flex' : 'none';
        if (match) visibleCount++;
      });
      emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
    };

    searchInput.addEventListener('input', filterOptions);

    searchClear.addEventListener('click', (e) => {
      e.stopPropagation();
      searchInput.value = '';
      filterOptions();
      searchInput.focus();
    });

    searchWrap.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const firstVisible = Array.from(optionsList.querySelectorAll('.dropdown-option')).find((o) => o.style.display !== 'none' && !o.classList.contains('disabled'));
        if (firstVisible) firstVisible.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const firstVisible = Array.from(optionsList.querySelectorAll('.dropdown-option')).find((o) => o.style.display !== 'none' && !o.classList.contains('disabled'));
        if (firstVisible) firstVisible.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown(wrapper, trigger);
        trigger.focus();
      }
    });

    const renderMenuOptions = () => {
      optionsList.innerHTML = '';
      optionsList.appendChild(emptyState);
      emptyState.style.display = 'none';

      Array.from(select.options).forEach((opt) => {
        // Skip purely decorative empty placeholder prompts that are disabled
        if (opt.disabled && !opt.value) return;

        const optionEl = document.createElement('div');
        optionEl.className = `dropdown-option${opt.selected ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`;
        optionEl.setAttribute('role', 'option');
        optionEl.setAttribute('data-value', opt.value);
        optionEl.tabIndex = opt.disabled ? -1 : 0;
        optionEl.innerHTML = `
          <span>${escapeHtml(opt.text)}</span>
          <svg class="opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;

        if (!opt.disabled) {
          const selectThisOption = () => {
            select.value = opt.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            trigger.querySelector('.dropdown-selected-text').textContent = opt.text;
            optionsList.querySelectorAll('.dropdown-option').forEach((o) => o.classList.remove('selected'));
            optionEl.classList.add('selected');
            closeDropdown(wrapper, trigger);
            trigger.focus();
          };

          optionEl.addEventListener('click', (e) => {
            e.stopPropagation();
            selectThisOption();
          });

          optionEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectThisOption();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              let next = optionEl.nextElementSibling;
              while (next && (next.style.display === 'none' || next.classList.contains('disabled'))) {
                next = next.nextElementSibling;
              }
              if (next && next.classList.contains('dropdown-option')) next.focus();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              let prev = optionEl.previousElementSibling;
              while (prev && (prev.style.display === 'none' || prev.classList.contains('disabled'))) {
                prev = prev.previousElementSibling;
              }
              if (prev && prev.classList.contains('dropdown-option')) {
                prev.focus();
              } else {
                searchInput.focus();
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeDropdown(wrapper, trigger);
              trigger.focus();
            }
          });
        }

        optionsList.appendChild(optionEl);
      });

      filterOptions();
    };

    renderMenuOptions();
    wrapper._renderOptions = renderMenuOptions;

    menu.appendChild(searchWrap);
    menu.appendChild(optionsList);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.contains('open');
      document.querySelectorAll('.custom-dropdown.open').forEach((d) => {
        if (d !== wrapper) closeDropdown(d, d.querySelector('.dropdown-trigger'));
      });
      if (isOpen) {
        closeDropdown(wrapper, trigger);
      } else {
        openDropdown(wrapper, trigger);
      }
    });

    trigger.addEventListener('keydown', (e) => {
      const isOpen = wrapper.classList.contains('open');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!isOpen) {
          openDropdown(wrapper, trigger);
        } else {
          searchInput.focus();
        }
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        closeDropdown(wrapper, trigger);
      }
    });

    select.addEventListener('change', () => {
      const newOpt = select.options[select.selectedIndex];
      if (newOpt) {
        trigger.querySelector('.dropdown-selected-text').textContent = newOpt.text;
        optionsList.querySelectorAll('.dropdown-option').forEach((o) => {
          o.classList.toggle('selected', o.dataset.value === newOpt.value);
        });
      }
    });

    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
  });
}

function updateCustomDropdown(select) {
  if (!select) return;
  sortSelectOptionsAtoZ_(select);
  const wrapper = select.closest('.custom-dropdown');
  if (!wrapper || typeof wrapper._renderOptions !== 'function') {
    if (wrapper) wrapper.replaceWith(select);
    select.removeAttribute('data-custom-enhanced');
    select.classList.remove('native-hidden');
    initCustomDropdowns(select.parentElement);
    return;
  }
  const selectedOpt = select.options[select.selectedIndex] || select.options[0];
  const triggerText = wrapper.querySelector('.dropdown-selected-text');
  if (triggerText && selectedOpt) {
    triggerText.textContent = selectedOpt.text;
  }
  wrapper._renderOptions();
}

function openDropdown(wrapper, trigger) {
  const menu = wrapper.querySelector('.dropdown-menu');
  if (menu) {
    const dialog = wrapper.closest('dialog');
    if (dialog) {
      if (!wrapper.dataset.dropdownId) wrapper.dataset.dropdownId = `dropdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      menu._dropdownHome = wrapper;
      menu.dataset.dropdownOwner = wrapper.dataset.dropdownId;
      dialog.appendChild(menu);
      menu.classList.add('dropdown-menu-floating');
    }
    positionDropdownMenu(wrapper, menu);
  }
  wrapper.classList.add('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  const parentGroup = wrapper.closest('.form-field-group');
  if (parentGroup) parentGroup.classList.add('has-open-dropdown');

  const searchInput = wrapper.querySelector('.dropdown-search-input');
  if (searchInput) {
    searchInput.value = '';
    const clearBtn = wrapper.querySelector('.dropdown-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    const emptyState = wrapper.querySelector('.dropdown-empty-state');
    if (emptyState) emptyState.style.display = 'none';
    wrapper.querySelectorAll('.dropdown-option').forEach((opt) => {
      opt.style.display = 'flex';
    });
    setTimeout(() => {
      searchInput.focus({ preventScroll: true });
    }, 40);
  }
}

function closeDropdown(wrapper, trigger) {
  const menu = document.querySelector(`.dropdown-menu-floating[data-dropdown-owner="${wrapper.dataset.dropdownId || ''}"]`) || wrapper.querySelector('.dropdown-menu');
  if (menu) {
    menu.classList.remove('dropdown-menu-floating', 'opens-up');
    menu.removeAttribute('data-dropdown-owner');
    menu.removeAttribute('style');
    (menu._dropdownHome || wrapper).appendChild(menu);
  }
  wrapper.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  const parentGroup = wrapper.closest('.form-field-group');
  if (parentGroup) parentGroup.classList.remove('has-open-dropdown');
}

function positionDropdownMenu(wrapper, menu) {
  const trigger = wrapper.querySelector('.dropdown-trigger');
  if (!trigger) return;

  const triggerRect = trigger.getBoundingClientRect();
  const dialogRect = wrapper.closest('dialog')?.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const topLimit = Math.max(margin, dialogRect ? dialogRect.top + margin : margin);
  const bottomLimit = Math.min(window.innerHeight - margin, dialogRect ? dialogRect.bottom - margin : window.innerHeight - margin);
  const spaceAbove = triggerRect.top - topLimit - gap;
  const spaceBelow = bottomLimit - triggerRect.bottom - gap;
  const opensUp = spaceBelow < 180 && spaceAbove > spaceBelow;
  const availableSpace = Math.max(120, Math.min(280, opensUp ? spaceAbove : spaceBelow));

  menu.classList.toggle('opens-up', opensUp);
  if (dialogRect && menu.classList.contains('dropdown-menu-floating')) {
    menu.style.left = `${triggerRect.left - dialogRect.left}px`;
    menu.style.width = `${triggerRect.width}px`;
    menu.style.maxHeight = `${availableSpace}px`;
    menu.style.top = opensUp ? 'auto' : `${triggerRect.bottom - dialogRect.top + gap}px`;
    menu.style.bottom = opensUp ? `${dialogRect.bottom - triggerRect.top + gap}px` : 'auto';
  } else {
    menu.style.maxHeight = `${availableSpace}px`;
  }
}

/* ==========================================================================
   SMOOTH CUSTOM DATE PICKER & CALENDAR SYSTEM
   (User Requirement: Redesign date picker and calendar, make it smooth)
   ========================================================================== */
function initCustomDatePickers(container = document) {
  const dateInputs = container.querySelectorAll('input[type="date"]:not([data-custom-enhanced])');
  if (!dateInputs.length) return;

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  dateInputs.forEach((input) => {
    input.setAttribute('data-custom-enhanced', 'true');
    input.classList.add('native-hidden');

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-datepicker';

    let currentView = 'days';
    let viewYear = new Date().getFullYear();
    let viewMonth = new Date().getMonth();

    if (input.value) {
      const parts = input.value.split('-');
      if (parts.length === 3) {
        viewYear = parseInt(parts[0], 10) || viewYear;
        viewMonth = (parseInt(parts[1], 10) - 1);
      }
    }

    const formatDisplay = (isoStr) => {
      if (!isoStr) return 'Select date';
      const parts = isoStr.split('-');
      if (parts.length === 3) {
        return `${parts[1]}/${parts[2]}/${parts[0]}`;
      }
      return isoStr;
    };

    // Create trigger button
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'datepicker-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', input.getAttribute('aria-label') || 'Choose date');
    trigger.innerHTML = `
      <div class="datepicker-trigger-left">
        <svg class="datepicker-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v4"/>
          <path d="M16 2v4"/>
          <rect width="18" height="18" x="3" y="4" rx="3"/>
          <path d="M3 10h18"/>
          <circle cx="8" cy="14" r="1.1" fill="#ffffff" stroke="none"/>
          <circle cx="12" cy="14" r="1.1" fill="#ffffff" stroke="none"/>
          <circle cx="16" cy="14" r="1.1" fill="#ffffff" stroke="none"/>
          <circle cx="8" cy="18" r="1.1" fill="#ffffff" stroke="none"/>
          <circle cx="12" cy="18" r="1.1" fill="#ffffff" stroke="none"/>
          <circle cx="16" cy="18" r="1.1" fill="#ffffff" stroke="none"/>
        </svg>
        <span class="datepicker-display-value">${formatDisplay(input.value)}</span>
      </div>
      <svg class="datepicker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    `;

    // Create calendar popover
    const popover = document.createElement('div');
    popover.className = 'custom-calendar-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Calendar');

    // Calendar Header
    const calHeader = document.createElement('div');
    calHeader.className = 'cal-header';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'cal-nav-btn cal-nav-prev';
    prevBtn.setAttribute('aria-label', 'Previous month');
    prevBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    `;

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'cal-title-btn';
    titleBtn.innerHTML = `
      <span class="cal-title-text">${MONTH_NAMES[viewMonth]} ${viewYear}</span>
      <svg class="cal-title-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    `;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'cal-nav-btn cal-nav-next';
    nextBtn.setAttribute('aria-label', 'Next month');
    nextBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    `;

    calHeader.appendChild(prevBtn);
    calHeader.appendChild(titleBtn);
    calHeader.appendChild(nextBtn);

    const weekdaysEl = document.createElement('div');
    weekdaysEl.className = 'cal-weekdays';
    weekdaysEl.innerHTML = WEEKDAYS.map(day => `<span>${day}</span>`).join('');

    const daysGrid = document.createElement('div');
    daysGrid.className = 'cal-days-grid';

    const monthsGrid = document.createElement('div');
    monthsGrid.className = 'cal-months-view';
    monthsGrid.hidden = true;

    const calFooter = document.createElement('div');
    calFooter.className = 'cal-footer';
    calFooter.innerHTML = `
      <button type="button" class="cal-action-btn cal-clear-btn">Clear</button>
      <button type="button" class="cal-action-btn cal-today-btn">Today</button>
    `;

    popover.appendChild(calHeader);
    popover.appendChild(weekdaysEl);
    popover.appendChild(daysGrid);
    popover.appendChild(monthsGrid);
    popover.appendChild(calFooter);

    // Helpers
    const updateTriggerDisplay = () => {
      const displayVal = trigger.querySelector('.datepicker-display-value');
      if (displayVal) displayVal.textContent = formatDisplay(input.value);
    };

    const updateTitle = () => {
      const titleText = titleBtn.querySelector('.cal-title-text');
      if (titleText) {
        titleText.textContent = currentView === 'months' ? `${viewYear}` : `${MONTH_NAMES[viewMonth]} ${viewYear}`;
      }
    };

    const renderMonthsView = () => {
      monthsGrid.innerHTML = '';
      const selectedYear = input.value ? parseInt(input.value.split('-')[0], 10) : null;
      const selectedMonth = input.value ? parseInt(input.value.split('-')[1], 10) - 1 : null;

      SHORT_MONTHS.forEach((name, idx) => {
        const monthBtn = document.createElement('button');
        monthBtn.type = 'button';
        monthBtn.className = 'cal-month-cell';
        if (selectedYear === viewYear && selectedMonth === idx) {
          monthBtn.classList.add('is-selected');
        }
        monthBtn.textContent = name;
        monthBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          viewMonth = idx;
          currentView = 'days';
          popover.classList.remove('view-months');
          weekdaysEl.hidden = false;
          daysGrid.hidden = false;
          monthsGrid.hidden = true;
          updateTitle();
          renderDaysView();
        });
        monthsGrid.appendChild(monthBtn);
      });
    };

    const renderDaysView = () => {
      daysGrid.innerHTML = '';
      updateTitle();

      const today = new Date();
      const todayYear = today.getFullYear();
      const todayMonth = today.getMonth();
      const todayDate = today.getDate();

      const selectedIso = input.value || '';
      const isDateFrom = input.id === 'salesDateFrom' || input.id === 'quarantineDateFrom';
      const otherInput = input.id === 'salesDateFrom'
        ? $('#salesDateTo')
        : input.id === 'salesDateTo'
        ? $('#salesDateFrom')
        : input.id === 'quarantineDateFrom'
        ? $('#quarantineDateTo')
        : input.id === 'quarantineDateTo'
        ? $('#quarantineDateFrom')
        : null;
      const otherIso = otherInput?.value || '';

      let rangeStart = isDateFrom ? selectedIso : otherIso;
      let rangeEnd = isDateFrom ? otherIso : selectedIso;
      if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
        const tmp = rangeStart;
        rangeStart = rangeEnd;
        rangeEnd = tmp;
      }

      const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
      const daysInCurrentMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

      const pad = (n) => String(n).padStart(2, '0');

      // Previous month days
      for (let i = firstDayIndex - 1; i >= 0; i--) {
        const d = daysInPrevMonth - i;
        const prevM = viewMonth === 0 ? 11 : viewMonth - 1;
        const prevY = viewMonth === 0 ? viewYear - 1 : viewYear;
        const iso = `${prevY}-${pad(prevM + 1)}-${pad(d)}`;

        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day-cell is-other-month';
        cell.textContent = d;
        cell.dataset.date = iso;
        if (iso === selectedIso) cell.classList.add('is-selected');
        if (rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd) cell.classList.add('is-in-range');

        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          viewMonth = prevM;
          viewYear = prevY;
          selectDate(iso);
        });
        daysGrid.appendChild(cell);
      }

      // Current month days
      for (let d = 1; d <= daysInCurrentMonth; d++) {
        const iso = `${viewYear}-${pad(viewMonth + 1)}-${pad(d)}`;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day-cell';
        cell.textContent = d;
        cell.dataset.date = iso;

        if (viewYear === todayYear && viewMonth === todayMonth && d === todayDate) {
          cell.classList.add('is-today');
        }
        if (iso === selectedIso) {
          cell.classList.add('is-selected');
        }
        if (rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd) {
          cell.classList.add('is-in-range');
        }

        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          selectDate(iso);
        });
        daysGrid.appendChild(cell);
      }

      // Next month trailing days to complete full grid
      const totalCells = daysGrid.children.length;
      const remainingCells = (totalCells % 7 === 0 && totalCells >= 35) ? 0 : 7 - (totalCells % 7);
      const nextMonthCount = (totalCells + remainingCells < 35) ? remainingCells + 7 : remainingCells;

      for (let d = 1; d <= nextMonthCount; d++) {
        const nextM = viewMonth === 11 ? 0 : viewMonth + 1;
        const nextY = viewMonth === 11 ? viewYear + 1 : viewYear;
        const iso = `${nextY}-${pad(nextM + 1)}-${pad(d)}`;

        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day-cell is-other-month';
        cell.textContent = d;
        cell.dataset.date = iso;
        if (iso === selectedIso) cell.classList.add('is-selected');
        if (rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd) cell.classList.add('is-in-range');

        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          viewMonth = nextM;
          viewYear = nextY;
          selectDate(iso);
        });
        daysGrid.appendChild(cell);
      }
    };

    const selectDate = (iso) => {
      input.value = iso;
      updateTriggerDisplay();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeDatePicker(wrapper, trigger);
    };

    // Navigation handlers
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentView === 'months') {
        viewYear--;
        updateTitle();
        renderMonthsView();
      } else {
        viewMonth--;
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear--;
        }
        renderDaysView();
      }
    });

    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentView === 'months') {
        viewYear++;
        updateTitle();
        renderMonthsView();
      } else {
        viewMonth++;
        if (viewMonth > 11) {
          viewMonth = 0;
          viewYear++;
        }
        renderDaysView();
      }
    });

    titleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentView === 'days') {
        currentView = 'months';
        popover.classList.add('view-months');
        weekdaysEl.hidden = true;
        daysGrid.hidden = true;
        monthsGrid.hidden = false;
        updateTitle();
        renderMonthsView();
      } else {
        currentView = 'days';
        popover.classList.remove('view-months');
        weekdaysEl.hidden = false;
        daysGrid.hidden = false;
        monthsGrid.hidden = true;
        updateTitle();
        renderDaysView();
      }
    });

    // Clear and Today actions
    const clearBtn = calFooter.querySelector('.cal-clear-btn');
    const todayBtn = calFooter.querySelector('.cal-today-btn');

    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      input.value = '';
      updateTriggerDisplay();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeDatePicker(wrapper, trigger);
    });

    todayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const today = new Date();
      viewYear = today.getFullYear();
      viewMonth = today.getMonth();
      const pad = (n) => String(n).padStart(2, '0');
      const iso = `${viewYear}-${pad(viewMonth + 1)}-${pad(today.getDate())}`;
      selectDate(iso);
    });

    // Open/Close trigger handler
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.contains('open');
      document.querySelectorAll('.custom-datepicker.open').forEach((dp) => {
        if (dp !== wrapper) closeDatePicker(dp, dp.querySelector('.datepicker-trigger'));
      });
      document.querySelectorAll('.custom-dropdown.open').forEach((d) => {
        closeDropdown(d, d.querySelector('.dropdown-trigger'));
      });

      if (isOpen) {
        closeDatePicker(wrapper, trigger);
      } else {
        if (input.value) {
          const parts = input.value.split('-');
          if (parts.length === 3) {
            viewYear = parseInt(parts[0], 10) || viewYear;
            viewMonth = (parseInt(parts[1], 10) - 1);
          }
        }
        currentView = 'days';
        popover.classList.remove('view-months');
        weekdaysEl.hidden = false;
        daysGrid.hidden = false;
        monthsGrid.hidden = true;
        renderDaysView();
        openDatePicker(wrapper, trigger, popover);
      }
    });

    input.addEventListener('change', () => {
      updateTriggerDisplay();
    });

    wrapper._updateDisplay = () => {
      updateTriggerDisplay();
      if (input.value) {
        const parts = input.value.split('-');
        if (parts.length === 3) {
          viewYear = parseInt(parts[0], 10) || viewYear;
          viewMonth = (parseInt(parts[1], 10) - 1);
        }
      }
    };

    // Attach to DOM
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    wrapper.appendChild(trigger);
    wrapper.appendChild(popover);
  });
}

function openDatePicker(wrapper, trigger, popover) {
  wrapper.classList.add('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');

  const parentGroup = wrapper.closest('.form-field-group');
  if (parentGroup) parentGroup.classList.add('has-open-datepicker');
  const dialog = wrapper.closest('dialog');
  if (dialog) {
    dialog.classList.add('has-open-datepicker');
    const form = dialog.querySelector('form');
    if (form) form.classList.add('has-open-datepicker');
    const fields = dialog.querySelector('#formFields');
    if (fields) fields.classList.add('has-open-datepicker');
  }

  if (popover && trigger) {
    const triggerRect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const opensUp = spaceBelow < 330 && spaceAbove > spaceBelow;
    popover.classList.toggle('opens-up', opensUp);

    if (triggerRect.right + 296 > window.innerWidth - 16 || triggerRect.left + 296 > window.innerWidth - 16) {
      popover.classList.add('anchor-right');
    } else {
      popover.classList.remove('anchor-right');
    }
  }
}

function closeDatePicker(wrapper, trigger) {
  wrapper.classList.remove('open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');

  const parentGroup = wrapper.closest('.form-field-group');
  if (parentGroup) parentGroup.classList.remove('has-open-datepicker');
  const dialog = wrapper.closest('dialog');
  if (dialog) {
    dialog.classList.remove('has-open-datepicker');
    const form = dialog.querySelector('form');
    if (form) form.classList.remove('has-open-datepicker');
    const fields = dialog.querySelector('#formFields');
    if (fields) fields.classList.remove('has-open-datepicker');
  }
}

function syncCustomDatePicker(input) {
  if (!input) return;
  const wrapper = input.closest('.custom-datepicker');
  if (wrapper && typeof wrapper._updateDisplay === 'function') {
    wrapper._updateDisplay();
  }
}

// Global click-outside & Escape listeners for smooth dropdowns and custom datepickers
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-dropdown')) {
    document.querySelectorAll('.custom-dropdown.open').forEach((d) => {
      closeDropdown(d, d.querySelector('.dropdown-trigger'));
    });
  }
  if (!e.target.closest('.custom-datepicker')) {
    document.querySelectorAll('.custom-datepicker.open').forEach((dp) => {
      closeDatePicker(dp, dp.querySelector('.datepicker-trigger'));
    });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.custom-dropdown.open').forEach((d) => {
      closeDropdown(d, d.querySelector('.dropdown-trigger'));
    });
    document.querySelectorAll('.custom-datepicker.open').forEach((dp) => {
      closeDatePicker(dp, dp.querySelector('.datepicker-trigger'));
    });
  }
});

function repositionOpenDropdowns() {
  document.querySelectorAll('.custom-dropdown.open').forEach((dropdown) => {
    const menu = document.querySelector(`.dropdown-menu-floating[data-dropdown-owner="${dropdown.dataset.dropdownId || ''}"]`) || dropdown.querySelector('.dropdown-menu');
    if (menu) positionDropdownMenu(dropdown, menu);
  });
}

window.addEventListener('resize', repositionOpenDropdowns);
document.addEventListener('scroll', repositionOpenDropdowns, true);

/* ==========================================================================
   INVENTORY & TABLE RENDERING
   ========================================================================== */
function getInventoryReportRows() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  return sortByName_(products.filter((product) => `${product.name} ${product.category} ${product.sku || ''}`.toLowerCase().includes(term)));
}

function getInventoryReportStatus(product) {
  const qty = Number(product.qty) || 0;
  if (product.status !== 'Active') return { label: 'Inactive', className: 'stock-low' };
  if (qty <= 0) return { label: 'Out of stock', className: 'stock-low' };
  if (qty <= Number(product.lowStockLevel || 0)) return { label: 'Low stock', className: 'stock-low' };
  return { label: 'In stock', className: 'stock-normal' };
}

function getInventoryReportMovement(productId) {
  return inventoryReportData[productId] || { qtySold: 0, qtyStockIn: 0, qtyTransferIn: 0, qtyTransferOut: 0 };
}

function formatTransferQuantity(movement) {
  const incoming = Number(movement.qtyTransferIn) || 0;
  const outgoing = Number(movement.qtyTransferOut) || 0;
  if (!incoming && !outgoing) return 'None';
  return `+${incoming.toLocaleString('en-PH')} / -${outgoing.toLocaleString('en-PH')}`;
}

function renderTransferQuantity(movement) {
  const incoming = Number(movement.qtyTransferIn) || 0;
  const outgoing = Number(movement.qtyTransferOut) || 0;
  const badges = [];
  if (incoming) badges.push(`<span class="transfer-badge report-transfer-badge transfer-in">+${incoming.toLocaleString('en-PH')}</span>`);
  if (outgoing) badges.push(`<span class="transfer-badge report-transfer-badge transfer-out">-${outgoing.toLocaleString('en-PH')}</span>`);
  return badges.join('') || '<span class="transfer-badge report-transfer-badge transfer-none">None</span>';
}

function renderInventoryReports() {
  const table = $('#inventoryTable');
  if (!table) return;

  const rows = getInventoryReportRows();

  table.innerHTML = `
    <div class="table-row table-header"><span>Product</span><span>Qty Sold</span><span>Qty Stock In</span><span>Qty Transfer</span><span>Qty Remaining</span><span>Status</span></div>
    ${rows.map((product) => {
      const qty = Math.max(Number(product.qty) || 0, 0);
      const status = getInventoryReportStatus(product);
      const movement = getInventoryReportMovement(product.id);
      return `<div class="table-row">
        <div class="product-cell"><strong class="product-name">${escapeHtml(product.name)}</strong><span class="product-meta">${escapeHtml(product.sku || product.id)} &bull; ${escapeHtml(product.unit || 'unit')}</span></div>
        <div class="row-middle-cells">
          <span class="stock-pill stock-quantity report-qty-sold" data-report-label="Sold">${(Number(movement.qtySold) || 0).toLocaleString('en-PH')} ${escapeHtml(product.unit || 'unit')}</span>
          <span class="stock-pill stock-quantity report-qty-stock-in" data-report-label="Stock In">${(Number(movement.qtyStockIn) || 0).toLocaleString('en-PH')} ${escapeHtml(product.unit || 'unit')}</span>
          <span class="transfer-quantity" data-report-label="Transfer">${renderTransferQuantity(movement)}</span>
          <span class="stock-pill stock-quantity report-qty-remaining" data-report-label="Remaining">${qty.toLocaleString('en-PH')} ${escapeHtml(product.unit || 'unit')}</span>
          <span class="stock-pill report-stock-status ${status.className}" data-report-label="Status">${status.label}</span>
        </div>
      </div>`;
    }).join('') || '<div class="empty-state"><p>No products found</p><small>Try adjusting your search query.</small></div>'}
  `;
}

const STAFF_MENU_DEFS = {
  pos: {
    key: 'pos',
    label: 'POS',
    fullName: 'Point of Sale',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>'
  },
  products: {
    key: 'products',
    label: 'Products',
    fullName: 'Product Registration',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>'
  },
  inventory: {
    key: 'inventory',
    label: 'Inventory',
    fullName: 'Inventory Stock',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>'
  },
  transfers: {
    key: 'transfers',
    label: 'Transfers',
    fullName: 'Stock Transfers',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>'
  },
  customers: {
    key: 'customers',
    label: 'Customers',
    fullName: 'Customers',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>'
  },
  credits: {
    key: 'credits',
    label: 'Credits',
    fullName: 'Credit History',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>'
  },
  sales: {
    key: 'sales',
    label: 'Sales',
    fullName: 'Sales History',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>'
  },
  inventoryReports: {
    key: 'inventoryReports',
    label: 'Reports',
    fullName: 'Inventory Reports',
    icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>'
  },
  dailySpotCash: { key: 'dailySpotCash', label: 'Spot Cash', fullName: 'Daily Spot Cash', icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18v12H3z"/><path d="M7 7V5a5 5 0 0 1 10 0v2"/></svg>' },
  dailyExpenses: { key: 'dailyExpenses', label: 'Expenses', fullName: 'Daily Expenses', icon: '<svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/></svg>' }
};

function renderStaffPermissions(permissions = []) {
  if (!permissions || !permissions.length) {
    return `<span class="menu-chip menu-chip-none"><svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>No menus</span>`;
  }
  const allKeys = Object.keys(STAFF_MENU_DEFS);
  const isAll = permissions.includes('*') || allKeys.every((key) => permissions.includes(key));
  if (isAll) {
    return `<span class="menu-chip menu-chip-all" title="Full access: All 8 menus permitted"><svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg><span>All Menus</span><span class="menu-chip-all-count">8</span></span>`;
  }
  return permissions.map((perm) => {
    const def = STAFF_MENU_DEFS[perm];
    if (!def) return `<span class="menu-chip">${escapeHtml(perm)}</span>`;
    return `<span class="menu-chip menu-chip-${def.key}" title="${escapeHtml(def.fullName)}">${def.icon}<span>${escapeHtml(def.label)}</span></span>`;
  }).join('');
}

function renderStaffAccounts() {
  const table = $('#inventoryTable');
  if (!table) return;
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const rows = sortByName_(staffAccounts.filter((staff) => `${staff.fullName} ${staff.username}`.toLowerCase().includes(term)), 'fullName');
  table.innerHTML = `
    <div class="table-row table-header"><span>Staff Account</span><span>Assigned Branch</span><span>Menu Access</span><span>Status</span><span>Action</span></div>
    ${rows.map((staff) => {
      const branch = branches.find((item) => item.id === staff.branchId);
      return `<div class="table-row">
        <div class="product-cell"><strong class="product-name">${escapeHtml(staff.fullName)}</strong><span class="product-meta">${escapeHtml(staff.username)}${staff.lastLogin ? ` • Last login ${formatDateTime(staff.lastLogin)}` : ' • Not yet signed in'}</span></div>
        <div class="row-middle-cells">
          <span class="category-badge">${escapeHtml(branch?.name || 'Unavailable branch')}</span>
          <span class="account-permissions">${renderStaffPermissions(staff.permissions)}</span>
          <span class="stock-pill ${staff.status === 'Active' ? 'stock-normal' : 'stock-low'}">${escapeHtml(staff.status)}</span>
        </div>
        <div class="row-action-cell"><span class="table-actions">
          <button class="icon-button" data-edit-staff="${staff.id}" aria-label="Edit ${escapeHtml(staff.fullName)}" title="Edit staff account"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
          <button class="icon-button primary-icon" data-reset-staff="${staff.id}" aria-label="Reset password for ${escapeHtml(staff.fullName)}" title="Reset password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg></button>
          <button class="icon-button ${staff.status === 'Active' ? 'danger-icon' : 'primary-icon'}" data-toggle-staff="${staff.id}" aria-label="${staff.status === 'Active' ? 'Deactivate' : 'Reactivate'} ${escapeHtml(staff.fullName)}" title="${staff.status === 'Active' ? 'Deactivate' : 'Reactivate'} account"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${staff.status === 'Active' ? '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="m17 8 5 5m0-5-5 5"/>' : '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="m16 12 2 2 4-4"/>'}</svg></button>
        </span></div></div>`;
    }).join('') || '<div class="empty-state"><p>No staff accounts found</p><small>Add a staff account to assign a branch and allowed menus.</small></div>'}
  `;
  table.querySelectorAll('[data-edit-staff]').forEach((button) => button.addEventListener('click', () => openForm('editStaff', button.dataset.editStaff)));
  table.querySelectorAll('[data-toggle-staff]').forEach((button) => button.addEventListener('click', () => toggleStaffStatus(button.dataset.toggleStaff)));
  table.querySelectorAll('[data-reset-staff]').forEach((button) => button.addEventListener('click', () => resetStaffPassword(button.dataset.resetStaff)));
}

function renderAdminAccount() {
  const panel = $('#accountProfilePanel');
  const table = $('#inventoryTable');
  if (!panel || !table) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="backup-restore-container">
      <div class="backup-info-col">
        <div class="backup-header-line">
          <span class="eyebrow">SYSTEM OPERATIONS</span>
          <span class="backup-status-pill">
            <span class="backup-pulse-dot"></span>
            System Ready
          </span>
        </div>
        <div class="backup-title-wrap">
          <div class="backup-icon-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </div>
          <div>
            <h3>Backup &amp; Restore Operations</h3>
            <p>Export or restore operational records (products, stock levels, transactions, customers, transfers). Administrator accounts, passwords, and audit history remain secured and untouched.</p>
          </div>
        </div>
        <div class="backup-tags-row">
          <span class="backup-tag">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            JSON Snapshot
          </span>
          <span class="backup-tag">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/></svg>
            Admin Credentials Preserved
          </span>
          <span class="backup-tag">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
            Instant Sync
          </span>
        </div>
      </div>
      <div class="backup-actions-col">
        <button class="backup-action-card backup-download-card" id="downloadBackupButton" type="button" title="Download current operational database snapshot">
          <div class="backup-card-icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </div>
          <div class="backup-card-details">
            <span class="backup-card-heading">Download Backup</span>
            <span class="backup-card-caption">Export full operational dataset</span>
          </div>
          <svg class="backup-card-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
        <button class="backup-action-card backup-restore-card" id="restoreBackupButton" type="button" title="Upload and restore a JSON database backup">
          <div class="backup-card-icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div class="backup-card-details">
            <span class="backup-card-heading">Restore Backup</span>
            <span class="backup-card-caption">Upload &amp; verify JSON file</span>
          </div>
          <svg class="backup-card-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
        <input id="restoreBackupFile" type="file" accept="application/json,.json" hidden>
      </div>
    </div>
  `;
  table.innerHTML = `<div class="table-row table-header"><span>Administrator</span><span>Username</span><span>Access</span><span>Status</span><span>Action</span></div>${sortByName_(adminAccounts, 'fullName').map((account) => `<div class="table-row">
    <div class="product-cell"><strong class="product-name">${escapeHtml(account.fullName)}</strong><span class="product-meta">Administrator account</span></div>
    <div class="row-middle-cells">
      <span>${escapeHtml(account.username)}</span>
      <span class="account-permissions"><span class="menu-chip menu-chip-all" title="Full system access across all branches and menus"><svg class="menu-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg><span>All branches &amp; menus</span></span></span>
      <span class="stock-pill ${account.status === 'Active' ? 'stock-normal' : 'stock-low'}">${escapeHtml(account.status)}</span>
    </div>
    <div class="row-action-cell"><span class="table-actions"><button class="icon-button" data-edit-admin="${account.id}" aria-label="Edit ${escapeHtml(account.fullName)}" title="Edit administrator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>${account.id !== currentSession?.account?.id ? `<button class="icon-button ${account.status === 'Active' ? 'danger-icon' : 'primary-icon'}" data-toggle-admin="${account.id}" aria-label="${account.status === 'Active' ? 'Deactivate' : 'Reactivate'} ${escapeHtml(account.fullName)}" title="${account.status === 'Active' ? 'Deactivate administrator' : 'Reactivate administrator'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${account.status === 'Active' ? '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="m17 8 5 5m0-5-5 5"/>' : '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="m16 12 2 2 4-4"/>'}</svg></button>` : ''}</span></div>
  </div>`).join('') || '<div class="empty-state"><p>No administrator accounts found</p></div>'}`;
  table.querySelectorAll('[data-edit-admin]').forEach((button) => button.addEventListener('click', () => openForm('editAdmin', button.dataset.editAdmin)));
  table.querySelectorAll('[data-toggle-admin]').forEach((button) => button.addEventListener('click', () => toggleAdminStatus(button.dataset.toggleAdmin)));
  $('#downloadBackupButton')?.addEventListener('click', downloadOperationalBackup);
  $('#restoreBackupButton')?.addEventListener('click', () => $('#restoreBackupFile')?.click());
  $('#restoreBackupFile')?.addEventListener('change', restoreOperationalBackup);
}

async function downloadOperationalBackup() {
  const button = $('#downloadBackupButton');
  if (button) button.disabled = true;
  try {
    const backup = await api('createOperationalBackup');
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `caishen-enterprises-backup-${backup.createdAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Operational backup downloaded.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to create the backup.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function restoreOperationalBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    showToast('Choose a valid JSON backup file.', 'error');
    return;
  }
  if (backup?.schemaVersion !== '1' || !backup?.tables) {
    showToast('Choose a valid Caishen Enterprises POS backup file.', 'error');
    return;
  }
  const confirmed = await askConfirmation({
    title: 'Restore Operational Backup',
    eyebrow: 'ADMINISTRATION',
    subtitle: 'Replace current POS records',
    message: `Restore the backup created <strong>${escapeHtml(formatDateTime(backup.createdAt))}</strong>?`,
    warning: 'Current products, inventory, customers, sales, payments, and transfers will be replaced. Administrator accounts and passwords will not change.',
    confirmText: 'Restore Backup',
    confirmType: 'danger',
  });
  if (!confirmed) return;
  try {
    await api('restoreOperationalBackup', { backup, confirmation: 'RESTORE' });
    showToast('Operational backup restored.', 'success');
    await refresh();
  } catch (error) {
    showToast(error.message || 'Unable to restore the backup.', 'error');
  }
}

function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }); }

async function toggleStaffStatus(staffId) {
  const staff = staffAccounts.find((item) => item.id === staffId); if (!staff) return;
  const activating = staff.status !== 'Active';
  const confirmed = await askConfirmation({ title: `${activating ? 'Reactivate' : 'Deactivate'} Staff`, eyebrow: 'STAFF ACCOUNTS', subtitle: 'Confirm account access change', message: `${activating ? 'Restore' : 'Remove'} sign-in access for <strong class="confirm-highlight-name">${escapeHtml(staff.fullName)}</strong>?`, warning: activating ? 'The staff member can sign in again.' : 'New sign-ins are blocked and the account immediately loses application access.', confirmText: activating ? 'Reactivate' : 'Deactivate', confirmType: activating ? 'primary' : 'danger' });
  if (!confirmed) return;
  try {
    await api('setStaffAccountStatus', { staffId, status: activating ? 'Active' : 'Inactive' });
    // Optimistic: flip status in local staffAccounts and re-render
    staffAccounts = staffAccounts.map((s) => s.id === staffId ? { ...s, status: activating ? 'Active' : 'Inactive' } : s);
    renderInventory();
    showToast(`Staff account ${activating ? 'reactivated' : 'deactivated'}.`, 'success');
    backgroundRefresh();
  } catch (error) { showToast(error.message, 'error'); }
}

function resetStaffPassword(staffId) {
  openForm('resetStaff', staffId);
}

async function saveAdminAccount(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  try { const account = await api('updateAdminAccount', Object.fromEntries(form)); currentSession.account = { ...currentSession.account, ...account }; localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(currentSession)); adminAccount = account; showToast('Administrator profile updated.', 'success'); } catch (error) { showToast(error.message, 'error'); }
}

async function changeOwnPassword() {
  const form = new FormData($('#adminAccountForm'));
  if (!form.get('currentPassword') || !form.get('newPassword')) { showToast('Enter your current and new password.', 'error'); return; }
  const confirmed = await askConfirmation({ title: 'Change Password', eyebrow: 'ADMINISTRATION', subtitle: 'Confirm security update', message: 'Are you sure you want to change your administrator password?', confirmText: 'Change Password', confirmType: 'primary' });
  if (!confirmed) return;
  try { await api('changeOwnPassword', { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }); $('#adminAccountForm').querySelectorAll('[type="password"]').forEach((input) => { input.value = ''; }); showToast('Password changed successfully.', 'success'); } catch (error) { showToast(error.message, 'error'); }
}

async function toggleAdminStatus(adminId) {
  const account = adminAccounts.find((item) => item.id === adminId); if (!account) return;
  const activating = account.status !== 'Active';
  const confirmed = await askConfirmation({ title: `${activating ? 'Reactivate' : 'Deactivate'} Administrator`, eyebrow: 'ADMINISTRATION', subtitle: 'Confirm administrator access', message: `${activating ? 'Restore' : 'Remove'} full system access for <strong class="confirm-highlight-name">${escapeHtml(account.fullName)}</strong>?`, warning: activating ? 'This administrator can sign in again.' : 'New sign-ins are blocked and the account immediately loses application access.', confirmText: activating ? 'Reactivate' : 'Deactivate', confirmType: activating ? 'primary' : 'danger' });
  if (!confirmed) return;
  try {
    await api('setAdminAccountStatus', { adminId, status: activating ? 'Active' : 'Inactive' });
    // Optimistic: flip status in local adminAccounts and re-render
    adminAccounts = adminAccounts.map((a) => a.id === adminId ? { ...a, status: activating ? 'Active' : 'Inactive' } : a);
    renderInventory();
    showToast(`Administrator ${activating ? 'reactivated' : 'deactivated'}.`, 'success');
    backgroundRefresh();
  } catch (error) { showToast(error.message, 'error'); }
}

function renderDashboard() {
  const dashboard = $('#dashboard');
  if (!dashboard) return;
  const completedSales = salesHistory.filter((sale) => String(sale.status || 'completed').toLowerCase() !== 'cancelled');
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
    return {
      key: formatDateInput(date),
      label: date.toLocaleDateString('en-PH', { weekday: 'short' }),
      dateFormatted: date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
      total: 0,
      transactions: 0
    };
  });
  const dayMap = Object.fromEntries(days.map((day) => [day.key, day]));
  completedSales.forEach((sale) => {
    const day = dayMap[saleDateKey(sale.date)];
    if (day) { day.total += Number(sale.total || 0); day.transactions += 1; }
  });
  const periodSalesRecords = completedSales.filter((sale) => dayMap[saleDateKey(sale.date)]);
  const todayKey = formatDateInput(today);
  const todaySalesRecords = completedSales.filter((sale) => saleDateKey(sale.date) === todayKey);
  const todaySales = todaySalesRecords.reduce((total, sale) => total + Number(sale.total || 0), 0);
  const todayCashCollected = todaySalesRecords.filter((sale) => sale.paymentType === 'cash').reduce((total, sale) => total + Number(sale.total || 0), 0);
  const todayDiscount = todaySalesRecords.reduce((total, sale) => total + Number(sale.discount || 0), 0);
  const todayCreditSales = todaySalesRecords.filter((sale) => sale.paymentType === 'credit').reduce((total, sale) => total + Number(sale.total || 0), 0);
  const creditOutstanding = creditAccounts.reduce((total, account) => total + Number(account.balance || 0), 0);

  const todayExpenses = dailyExpenses
    .filter((item) => item.businessDate === todayKey)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const todayExpenseRecords = dailyExpenses.filter((item) => item.businessDate === todayKey);
  const todaySpotCash = dailySpotCash
    .filter((item) => item.businessDate === todayKey)
    .reduce((sum, item) => sum + Number(item.openingCash || 0), 0);
  const todayCashOnHand = todayCashCollected + todaySpotCash - todayExpenses;
  const todayNetSales = Math.max(todaySales - todayExpenses, 0);
  const todayNetIncome = todayNetSales * 0.20;

  const sevenDayTotal = days.reduce((sum, d) => sum + d.total, 0);
  const sevenDayAvg = Math.round(sevenDayTotal / 7);
  const todayAvgTicket = todaySalesRecords.length > 0 ? Math.round(todaySales / todaySalesRecords.length) : 0;
  const cashRatio = todaySales > 0 ? Math.min(Math.round((todayCashCollected / todaySales) * 100), 100) : 0;

  const maxDayTotal = Math.max(...days.map((day) => day.total), 1);
  const productTotals = new Map();
  periodSalesRecords.forEach((sale) => (sale.items || []).forEach((item) => {
    const current = productTotals.get(item.productId) || { id: item.productId, name: item.name, unit: item.unit, qty: 0, total: 0 };
    current.qty += Number(item.qty || 0);
    current.total += Number(item.qty || 0) * Number(item.price || 0);
    productTotals.set(item.productId, current);
  }));
  const topProducts = [...productTotals.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)).slice(0, 5);
  const maxProductQty = topProducts.length > 0 ? Math.max(...topProducts.map((p) => p.qty), 1) : 1;

  const lowStockItems = products
    .filter((item) => item.status === 'Active' && Number(item.qty) <= Number(item.lowStockLevel || 0))
    .sort((a, b) => Number(a.qty) - Number(b.qty) || a.name.localeCompare(b.name));
  const outOfStockCount = lowStockItems.filter((item) => Number(item.qty) <= 0).length;
  const lowStockCount = lowStockItems.filter((item) => Number(item.qty) > 0).length;
  const attentionStock = lowStockItems.slice(0, 5);
  const pendingTransfers = transfers
    .filter((item) => !['Received', 'Cancelled'].includes(item.status))
    .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
    .slice(0, 5);
  const recentSales = [...completedSales]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 5);
  const branchName = branches.find((branch) => branch.id === activeBranchId)?.name || 'Selected Branch';
  const permissions = currentSession?.account?.permissions || ['*'];
  const canAccess = (view) => permissions.includes('*') || permissions.includes(view);

  const todayFormatted = today.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const getCustomerInitials = (name) => {
    const clean = displayCustomerName(name).replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (!clean || clean.toLowerCase() === 'walk-in customer') return 'WC';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  dashboard.innerHTML = `
    <div class="dashboard-header-banner">
      <div class="dashboard-title-area">
        <div class="dashboard-eyebrow-row">
          <span class="dashboard-live-pill">
            <span class="pulse-dot"></span>
            <span>LIVE OPERATIONS</span>
          </span>
          <span class="dashboard-date-chip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
            <span>${escapeHtml(todayFormatted)}</span>
          </span>
        </div>
        <h2 class="dashboard-main-title">${escapeHtml(branchName)} Dashboard</h2>
        <p class="dashboard-main-sub">Real-time revenue metrics, product velocity, and operational stock alerts.</p>
      </div>
      <div class="dashboard-quick-actions">
        <button class="button button-secondary dashboard-action-btn dashboard-refresh-btn" type="button" data-dashboard-action="refresh" title="Refresh dashboard data" aria-label="Refresh dashboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <div class="dashboard-summary-grid">
      <article class="dashboard-kpi-card kpi-revenue" data-dashboard-view="sales" role="button" tabindex="0" title="Click to view sales history">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-blue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <span class="kpi-badge badge-blue">${todaySalesRecords.length} order${todaySalesRecords.length === 1 ? '' : 's'} today</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Today's Gross Sales</span>
          <strong class="kpi-value text-glow-blue">${money(todaySales)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Today's Discount: <b>${money(todayDiscount)}</b></span>
          <span class="kpi-foot-link">Ledger &rarr;</span>
        </div>
      </article>

      <article class="dashboard-kpi-card kpi-cash" data-dashboard-view="sales" role="button" tabindex="0" title="Click to view sales records">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-emerald">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
          </div>
          <span class="kpi-badge badge-emerald">${cashRatio}% cash share</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Cash Collected</span>
          <strong class="kpi-value text-success">${money(todayCashCollected)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Today's Credit: <b>${money(todayCreditSales)}</b></span>
          <span class="kpi-foot-link">Details &rarr;</span>
        </div>
      </article>

      ${canAccess('credits') ? `
        <article class="dashboard-kpi-card kpi-credit" data-dashboard-view="credits" role="button" tabindex="0" title="Click to manage credit accounts">
          <div class="kpi-head">
            <div class="kpi-icon-wrap icon-amber">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
            </div>
            <span class="kpi-badge badge-amber">${creditAccounts.length} customer${creditAccounts.length === 1 ? '' : 's'}</span>
          </div>
          <div class="kpi-body">
            <span class="kpi-label">Credit Receivables</span>
            <strong class="kpi-value text-amber">${money(creditOutstanding)}</strong>
          </div>
          <div class="kpi-foot">
            <span class="kpi-foot-sub">Outstanding balance due</span>
            <span class="kpi-foot-link">Manage &rarr;</span>
          </div>
        </article>
      ` : ''}

      ${canAccess('inventory') ? `
        <article class="dashboard-kpi-card kpi-stock" data-dashboard-view="inventory" role="button" tabindex="0" title="Click to audit branch inventory">
          <div class="kpi-head">
            <div class="kpi-icon-wrap icon-rose">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
            </div>
            <span class="kpi-badge badge-rose">${outOfStockCount > 0 ? `${outOfStockCount} zero stock` : 'Low warnings'}</span>
          </div>
          <div class="kpi-body">
            <span class="kpi-label">Stock Attention</span>
            <strong class="kpi-value text-danger">${lowStockItems.length} <small style="font-size:13px;font-weight:600;color:var(--text-muted);">items</small></strong>
          </div>
          <div class="kpi-foot">
            <span class="kpi-foot-sub">${outOfStockCount} out of stock &bull; ${lowStockCount} low</span>
            <span class="kpi-foot-link">Audit &rarr;</span>
          </div>
        </article>
      ` : ''}

      <article class="dashboard-kpi-card kpi-cashonhand" data-dashboard-view="dailySpotCash" role="button" tabindex="0" title="Click to view spot cash operations">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-cyan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 7h20v14H2z"/><path d="M16 14a4 4 0 0 1-8 0"/><path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3"/></svg>
          </div>
          <span class="kpi-badge badge-cyan">Liquid Cash</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Cash Collected + Today's Spot Cash - Expenses</span>
          <strong class="kpi-value text-cyan">${money(todayCashOnHand)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Cash collected + opening float - expenses</span>
          <span class="kpi-foot-link">Float &rarr;</span>
        </div>
      </article>

      <article class="dashboard-kpi-card kpi-expense" data-dashboard-view="dailyExpenses" role="button" tabindex="0" title="Click to view daily expenses">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-rose">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v12"/></svg>
          </div>
          <span class="kpi-badge badge-rose">${todayExpenseRecords.length} record${todayExpenseRecords.length === 1 ? '' : 's'}</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Today's Expenses</span>
          <strong class="kpi-value text-danger">${money(todayExpenses)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Operational spend</span>
          <span class="kpi-foot-link">Manage &rarr;</span>
        </div>
      </article>

      <article class="dashboard-kpi-card kpi-netsales" data-dashboard-view="dailySpotCash" role="button" tabindex="0" title="Click to view spot cash operations">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-purple">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
          </div>
          <span class="kpi-badge badge-purple">Opening Float</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Today's Spot Cash</span>
          <strong class="kpi-value text-purple">${money(todaySpotCash)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Opening cash before operations</span>
          <span class="kpi-foot-link">Float &rarr;</span>
        </div>
      </article>

      <article class="dashboard-kpi-card kpi-income" data-dashboard-view="inventoryReports" role="button" tabindex="0" title="Click to view financial & sales reports">
        <div class="kpi-head">
          <div class="kpi-icon-wrap icon-teal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v12"/></svg>
          </div>
          <span class="kpi-badge badge-teal">20% Margin</span>
        </div>
        <div class="kpi-body">
          <span class="kpi-label">Today's Income</span>
          <strong class="kpi-value text-teal">${money(todayNetIncome)}</strong>
        </div>
        <div class="kpi-foot">
          <span class="kpi-foot-sub">Net sales &times; 20%</span>
          <span class="kpi-foot-link">Report &rarr;</span>
        </div>
      </article>
    </div>

    <div class="dashboard-main-grid">
      <section class="dashboard-panel dashboard-sales-panel">
        <div class="dashboard-panel-head">
          <div class="panel-head-titles">
            <span class="panel-eyebrow">REVENUE VELOCITY</span>
            <h3>Daily Sales Trend</h3>
          </div>
          <div class="sales-chart-legend">
            <span class="chart-summary-chip">7-Day Total: <strong>${money(sevenDayTotal)}</strong></span>
            <span class="chart-avg-pill">Avg: ${money(sevenDayAvg)}/day</span>
          </div>
        </div>
        <div class="sales-chart-wrapper">
          <div class="sales-chart" role="img" aria-label="Daily sales trend for the past seven days">
            ${days.map((day) => {
              const isToday = day.key === todayKey;
              const isPeak = day.total === maxDayTotal && day.total > 0;
              const hasSales = day.total > 0;
              const barHeightPct = hasSales ? Math.max(Math.round((day.total / maxDayTotal) * 92), 6) : 3;
              return `
                <div class="sales-chart-col${isToday ? ' is-today' : ''}${isPeak ? ' is-peak' : ''}${!hasSales ? ' is-empty' : ''}">
                  <div class="sales-chart-tooltip" role="tooltip">
                    <span class="tooltip-date">${escapeHtml(day.label)}, ${escapeHtml(day.dateFormatted)}</span>
                    <strong class="tooltip-amount">${money(day.total)}</strong>
                    <span class="tooltip-tx">${day.transactions} transaction${day.transactions === 1 ? '' : 's'}</span>
                  </div>
                  <div class="sales-chart-track">
                    <div class="sales-chart-bar${!hasSales ? ' bar-empty' : ''}" style="${hasSales ? `height:${barHeightPct}%` : ''}" aria-valuenow="${day.total}" aria-label="${escapeHtml(day.label)}: ${money(day.total)}">
                      ${isPeak ? '<span class="peak-badge">PEAK</span>' : ''}
                    </div>
                  </div>
                  <div class="sales-chart-col-foot">
                    <span class="sales-chart-label">${escapeHtml(day.label)}</span>
                    ${isToday ? '<span class="today-marker-dot" title="Today"></span>' : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </section>

      <section class="dashboard-panel">
        <div class="dashboard-panel-head">
          <div class="panel-head-titles">
            <span class="panel-eyebrow">PRODUCT MOVEMENT</span>
            <h3>Top Moving Products</h3>
          </div>
          <span class="dashboard-period-badge">Past 7 Days</span>
        </div>
        <div class="dashboard-top-list">
          ${topProducts.length ? topProducts.map((product, index) => {
            const rankClass = index === 0 ? 'rank-gold' : index === 1 ? 'rank-silver' : index === 2 ? 'rank-bronze' : 'rank-standard';
            const progressPct = Math.max(Math.round((product.qty / maxProductQty) * 100), 10);
            return `
              <div class="dashboard-prod-row">
                <div class="dashboard-rank ${rankClass}">${index + 1}</div>
                <div class="dashboard-prod-info">
                  <div class="dashboard-prod-top-line">
                    <strong class="dashboard-prod-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</strong>
                    <span class="dashboard-prod-qty">${product.qty} <small>${escapeHtml(product.unit || 'unit')}</small></span>
                  </div>
                  <div class="dashboard-progress-track">
                    <div class="dashboard-progress-bar ${rankClass}" style="width:${progressPct}%"></div>
                  </div>
                  <div class="dashboard-prod-sub-line">
                    <span class="dashboard-prod-sales-val">${money(product.total)} sales contribution</span>
                  </div>
                </div>
              </div>
            `;
          }).join('') : `
            <div class="dashboard-empty-panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>
              <p>No completed sales recorded in this branch yet.</p>
              <small>Sales transactions will automatically populate product volume rankings.</small>
            </div>
          `}
        </div>
      </section>
    </div>

    <div class="dashboard-bottom-grid">
      ${canAccess('inventory') ? `
        <section class="dashboard-panel">
          <div class="dashboard-panel-head">
            <div class="panel-head-titles">
              <span class="panel-eyebrow">CRITICAL INVENTORY</span>
              <h3>Stock Warnings</h3>
            </div>
            <button class="dashboard-text-link" type="button" data-dashboard-view="inventory">Open inventory &rarr;</button>
          </div>
          <div class="dashboard-feed-list">
            ${attentionStock.length ? attentionStock.map((product) => `
              <div class="dashboard-feed-item">
                <div class="dashboard-feed-item-icon warning-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                </div>
                <div class="dashboard-feed-details">
                  <strong class="dashboard-feed-title" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</strong>
                  <span class="dashboard-feed-sub">${product.qty} ${escapeHtml(product.unit || 'unit')} in stock</span>
                </div>
                <span class="stock-pill ${product.qty <= 0 ? 'stock-low' : 'stock-quantity'}" style="${product.qty <= 0 ? 'background:rgba(227,41,52,0.18);color:#ff4d5a;border-color:rgba(227,41,52,0.4);' : 'background:rgba(245,158,11,0.18);color:#fbbf24;border-color:rgba(245,158,11,0.4);'}">
                  ${product.qty <= 0 ? 'Out of stock' : 'Low stock'}
                </span>
              </div>
            `).join('') : `
              <div class="dashboard-empty-feed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                <p>All items are safely above minimum stock levels.</p>
              </div>
            `}
          </div>
        </section>
      ` : ''}

      ${canAccess('transfers') ? `
        <section class="dashboard-panel">
          <div class="dashboard-panel-head">
            <div class="panel-head-titles">
              <span class="panel-eyebrow">BRANCH LOGISTICS</span>
              <h3>Pending Transfers</h3>
            </div>
            <button class="dashboard-text-link" type="button" data-dashboard-view="transfers">View transfers &rarr;</button>
          </div>
          <div class="dashboard-feed-list">
            ${pendingTransfers.length ? pendingTransfers.map((transfer) => `
              <div class="dashboard-feed-item">
                <div class="dashboard-feed-item-icon transfer-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>
                </div>
                <div class="dashboard-feed-details">
                  <strong class="dashboard-feed-title" title="${escapeHtml(transfer.productName || 'Transfer')}">${escapeHtml(transfer.productName || 'Transfer')}</strong>
                  <span class="dashboard-feed-sub">${escapeHtml(transfer.sourceBranchName)} &rarr; ${escapeHtml(transfer.destinationBranchName)} &bull; ${transfer.qty} ${escapeHtml(transfer.unit || 'unit')}</span>
                </div>
                <span class="stock-pill stock-quantity" style="${transfer.status === 'In Transit' ? 'background:rgba(0,102,245,0.18);color:#38bdf8;border-color:rgba(0,102,245,0.4);' : ''}">
                  ${escapeHtml(transfer.status)}
                </span>
              </div>
            `).join('') : `
              <div class="dashboard-empty-feed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                <p>No active stock transfers currently pending.</p>
              </div>
            `}
          </div>
        </section>
      ` : ''}

      <section class="dashboard-panel">
        <div class="dashboard-panel-head">
          <div class="panel-head-titles">
            <span class="panel-eyebrow">LIVE ACTIVITY</span>
            <h3>Latest Completed Sales</h3>
          </div>
          <button class="dashboard-text-link" type="button" data-dashboard-view="sales">View all &rarr;</button>
        </div>
        <div class="dashboard-feed-list">
          ${recentSales.length ? recentSales.map((sale) => {
            const isCash = sale.paymentType === 'cash';
            const initials = getCustomerInitials(sale.customerName);
            const timeStr = sale.date ? new Date(sale.date).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
            return `
              <div class="dashboard-feed-item">
                <div class="dashboard-avatar-badge">${escapeHtml(initials)}</div>
                <div class="dashboard-feed-details">
                  <div class="dashboard-feed-customer-line">
                    <strong class="dashboard-feed-title" title="${escapeHtml(displayCustomerName(sale.customerName))}">${escapeHtml(displayCustomerName(sale.customerName))}</strong>
                    <span class="dashboard-payment-pill ${isCash ? 'is-cash' : 'is-credit'}">${isCash ? 'Cash' : 'Credit'}</span>
                  </div>
                  <span class="dashboard-feed-sub">${escapeHtml(sale.saleId)} &bull; ${escapeHtml(timeStr)}</span>
                </div>
                <strong class="dashboard-sale-amount">${money(sale.total)}</strong>
              </div>
            `;
          }).join('') : `
            <div class="dashboard-empty-feed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              <p>No completed sales recorded for this branch yet.</p>
            </div>
          `}
        </div>
      </section>
    </div>
  `;

  // Interactive bindings
  dashboard.querySelectorAll('[data-dashboard-view]').forEach((elem) => {
    elem.addEventListener('click', () => setView(elem.dataset.dashboardView));
    if (elem.classList.contains('dashboard-kpi-card')) {
      elem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setView(elem.dataset.dashboardView);
        }
      });
    }
  });

  dashboard.querySelectorAll('[data-dashboard-action="stockIn"]').forEach((btn) => {
    btn.addEventListener('click', () => openForm('stock'));
  });

  dashboard.querySelectorAll('[data-dashboard-action="refresh"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.classList.add('is-spinning');
      showToast('Refreshing dashboard data...', 'info');
      try {
        await refresh();
        showToast('Dashboard updated with latest data.', 'success');
      } catch (err) {
        showToast(err.message || 'Failed to refresh.', 'error');
      } finally {
        btn.classList.remove('is-spinning');
        btn.disabled = false;
      }
    });
  });
}

function renderDashboardSkeleton() {
  const dashboard = $('#dashboard');
  if (!dashboard) return;
  dashboard.innerHTML = `
    <div class="dashboard-skeleton">
      <div class="dashboard-skeleton-header">
        <div class="skeleton-shimmer dashboard-skeleton-eyebrow"></div>
        <div class="skeleton-shimmer dashboard-skeleton-title"></div>
        <div class="skeleton-shimmer dashboard-skeleton-sub"></div>
      </div>
      <div class="dashboard-summary-grid">
        ${Array.from({ length: 8 }).map(() => `
          <div class="dashboard-skeleton-card">
            <div class="skeleton-shimmer dashboard-skeleton-icon"></div>
            <div class="skeleton-shimmer dashboard-skeleton-val"></div>
            <div class="skeleton-shimmer dashboard-skeleton-label"></div>
            <div class="skeleton-shimmer dashboard-skeleton-footer"></div>
          </div>
        `).join('')}
      </div>
      <div class="dashboard-main-grid">
        <div class="dashboard-skeleton-panel sales-panel-skeleton">
          <div class="skeleton-shimmer skeleton-panel-head"></div>
          <div class="skeleton-chart-tracks">
            ${[40, 75, 55, 90, 60, 85, 45].map((h) => `
              <div class="skeleton-chart-col">
                <div class="skeleton-shimmer skeleton-chart-bar" style="height:${h}%;"></div>
                <div class="skeleton-shimmer skeleton-chart-label"></div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="dashboard-skeleton-panel products-panel-skeleton">
          <div class="skeleton-shimmer skeleton-panel-head"></div>
          <div class="skeleton-prod-rows">
            ${Array.from({ length: 5 }).map(() => `
              <div class="skeleton-prod-row">
                <div class="skeleton-shimmer skeleton-rank-box"></div>
                <div class="skeleton-prod-info-box">
                  <div class="skeleton-shimmer skeleton-prod-line1"></div>
                  <div class="skeleton-shimmer skeleton-prod-bar"></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="dashboard-bottom-grid">
        ${Array.from({ length: 3 }).map(() => `
          <div class="dashboard-skeleton-panel feed-panel-skeleton">
            <div class="skeleton-shimmer skeleton-panel-head"></div>
            <div class="skeleton-feed-rows">
              ${Array.from({ length: 4 }).map(() => `
                <div class="skeleton-feed-row">
                  <div class="skeleton-shimmer skeleton-feed-avatar"></div>
                  <div class="skeleton-feed-text">
                    <div class="skeleton-shimmer skeleton-feed-line1"></div>
                    <div class="skeleton-shimmer skeleton-feed-line2"></div>
                  </div>
                  <div class="skeleton-shimmer skeleton-feed-badge"></div>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderInventory() {
  if (activeView === 'dashboard') { renderDashboard(); return; }
  if (activeView === 'bundleMonitoring') { renderBundleMonitoring(); return; }
  if (activeView === 'quarantine') { renderQuarantinedItems(); return; }
  if (activeView === 'quarantineReport') { renderQuarantineReport(); return; }
  if (activeView === 'inventoryReports') {
    renderInventoryReports();
    return;
  }
  if (activeView === 'branches') {
    renderBranches();
    return;
  }
  if (activeView === 'customers') {
    renderCustomers();
    return;
  }
  if (activeView === 'transfers') {
    renderTransfers();
    return;
  }
  if (activeView === 'credits') {
    renderCreditPayments();
    return;
  }
  if (activeView === 'sales') {
    renderSalesHistory();
    return;
  }
  if (activeView === 'dailySpotCash') {
    renderDailySpotCash();
    return;
  }
  if (activeView === 'dailyExpenses') { renderDailyExpenses(); return; }
  if (activeView === 'staffAccounts') { renderStaffAccounts(); return; }
  if (activeView === 'adminAccount') { renderAdminAccount(); return; }
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const rows = sortByName_(products.filter((product) => `${product.name} ${product.category} ${product.sku || ''}`.toLowerCase().includes(term)));
  const table = $('#inventoryTable');
  if (!table) return;

  const headers = activeView === 'products'
    ? ['Product', 'Category', 'Selling price', 'Quantity in stock', 'Low stock', 'Status', 'Action']
    : activeView === 'inventory'
    ? ['Product', 'Category', 'Current stock', 'Stock warning', 'Status']
    : ['Product', 'Selling price', 'Stock', 'Action'];

  const content = rows.map((product) => {
    const isOut = product.qty <= 0;
    const isLow = !isOut && product.qty <= product.lowStockLevel;
    const stockBadge = isOut
      ? `<span class="stock-pill stock-low">Out of stock</span>`
      : isLow
      ? `<span class="stock-pill stock-low">${product.qty} low</span>`
      : `<span class="stock-pill stock-normal">${product.qty} in stock</span>`;

    const statusPill = product.status === 'Active'
      ? `<span class="stock-pill stock-normal" style="font-size:11.5px;">Active</span>`
      : `<span class="stock-pill stock-low" style="font-size:11.5px;">Inactive</span>`;

    const lowStockPill = `
      <span class="low-stock-pill" title="Warning alert trigger: &le; ${product.lowStockLevel ?? 5} ${escapeHtml(product.unit || 'units')}">
        <svg class="pill-alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>&le; ${product.lowStockLevel ?? 5}</span>
      </span>
    `;

    const productCell = `
      <div class="product-cell">
        <strong class="product-name">${escapeHtml(product.name)}</strong>
        <span class="product-meta">${escapeHtml(product.sku || product.id)} &bull; ${product.productType === 'bundle' ? `Bundle / Set &bull; ${product.components?.length || 0} components` : escapeHtml(product.unit)}</span>
      </div>
    `;

    const categoryCell = `<span class="category-badge">${escapeHtml(product.category || 'General')}</span>`;
    const priceValue = hasSellingPriceOverride(product.sellingPriceOverride)
      ? `<span class="price-text">${money(product.sellingPriceOverride)}</span>`
      : product.qty > 0
      ? `<span class="price-text">${money(displayedSellingPrice(product))}</span>`
      : '<span class="price-text price-unset">Stock In required</span>';
    const tankInventory = product.tankInventory
      ? `<span class="bundle-tank-inventory" aria-label="Tank inventory"><span class="bundle-tank-count">Filled <b>${product.tankInventory.filled}</b></span><span class="bundle-tank-count is-empty">Empty <b>${product.tankInventory.empty}</b></span></span>`
      : '';
    const priceCell = `<span class="product-price-stack">${priceValue}${tankInventory}</span>`;
    const quantityCell = `<span class="stock-pill stock-quantity">${product.qty} ${escapeHtml(product.unit || 'unit')}</span>`;

    const productRow = `
      ${productCell}
      <div class="row-middle-cells">
        ${categoryCell}
        ${priceCell}
        ${quantityCell}
        <span>${lowStockPill}</span>
        <span>${statusPill}</span>
      </div>
      <div class="row-action-cell">
        <span class="table-actions">
          <button class="icon-button" data-edit="${product.id}" aria-label="Edit ${escapeHtml(product.name)}" title="Edit product"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
          <button class="icon-button primary-icon" data-product-price-override="${product.id}" aria-label="Override selling price for ${escapeHtml(product.name)}" title="Override selling price"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m20.6 13.4-7.2 7.2a2 2 0 0 1-2.8 0l-8.2-8.2A2 2 0 0 1 2 11V4a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l8.2 8.2a2 2 0 0 1 0 2.6Z"/><circle cx="7" cy="7" r="1"/></svg></button>
          ${currentSession?.account?.role !== 'staff' ? `<button class="icon-button danger-icon" data-delete="${product.id}" aria-label="Delete ${escapeHtml(product.name)}" title="Delete product"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>` : ''}
        </span>
      </div>
    `;

    const stockRow = `
      ${productCell}
      <div class="row-middle-cells">
        ${categoryCell}
        ${stockBadge}
        <span>${lowStockPill}</span>
        <span>${statusPill}</span>
      </div>
    `;

    const posRow = `
      ${productCell}
      <div class="row-middle-cells">
        ${priceCell}
        ${stockBadge}
      </div>
      <div class="row-action-cell">
        <button class="button button-primary add-item" data-add="${product.id}" aria-label="Add ${escapeHtml(product.name)} to cart" title="Add to cart" ${isOut || product.status !== 'Active' ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        </button>
      </div>
    `;

    const canAddToCart = activeView === 'pos' && !isOut && product.status === 'Active';
    const rowAttributes = canAddToCart ? ` pos-add-row" data-row-add="${product.id}" role="button" tabindex="0" aria-label="Add ${escapeHtml(product.name)} to cart` : '';
    return `<div class="table-row${rowAttributes}">${activeView === 'products' ? productRow : activeView === 'inventory' ? stockRow : posRow}</div>`;
  }).join('');

  table.innerHTML = `
    <div class="table-row table-header">
      ${headers.map((header) => `<span>${header}</span>`).join('')}
    </div>
    ${content || '<div class="empty-state"><p>No products found</p><small>Try adjusting your search query</small></div>'}
  `;

  table.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.add)));
  table.querySelectorAll('[data-row-add]').forEach((row) => {
    const addRowProduct = () => addToCart(row.dataset.rowAdd);
    row.addEventListener('click', (event) => {
      if (!event.target.closest('button')) addRowProduct();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        addRowProduct();
      }
    });
  });
  table.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openForm('edit', button.dataset.edit)));
  table.querySelectorAll('[data-product-price-override]').forEach((button) => button.addEventListener('click', () => openProductPriceOverride(button.dataset.productPriceOverride)));
  table.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteProduct(button.dataset.delete)));
}

function renderBundleMonitoring() {
  const table = $('#inventoryTable');
  if (!table) return;
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const componentName = (component) => allProducts.find((product) => product.id === component.productId)?.name || component.productId;
  const bundles = sortByName_(products.filter((product) => product.productType === 'bundle' && `${product.name} ${product.components?.map(componentName).join(' ') || ''} ${product.sku || ''}`.toLowerCase().includes(term)));
  const tankIcon = (filled) => `<svg class="bundle-monitor-tank ${filled ? 'is-solid' : 'is-outline'}" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l2 4-2 14H7L5 7l2-4Z"/><path d="M5 7h14M9 3v4m6-4v4"/><path d="M9 12h6M9 16h6"/></svg>`;
  table.innerHTML = `
    ${bundles.map((bundle) => {
      const bundlePrice = hasSellingPriceOverride(bundle.sellingPriceOverride)
        ? Number(bundle.sellingPriceOverride)
        : (Number(bundle.qty || 0) > 0 || bundle.price ? displayedSellingPrice(bundle) : Number(bundle.price || 0));

      const components = (bundle.components || []).map((component) => {
        const compProduct = products.find((p) => p.id === component.productId) || allProducts.find((p) => p.id === component.productId);
        const compName = compProduct?.name || component.productId;
        const compStock = Number(compProduct?.qty ?? 0);
        const isOut = compStock <= 0;
        const isLow = !isOut && compStock <= Number(compProduct?.lowStockLevel || 5);
        const stockStatusClass = isOut ? 'is-out' : (isLow ? 'is-low' : 'is-good');
        const stockText = isOut ? '0 in stock' : `${compStock.toLocaleString('en-PH')} in stock`;

        return `
          <div class="bundle-component-row">
            <div class="bundle-comp-main">
              <span class="bundle-comp-dot"></span>
              <strong class="bundle-comp-name" title="${escapeHtml(compName)}">${escapeHtml(compName)}</strong>
              <span class="bundle-component-qty" title="Recipe requirement">&times;${component.qty}</span>
            </div>
            <span class="bundle-comp-stock ${stockStatusClass}" title="Current stock in this branch">
              <span class="bundle-comp-stock-dot"></span>
              <span>${stockText}</span>
            </span>
          </div>
        `;
      }).join('') || '<span class="bundle-no-components">No components configured</span>';
      const sets = Number(bundleAvailability[bundle.id] ?? bundle.qty ?? 0);
      const emptyShells = Math.max(0, Number(bundle.tankInventory?.empty || 0) - sets);
      const isZeroSets = sets === 0;
      return `
        <article class="bundle-monitor-card ${isZeroSets ? 'has-zero-sets' : ''}">
          <div class="bundle-monitor-card-header">
            <div class="bundle-monitor-header-left">
              <div class="bundle-monitor-icon-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M7 3h10l2 4-2 14H7L5 7l2-4Z"/><path d="M5 7h14M9 3v4m6-4v4"/><path d="M9 12h6M9 16h6"/>
                </svg>
              </div>
              <div class="bundle-monitor-title-block">
                <strong class="bundle-monitor-name" title="${escapeHtml(bundle.name)}">${escapeHtml(bundle.name)}</strong>
                <div class="bundle-monitor-meta">
                  <span class="bundle-sku-tag">${escapeHtml(bundle.sku || bundle.id)}</span>
                  <span class="bundle-type-pill">Bundle / Set</span>
                </div>
              </div>
            </div>
            <div class="bundle-monitor-price-box" title="Bundle set selling price">
              <span class="bundle-price-val">${money(bundlePrice)}</span>
              <span class="bundle-price-lbl">per set</span>
            </div>
          </div>
          <div class="bundle-monitor-body">
            <div class="bundle-components-label">Components (${bundle.components?.length || 0})</div>
            <div class="bundle-monitor-components">${components}</div>
          </div>
          <div class="bundle-monitor-metrics">
            <div class="bundle-monitor-stat stat-producible ${isZeroSets ? 'is-empty' : ''}" title="Sets that can be produced">
              <div class="bundle-stat-icon-wrap">
                ${tankIcon(true)}
              </div>
              <div class="bundle-stat-info">
                <strong class="bundle-stat-val">${sets.toLocaleString('en-PH')}</strong>
                <span class="bundle-stat-lbl">sets producible</span>
              </div>
            </div>
            <div class="bundle-monitor-stat stat-empty ${emptyShells === 0 ? 'is-zero' : ''}" title="Empty shells remaining after producible sets are reserved">
              <div class="bundle-stat-icon-wrap">
                ${tankIcon(false)}
              </div>
              <div class="bundle-stat-info">
                <strong class="bundle-stat-val">${emptyShells.toLocaleString('en-PH')}</strong>
                <span class="bundle-stat-lbl">empty shells left</span>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('') || '<div class="empty-state"><p>No bundles found</p><small>Create a Bundle / Set in Product Registration to monitor it here.</small></div>'}
  `;
}

function renderQuarantinedItems() {
  const table = $('#inventoryTable');
  if (!table) return;
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const pendingItemsByCase = inventoryQuarantineItems
    .filter((item) => item.resolution === 'quarantine')
    .reduce((itemsByCase, item) => {
      (itemsByCase[item.caseId] ||= []).push(item);
      return itemsByCase;
    }, {});
  const cases = inventoryQuarantineCases
    .filter((item) => pendingItemsByCase[item.id] && `${item.id} ${item.reference} ${item.sourceType} ${item.supplierReference} ${item.sourceBranchName} ${item.reason} ${item.status}`.toLowerCase().includes(term))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const sourceLabel = (source) => source === 'stock_in' ? 'Stock-In Receipt' : 'Stock Transfer Receipt';
  const resolutionLabel = (resolution) => ({ restocked: 'Restock', supplier_return: 'Return to Supplier', return_to_source: 'Return to Source Branch', disposed: 'Dispose' }[resolution] || resolution);
  const actionButtons = (item, source) => {
    if (item.resolution !== 'quarantine') return `<span class="sale-return-resolved-pill">${escapeHtml(resolutionLabel(item.resolution))}</span>`;
    const icons = {
      restocked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      supplier_return: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M17 17V7H7"/></svg>',
      return_to_source: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M17 17V7H7"/></svg>',
      disposed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    };
    const btnClasses = {
      restocked: 'restock-btn',
      supplier_return: 'supplier-btn',
      return_to_source: 'supplier-btn',
      disposed: 'danger-btn'
    };
    const buttons = source === 'stock_in'
      ? [['restocked', 'Restock'], ['supplier_return', 'Return to Supplier'], ['disposed', 'Dispose']]
      : [['restocked', 'Restock'], ['return_to_source', 'Return to Source'], ['disposed', 'Dispose']];
    return `<span class="table-actions quarantine-actions">${buttons.map(([resolution, label]) => `<button class="quarantine-resolution resolve-btn ${btnClasses[resolution] || ''}" data-quarantine-resolution="${resolution}" data-quarantine-item="${item.id}" type="button" title="${label}">${icons[resolution] || ''}<span class="resolve-btn-text">${label}</span></button>`).join('')}</span>`;
  };

  const casesHtml = cases.length > 0
    ? cases.map((caseItem) => {
        const items = pendingItemsByCase[caseItem.id] || [];
        return `<section class="quarantine-case-card">
          <header class="quarantine-case-header">
            <div>
              <span class="category-badge">${escapeHtml(sourceLabel(caseItem.sourceType))}</span>
              <strong>${escapeHtml(caseItem.id)}</strong>
              <span class="product-meta">Reference: ${escapeHtml(caseItem.reference)} &bull; ${escapeHtml(caseItem.createdAt ? formatDateTime(caseItem.createdAt) : '')}</span>
            </div>
            <span class="stock-pill ${caseItem.status === 'Resolved' ? 'stock-normal' : caseItem.status === 'Partially Resolved' ? 'category-badge' : 'stock-low'}">${escapeHtml(caseItem.status)}</span>
          </header>
          <div class="quarantine-case-details">
            <span><b>${caseItem.sourceType === 'stock_in' ? 'Supplier / Reference:' : 'Source Branch:'}</b> ${escapeHtml(caseItem.sourceType === 'stock_in' ? (caseItem.supplierReference || 'Not recorded') : (caseItem.sourceBranchName || caseItem.sourceBranchId || 'Not recorded'))}</span>
            <span><b>Inspection Reason:</b> ${escapeHtml(caseItem.reason || 'Not recorded')}</span>
          </div>
          <div class="quarantine-items">
            ${items.map((item) => `<div class="quarantine-item-row"><div class="product-cell"><strong class="product-name">${escapeHtml(item.productName)}</strong><span class="product-meta">${Number(item.qty).toLocaleString('en-PH')} ${escapeHtml(item.unit)}${item.sellingPrice === null ? '' : ` &bull; Receipt price ${money(item.sellingPrice)}`}</span></div><div class="quarantine-item-action">${actionButtons(item, caseItem.sourceType)}</div></div>`).join('') || '<div class="empty-state"><p>No quarantine items found</p></div>'}
          </div>
        </section>`;
      }).join('')
    : `<div class="quarantine-empty-state">
        <div class="quarantine-empty-icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <h3 class="quarantine-empty-title">No Quarantined Items</h3>
        <p class="quarantine-empty-desc">Inspection holding area is currently clear. Any stock-in receipts or branch transfers flagged for inspection will appear here for verification and disposition.</p>
        <div class="quarantine-empty-status">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
          <span>Holding Area All Clear</span>
        </div>
      </div>`;

  table.innerHTML = `
    <div class="quarantine-view">
      <div class="quarantine-banner">
        <div class="quarantine-banner-leading">
          <div class="quarantine-banner-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div class="quarantine-banner-text">
            <strong class="quarantine-banner-title">Quarantine &amp; Quality Inspection Area</strong>
            <p class="quarantine-banner-desc">Stock listed here is isolated from available inventory. Inspect each item carefully before authorizing disposition.</p>
          </div>
        </div>
        <div class="quarantine-banner-status">
          <button class="button button-secondary quarantine-report-link-btn" type="button" id="quarantineReportNavBtn" style="height:32px;padding:0 12px;font-size:12px;gap:6px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
            <span>Quarantine Report</span>
          </button>
          ${cases.length > 0
            ? `<span class="quarantine-status-pill has-items"><span class="quarantine-pulse-dot"></span> ${cases.length} ${cases.length === 1 ? 'Case Pending' : 'Cases Pending'}</span>`
            : `<span class="quarantine-status-pill all-clear"><span class="quarantine-pulse-dot"></span> Holding Area Clear</span>`
          }
        </div>
      </div>
      ${casesHtml}
    </div>
  `;
  table.querySelectorAll('[data-quarantine-item]').forEach((button) => button.addEventListener('click', () => resolveInventoryQuarantineItem_(button.dataset.quarantineItem, button.dataset.quarantineResolution)));
  table.querySelector('#quarantineReportNavBtn')?.addEventListener('click', () => setView('quarantineReport'));
}

async function resolveInventoryQuarantineItem_(itemId, resolution) {
  const labels = { restocked: 'restock this item into available inventory', supplier_return: 'return this item to the supplier', return_to_source: 'send this item back to the source branch as a new in-transit transfer', disposed: 'dispose this item' };
  if (!await askConfirmation({ title: 'Resolve Quarantined Item', eyebrow: 'QUARANTINED ITEMS', subtitle: 'Confirm final inventory disposition', message: `Do you want to ${labels[resolution] || 'resolve this item'}?`, warning: 'This action is permanent and is recorded in the inventory audit history.', confirmText: resolution === 'disposed' ? 'Dispose Item' : 'Confirm', confirmType: resolution === 'disposed' ? 'danger' : 'primary' })) return;
  try {
    const result = await api('resolveInventoryQuarantineItem', { itemId, resolution });
    showToast(result?.returnTransferId ? `Item marked for return. New transfer ${result.returnTransferId} is in transit.` : 'Quarantined item resolved.', 'success');
    await refresh(false);
  } catch (error) { showToast(error.message || 'Unable to resolve quarantined item.', 'error'); }
}

function getQuarantineReportData_() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const dateFrom = $('#quarantineDateFrom')?.value || '';
  const dateTo = $('#quarantineDateTo')?.value || '';

  const casesMap = new Map(inventoryQuarantineCases.map((c) => [c.id, c]));

  const receiptRecords = inventoryQuarantineItems
    .map((item) => {
      const caseItem = casesMap.get(item.caseId) || {
        id: item.caseId,
        reference: 'N/A',
        sourceType: 'stock_in',
        sourceBranchName: '',
        supplierReference: '',
        reason: 'Inspection holding',
        status: 'quarantine',
        createdAt: item.resolvedAt || new Date().toISOString()
      };
      const recordDate = item.resolvedAt || caseItem.resolvedAt || caseItem.createdAt;
      const dateKey = saleDateKey(recordDate);

      let groupKey = 'quarantine';
      if (item.resolution === 'restocked') groupKey = 'restocked';
      else if (item.resolution === 'supplier_return' || item.resolution === 'return_to_source') groupKey = 'supplier_return';
      else if (item.resolution === 'disposed') groupKey = 'disposed';

      return {
        item,
        caseItem,
        recordDate,
        dateKey,
        groupKey,
        productName: item.productName || item.productId,
        qty: Number(item.qty || 0),
        unit: item.unit || 'unit',
        sellingPrice: item.sellingPrice,
        resolution: item.resolution,
        reason: caseItem.reason || 'Inspection holding',
        reference: caseItem.reference || caseItem.id,
        supplier: caseItem.sourceType === 'stock_in'
          ? (caseItem.supplierReference || 'Supplier Delivery')
          : (caseItem.sourceBranchName || caseItem.sourceBranchId || 'Source Branch'),
        sourceType: caseItem.sourceType
      };
    });

  const returnItemsById = new Map(saleReturnItems.map((item) => [item.id, item]));
  const returnsById = new Map(saleReturns.map((item) => [item.id, item]));
  const salesById = new Map(salesHistory.map((item) => [item.saleId, item]));
  const productsById = new Map(allProducts.map((item) => [item.id, item]));
  const salesReturnRecords = inventoryReturnLots.map((lot) => {
    const returnItem = returnItemsById.get(lot.returnItemId);
    const returnRecord = returnsById.get(returnItem?.returnId);
    const sale = salesById.get(returnRecord?.saleId);
    const product = productsById.get(lot.productId);
    const recordDate = lot.resolvedAt || lot.createdAt || returnRecord?.resolvedAt || returnRecord?.createdAt;
    const resolution = lot.state || 'quarantine';
    const groupKey = resolution === 'restocked'
      ? 'restocked'
      : resolution === 'supplier_return'
        ? 'supplier_return'
        : resolution === 'disposed'
          ? 'disposed'
          : 'quarantine';

    return {
      item: { id: lot.id },
      caseItem: { id: returnRecord?.id || returnItem?.returnId || lot.returnItemId },
      recordDate,
      dateKey: saleDateKey(recordDate),
      groupKey,
      productName: product?.name || lot.productId,
      qty: Number(lot.qty || 0),
      unit: product?.unit || 'unit',
      sellingPrice: lot.sellingPrice,
      resolution,
      reason: returnRecord?.reason || 'Sales return inspection',
      reference: sale?.saleId || returnRecord?.saleId || returnRecord?.id || 'Sales Return',
      supplier: sale?.customerName || 'Walk-in customer',
      sourceType: 'sales_return',
    };
  });

  const records = [...receiptRecords, ...salesReturnRecords]
    .filter((r) => {
      const matchesDate = (!dateFrom || r.dateKey >= dateFrom) && (!dateTo || r.dateKey <= dateTo);
      const matchesTerm = !term || `${r.item.id} ${r.caseItem.id} ${r.productName} ${r.reference} ${r.supplier} ${r.reason} ${r.resolution}`.toLowerCase().includes(term);
      return matchesDate && matchesTerm;
    })
    .sort((a, b) => new Date(b.recordDate) - new Date(a.recordDate));

  const restocked = records.filter((r) => r.groupKey === 'restocked');
  const supplierReturn = records.filter((r) => r.groupKey === 'supplier_return');
  const disposed = records.filter((r) => r.groupKey === 'disposed');
  const pending = records.filter((r) => r.groupKey === 'quarantine');

  return {
    records,
    dateFrom,
    dateTo,
    term,
    restocked,
    supplierReturn,
    disposed,
    pending,
    totalUnits: records.reduce((s, r) => s + r.qty, 0),
    restockedUnits: restocked.reduce((s, r) => s + r.qty, 0),
    supplierReturnUnits: supplierReturn.reduce((s, r) => s + r.qty, 0),
    disposedUnits: disposed.reduce((s, r) => s + r.qty, 0),
    pendingUnits: pending.reduce((s, r) => s + r.qty, 0),
  };
}

function renderQuarantineReport() {
  const table = $('#inventoryTable');
  if (!table) return;

  const data = getQuarantineReportData_();
  const { records, restocked, supplierReturn, disposed, pending, totalUnits, restockedUnits, supplierReturnUnits, disposedUnits, pendingUnits } = data;

  const groups = [
    {
      key: 'restocked',
      title: 'Restocked to Available Inventory',
      desc: 'Items inspected, approved, and transferred into available branch inventory',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      pillClass: 'stock-normal',
      badgeClass: 'stock-normal',
      statusText: 'Restocked',
      items: restocked,
      units: restockedUnits,
    },
    {
      key: 'supplier_return',
      title: 'Returned to Supplier / Source Branch',
      desc: 'Dispatched back to vendor or originating source branch',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M17 17V7H7"/></svg>',
      pillClass: 'category-badge',
      badgeClass: 'category-badge',
      statusText: 'Supplier Return',
      items: supplierReturn,
      units: supplierReturnUnits,
    },
    {
      key: 'disposed',
      title: 'Disposed / Scrapped Items',
      desc: 'Damaged, expired, or non-returnable units written off',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      pillClass: 'stock-low',
      badgeClass: 'stock-low',
      statusText: 'Disposed',
      items: disposed,
      units: disposedUnits,
    },
    {
      key: 'quarantine',
      title: 'Pending Quality Inspection (Holding Area)',
      desc: 'Awaiting quality verification and final disposition resolution',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
      pillClass: 'in-transit-badge',
      badgeClass: 'in-transit-badge',
      statusText: 'In Inspection',
      items: pending,
      units: pendingUnits,
    },
  ];

  const sourceName = (src) => src === 'stock_in' ? 'Stock-In' : src === 'sales_return' ? 'Sales Return' : 'Stock Transfer';

  const filteredGroups = groups.filter((g) => {
    if (activeQuarantineFilter !== 'all' && g.key !== activeQuarantineFilter) return false;
    return g.items.length > 0;
  });

  const filterChipsHtml = `
    <div class="quarantine-filter-bar" role="tablist" aria-label="Filter quarantine disposition">
      <button type="button" class="quarantine-filter-chip ${activeQuarantineFilter === 'all' ? 'active' : ''}" data-quarantine-filter="all">
        <span class="quarantine-filter-chip-label">All</span>
        <span class="quarantine-filter-chip-count">${records.length}</span>
      </button>
      <button type="button" class="quarantine-filter-chip chip-restocked ${activeQuarantineFilter === 'restocked' ? 'active' : ''}" data-quarantine-filter="restocked">
        <span class="chip-dot dot-restocked"></span>
        <span class="quarantine-filter-chip-label">Restocked</span>
        <span class="quarantine-filter-chip-count">${restocked.length}</span>
      </button>
      <button type="button" class="quarantine-filter-chip chip-supplier ${activeQuarantineFilter === 'supplier_return' ? 'active' : ''}" data-quarantine-filter="supplier_return">
        <span class="chip-dot dot-supplier"></span>
        <span class="quarantine-filter-chip-label">Supplier Return</span>
        <span class="quarantine-filter-chip-count">${supplierReturn.length}</span>
      </button>
      <button type="button" class="quarantine-filter-chip chip-disposed ${activeQuarantineFilter === 'disposed' ? 'active' : ''}" data-quarantine-filter="disposed">
        <span class="chip-dot dot-disposed"></span>
        <span class="quarantine-filter-chip-label">Disposed</span>
        <span class="quarantine-filter-chip-count">${disposed.length}</span>
      </button>
      ${pending.length > 0 ? `
        <button type="button" class="quarantine-filter-chip chip-pending ${activeQuarantineFilter === 'quarantine' ? 'active' : ''}" data-quarantine-filter="quarantine">
          <span class="chip-dot dot-pending"></span>
          <span class="quarantine-filter-chip-label">In Inspection</span>
          <span class="quarantine-filter-chip-count">${pending.length}</span>
        </button>
      ` : ''}
    </div>
  `;

  if (records.length === 0) {
    table.innerHTML = `
      ${filterChipsHtml}
      <div class="table-row table-header">
        <span>Product</span>
        <span>Case / Date</span>
        <span>Origin &amp; Reference</span>
        <span>Inspection Reason</span>
        <span>Quantity</span>
        <span>Disposition</span>
      </div>
      <div class="empty-state">
        <p>No quarantine records found</p>
        <small>No inspection items match the selected date range or search filter.</small>
      </div>
    `;
    bindQuarantineFilterChips_(table);
    return;
  }

  if (filteredGroups.length === 0) {
    table.innerHTML = `
      ${filterChipsHtml}
      <div class="table-row table-header">
        <span>Product</span>
        <span>Case / Date</span>
        <span>Origin &amp; Reference</span>
        <span>Inspection Reason</span>
        <span>Quantity</span>
        <span>Disposition</span>
      </div>
      <div class="empty-state">
        <p>No records for this disposition</p>
        <small>Try selecting a different filter above.</small>
      </div>
    `;
    bindQuarantineFilterChips_(table);
    return;
  }

  table.innerHTML = `
    ${filterChipsHtml}
    <div class="table-row table-header">
      <span>Product</span>
      <span>Case / Date</span>
      <span>Origin &amp; Reference</span>
      <span>Inspection Reason</span>
      <span>Quantity</span>
      <span>Disposition</span>
    </div>
    ${filteredGroups.map((g) => `
      <div class="quarantine-group-divider ${g.key}">
        <div class="quarantine-group-divider-content">
          <span class="quarantine-group-icon ${g.key}">${g.icon}</span>
          <div class="quarantine-group-text">
            <strong class="quarantine-group-divider-title">${escapeHtml(g.title)}</strong>
            <span class="quarantine-group-divider-desc">${escapeHtml(g.desc)}</span>
          </div>
        </div>
        <div class="quarantine-group-badges">
          <span class="stock-pill category-badge">${g.items.length} Line${g.items.length === 1 ? '' : 's'}</span>
          <span class="stock-pill ${g.pillClass}">${Number(g.units).toLocaleString('en-PH')} Units</span>
        </div>
      </div>
      ${g.items.map((r) => `
        <div class="table-row">
          <div class="product-cell qr-product-cell">
            <strong class="product-name">${escapeHtml(r.productName)}</strong>
            <span class="product-meta">${escapeHtml(r.unit)}${r.sellingPrice !== null ? ` &bull; Cost: ${money(r.sellingPrice)}` : ''}</span>
          </div>
          <div class="product-cell qr-case-cell">
            <strong class="product-name">${escapeHtml(r.caseItem.id)}</strong>
            <span class="product-meta">${escapeHtml(r.recordDate ? new Date(r.recordDate).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : 'Unknown')}</span>
          </div>
          <div class="product-cell qr-origin-cell">
            <strong class="product-name">${escapeHtml(r.reference)}</strong>
            <span class="product-meta" title="${escapeHtml(r.supplier)}">${escapeHtml(sourceName(r.sourceType))}: ${escapeHtml(r.supplier)}</span>
          </div>
          <div class="product-cell qr-reason-cell">
            <span class="quarantine-reason-text" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</span>
          </div>
          <div class="row-middle-cells qr-qty-cell">
            <span class="shipped-badge" data-report-label="Qty">${Number(r.qty).toLocaleString('en-PH')}</span>
          </div>
          <div class="row-action-cell qr-disposition-cell">
            <span class="stock-pill ${g.badgeClass}">${g.statusText}</span>
          </div>
        </div>
      `).join('')}
    `).join('')}
  `;

  bindQuarantineFilterChips_(table);
}

function bindQuarantineFilterChips_(table) {
  table.querySelectorAll('[data-quarantine-filter]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const filter = chip.getAttribute('data-quarantine-filter');
      if (activeQuarantineFilter !== filter) {
        activeQuarantineFilter = filter;
        renderQuarantineReport();
      }
    });
  });
}

function generateQuarantinePdf() {
  ensureQuarantineDateDefaults();
  const data = getQuarantineReportData_();
  const { records, restocked, supplierReturn, disposed, pending, totalUnits, restockedUnits, supplierReturnUnits, disposedUnits, dateFrom, dateTo } = data;
  const branch = branches.find((item) => item.id === activeBranchId) || { name: 'Main Branch' };

  const formatDate = (value) => value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'All dates';
  const periodText = (dateFrom || dateTo)
    ? `${formatDate(dateFrom)} to ${formatDate(dateTo)}`
    : 'All Recorded Dates';
  const generatedTime = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

  const groups = [
    { key: 'restocked', title: 'Restocked to Available Inventory', items: restocked, units: restockedUnits, status: 'Restocked', color: '#10b981', bg: '#ecfdf5', text: '#059669' },
    { key: 'supplier_return', title: 'Returned to Supplier / Source Branch', items: supplierReturn, units: supplierReturnUnits, status: 'Supplier Return', color: '#0284c7', bg: '#f0f9ff', text: '#0284c7' },
    { key: 'disposed', title: 'Disposed / Scrapped Items', items: disposed, units: disposedUnits, status: 'Disposed', color: '#e11d48', bg: '#fff1f2', text: '#e11d48' },
    { key: 'quarantine', title: 'Pending Inspection (Holding Area)', items: pending, units: data.pendingUnits, status: 'In Inspection', color: '#d97706', bg: '#fffbeb', text: '#d97706' },
  ].filter((g) => g.items.length > 0);

  // Flatten all rows with section headings for paginated printing
  const printItems = [];
  groups.forEach((g) => {
    printItems.push({ type: 'header', title: g.title, count: g.items.length, units: g.units, color: g.color });
    g.items.forEach((item, idx) => {
      printItems.push({ type: 'row', item, index: idx + 1, groupColor: g.color, groupBg: g.bg, groupText: g.text, status: g.status });
    });
  });

  const signoffHeight = 150;
  const pages = [];
  let currentIdx = 0;
  let isFirst = true;

  while (currentIdx < printItems.length || pages.length === 0) {
    const pageCapacity = isFirst ? 820 : 980;
    let usedHeight = 0;
    const chunk = [];

    while (currentIdx < printItems.length) {
      const item = printItems[currentIdx];
      const h = item.type === 'header' ? 36 : 32;
      if (chunk.length > 0 && (usedHeight + h > pageCapacity)) {
        break;
      }
      chunk.push(item);
      usedHeight += h;
      currentIdx++;
    }

    const isLastChunk = currentIdx >= printItems.length;
    let hasSignoff = false;
    if (isLastChunk) {
      if (pageCapacity - usedHeight >= signoffHeight) {
        hasSignoff = true;
      }
    }

    pages.push({
      isFirstPage: isFirst,
      items: chunk,
      hasSignoff
    });

    isFirst = false;

    if (isLastChunk && !hasSignoff) {
      pages.push({
        isFirstPage: false,
        items: [],
        hasSignoff: true
      });
      break;
    }
  }

  const totalPages = pages.length;

  const renderedQuarantineHtml = pages.map((pageData, pageIndex) => {
    const pageNum = pageIndex + 1;
    let pageContentHtml = '';

    if (pageData.isFirstPage) {
      pageContentHtml += `
        <header class="report-header">
          <div class="report-brand-wrap">
            <img src="assets/ce-logo.png" class="report-badge-img" width="42" height="42" style="width:42px;height:42px;max-width:42px;max-height:42px;object-fit:contain;flex-shrink:0;" alt="Caishen Enterprises" />
            <div>
              <span class="report-eyebrow">CAISHEN ENTERPRISES OPERATIONS</span>
              <h1 class="report-title">Branch Quarantine Report</h1>
              <p class="report-subtitle">Quality inspection, restock, supplier return, and scrap disposition audit</p>
            </div>
          </div>
          <div class="report-meta-box">
            <div class="report-meta-row"><span class="meta-label">Branch:</span><strong class="meta-val">${escapeHtml(branch.name || 'Main Branch')}</strong></div>
            <div class="report-meta-row"><span class="meta-label">Period:</span><strong class="meta-val">${escapeHtml(periodText)}</strong></div>
            <div class="report-meta-row"><span class="meta-label">Generated:</span><span class="meta-val">${escapeHtml(generatedTime)}</span></div>
          </div>
        </header>
      `;
    } else {
      pageContentHtml += renderReportRunningHeader(branch.name || 'Main Branch', periodText, 'Branch Quarantine Report');
    }

    if (pageData.items.length > 0 || (pageData.isFirstPage && records.length === 0)) {
      pageContentHtml += `
        <section class="report-ledger-body">
          <div class="report-section-title-wrap">
            <h2 class="report-section-title">${pageData.isFirstPage ? 'Quarantine & Disposition Ledger' : 'Quarantine & Disposition Ledger (Continued)'}</h2>
            <span class="report-count-badge">${records.length > 0 ? `Showing ${pageData.items.filter((i) => i.type === 'row').length} of ${records.length} Recorded Lines` : '0 Recorded Lines'}</span>
          </div>
          <div class="report-tx-card">
            <div class="report-tx-items-wrap" style="padding:0;">
              <table class="report-items-table quarantine-print-table" style="width:100%; border-collapse:collapse;">
                <thead>
                  <tr style="background:#f8fafc;">
                    <th style="width:25px; padding:6px 8px;">#</th>
                    <th style="width:180px; padding:6px 8px;">Product</th>
                    <th style="width:112px; padding:6px 8px;">Case ID</th>
                    <th style="width:138px; padding:6px 8px;">Source Ref</th>
                    <th style="padding:6px 8px;">Reason</th>
                    <th style="width:48px; text-align:center; padding:6px 8px;">Qty</th>
                    <th style="width:95px; text-align:right; padding:6px 8px;">Disposition</th>
                  </tr>
                </thead>
                <tbody>
                  ${pageData.items.map((entry) => {
                    if (entry.type === 'header') {
                      return `
                        <tr style="background:#f1f5f9;">
                          <td colspan="7" style="background:#f1f5f9; font-weight:800; font-size:10px; color:#0f172a; padding:6px 10px; border-top:1.5px solid #cbd5e1; border-bottom:1px solid #cbd5e1;">
                            <span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${entry.color}; margin-right:6px; vertical-align:middle;"></span>
                            <span>${escapeHtml(entry.title)}</span>
                            <span style="color:#64748b; font-weight:600; margin-left:6px;">&bull; ${entry.count} line${entry.count === 1 ? '' : 's'} (${Number(entry.units).toLocaleString('en-PH')} units)</span>
                          </td>
                        </tr>
                      `;
                    }
                    const r = entry.item;
                    return `
                      <tr style="border-bottom:1px dashed #e2e8f0;">
                        <td style="color:#94a3b8; font-weight:600; padding:5px 8px;">${entry.index}</td>
                        <td style="padding:5px 8px;">
                          <strong style="color:#0f172a; font-size:10px;">${escapeHtml(r.productName)}</strong>
                          <div style="font-size:8.5px; color:#64748b;">${escapeHtml(r.unit)}${r.sellingPrice !== null ? ` &bull; Cost: ${money(r.sellingPrice)}` : ''}</div>
                        </td>
                        <td style="padding:5px 8px;"><strong style="font-family:monospace; font-size:9.5px;">${escapeHtml(r.caseItem.id)}</strong><div style="font-size:8.5px; color:#64748b; white-space:nowrap;">${escapeHtml(r.recordDate ? new Date(r.recordDate).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : '')}</div></td>
                        <td style="padding:5px 8px;"><strong style="font-family:monospace; font-size:9px; color:#475569;">${escapeHtml(r.reference)}</strong><div style="font-size:8.5px; color:#64748b;">${escapeHtml(r.sourceType === 'sales_return' ? `Sales Return: ${r.supplier}` : r.supplier)}</div></td>
                        <td style="color:#475569; font-size:9px; padding:5px 8px;">${escapeHtml(r.reason)}</td>
                        <td style="text-align:center; font-weight:800; padding:5px 8px; font-size:10px;">${Number(r.qty).toLocaleString('en-PH')}</td>
                        <td style="text-align:right; padding:5px 8px;">
                          <span style="display:inline-block; padding:2px 7px; border-radius:4px; font-size:8.5px; font-weight:700; text-transform:uppercase; background:${entry.groupBg}; color:${entry.groupText}; border:1px solid ${entry.groupColor};">
                            ${escapeHtml(entry.status)}
                          </span>
                        </td>
                      </tr>
                    `;
                  }).join('') || '<tr><td colspan="7" style="text-align:center; padding:16px; color:#64748b;">No quarantine records found for the selected period.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `;
    }

    if (pageData.hasSignoff) {
      pageContentHtml += `
        <footer class="report-document-footer">
          <div class="report-sign-block">
            <div class="sign-column"><div class="sign-line"></div><span class="sign-title">Prepared By (Inspector / Staff)</span><span class="sign-sub">Signature over printed name</span></div>
            <div class="sign-column"><div class="sign-line"></div><span class="sign-title">Audited &amp; Verified By</span><span class="sign-sub">Branch Manager / Operations</span></div>
          </div>
          <div class="report-disclaimer"><p>CAISHEN ENTERPRISES SYSTEM-GENERATED QUARANTINE REPORT &bull; CONFIDENTIAL &bull; ALL RIGHTS RESERVED</p></div>
        </footer>
      `;
    }

    return `
      <div class="report-page quarantine-print-page">
        <div class="report-page-content">
          ${pageContentHtml}
        </div>
        ${renderReportPageFooter(pageNum, totalPages, generatedTime, 'Quarantine')}
      </div>
    `;
  }).join('');

  const printDoc = $('#salesPrintDocument');
  if (printDoc) printDoc.innerHTML = renderedQuarantineHtml;
  openReportInNewPage_(renderedQuarantineHtml, `Quarantine Report - ${branch.name || 'Main Branch'}`);
}

function renderStockInHistoryTable(filterTerm = '') {
  const list = $('#stockInHistoryList');
  if (!list) return;
  const term = String(filterTerm || '').trim().toLowerCase();
  const rows = stockInHistory.filter((item) => {
    if (!term) return true;
    const dateStr = item.date ? new Date(item.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).toLowerCase() : '';
    return (
      (item.productName || '').toLowerCase().includes(term) ||
      (item.id || '').toLowerCase().includes(term) ||
      (item.supplierReference || '').toLowerCase().includes(term) ||
      (item.unit || '').toLowerCase().includes(term) ||
      dateStr.includes(term)
    );
  });

  if (!stockInHistory.length) {
    list.innerHTML = `<div class="empty-state"><p>No stock-in receipts yet</p><small>New stock-ins will record their exact unit cost and supplier/invoice number here.</small></div>`;
    return;
  }

  if (!rows.length) {
    list.innerHTML = `<div class="empty-state"><p>No matching stock-in records</p><small>No records matched "${escapeHtml(term)}". Try searching by product name, STK ID, or invoice/supplier.</small></div>`;
    return;
  }

  list.innerHTML = `
    <div class="stock-in-history-table">
      <div class="stock-in-history-row stock-in-history-header">
        <span>Date</span>
        <span>Product</span>
        <span>Quantity</span>
        <span>Stock-In Price</span>
        <span>Supplier / Invoice #</span>
      </div>
      ${rows.map((receipt) => {
        const date = receipt.date ? new Date(receipt.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown date';
        const cost = receipt.sellingPrice === null ? '<span class="stock-in-cost-unknown">Not recorded</span>' : money(receipt.sellingPrice);
        const ref = receipt.supplierReference
          ? `<span class="stock-in-ref-badge" title="Invoice / Supplier: ${escapeHtml(receipt.supplierReference)}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              <span>${escapeHtml(receipt.supplierReference)}</span>
            </span>`
          : '<span class="stock-in-ref-empty">No invoice / ref</span>';
        return `<div class="stock-in-history-row">
          <span class="stock-in-date">${escapeHtml(date)}</span>
          <div class="product-cell">
            <strong class="product-name">${escapeHtml(receipt.productName)}</strong>
            <span class="product-meta">${escapeHtml(receipt.id)}</span>
          </div>
          <span class="stock-pill stock-quantity">${receipt.qty} ${escapeHtml(receipt.unit)}</span>
          <div class="stock-in-price-cell">
            <strong class="stock-in-cost">${cost}</strong>
            <span class="stock-in-unit-meta">per ${escapeHtml(receipt.unit)}</span>
          </div>
          <div class="stock-in-ref-cell">${ref}</div>
        </div>`;
      }).join('')}
    </div>`;
}

function showStockInHistory() {
  const dialog = $('#stockInHistoryDialog');
  if (!dialog) return;
  const branchName = branches.find((branch) => branch.id === activeBranchId)?.name || 'Selected Branch';
  $('#stockInHistorySubtitle').textContent = `Stock-in records and receipt pricing for ${branchName}.`;
  const searchInput = $('#stockInSearchInput');
  if (searchInput) searchInput.value = '';
  renderStockInHistoryTable('');
  dialog.showModal();
}

function renderBranches() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const rows = sortByName_(branches.filter((branch) => `${branch.name} ${branch.type} ${branch.address}`.toLowerCase().includes(term)));
  table.innerHTML = `
    <div class="table-row table-header">
      <span>Branch</span><span>Type</span><span>Address</span><span>Status</span><span>Action</span>
    </div>
    ${rows.map((branch) => `
      <div class="table-row">
        <div class="product-cell"><strong class="product-name">${escapeHtml(branch.name)}</strong><span class="product-meta">${escapeHtml(branch.id)}${branch.id === activeBranchId ? ' &bull; Active location' : ''}</span></div>
        <div class="row-middle-cells">
          <span class="category-badge">${escapeHtml(branch.type)}</span>
          <span class="branch-address">${escapeHtml(branch.address || 'No address recorded')}</span>
          <span class="stock-pill ${branch.status === 'Active' ? 'stock-normal' : 'stock-low'}">${escapeHtml(branch.status)}</span>
        </div>
        <div class="row-action-cell"><button class="icon-button" data-edit-branch="${branch.id}" aria-label="Edit ${escapeHtml(branch.name)}" title="Edit branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button></div>
      </div>
    `).join('') || '<div class="empty-state"><p>No branches found</p><small>Add a branch to begin branch-level operations.</small></div>'}
  `;
  table.querySelectorAll('[data-edit-branch]').forEach((button) => button.addEventListener('click', () => openForm('editBranch', button.dataset.editBranch)));
}

function renderCustomers() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const rows = sortByName_(customers.filter((customer) => `${customer.name} ${customer.phone} ${customer.address}`.toLowerCase().includes(term)));
  const paidByCredit = creditPayments.reduce((totals, payment) => {
    const creditId = payment.creditId || payment.saleId;
    totals[creditId] = (totals[creditId] || 0) + Number(payment.amount || 0);
    return totals;
  }, {});
  const balancesByCustomer = {};
  const addBalance = (account) => {
    const summary = balancesByCustomer[account.customerId] ||= { previous: 0, current: 0, remaining: 0, accounts: [] };
    const paid = paidByCredit[account.creditId] || 0;
    const total = Number(account.total || 0);
    if (account.sourceType === 'previous_balance') summary.previous += total;
    if (account.sourceType === 'sale') summary.current += total;
    summary.remaining += Math.max(total - paid, 0);
    summary.accounts.push({ ...account, balance: Math.max(total - paid, 0), isPaid: total - paid <= 0.00001 });
    if (summary.accounts.length > 1) summary.accounts = [summary.accounts.find((item) => !item.isPaid) || summary.accounts[0]];
  };
  salesHistory.filter((sale) => sale.paymentType === 'credit').forEach((sale) => addBalance({ creditId: sale.saleId, saleId: sale.saleId, sourceType: 'sale', customerId: sale.customerId, total: sale.total }));
  openingCreditAccounts.forEach((account) => addBalance(account));
  table.innerHTML = `
    <div class="table-row table-header"><span>Customer</span><span>Contact</span><span>Credit</span><span>Remaining Balance</span><span>Action</span></div>
    ${rows.map((customer) => {
      const customerAccounts = balancesByCustomer[customer.id]?.accounts || [];
      const paymentAccount = customerAccounts.find((account) => !account.isPaid);
      const historyAccount = paymentAccount || customerAccounts[0];
      return `
      <div class="table-row">
        <div class="product-cell customer-details-cell"><div class="customer-name-line"><strong class="product-name">${escapeHtml(displayCustomerName(customer.name))}</strong><span class="customer-status-meta stock-pill ${customer.status === 'Active' ? 'stock-normal' : 'stock-low'}" title="${escapeHtml(customer.status)}" aria-label="${escapeHtml(customer.status)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></div><span class="product-meta">${escapeHtml(customer.id)}</span></div>
        <div class="row-middle-cells"><div class="product-cell"><strong class="product-name customer-detail-value">${escapeHtml(customer.phone || 'No phone recorded')}</strong><span class="product-meta">${escapeHtml(customer.address || 'No address recorded')}</span></div><div class="product-cell"><strong class="product-name customer-detail-value">Current Credit: ${money(balancesByCustomer[customer.id]?.current || 0)}</strong><span class="product-meta customer-previous-balance">Previous Balance: ${money(balancesByCustomer[customer.id]?.previous || 0)}</span></div><span class="credit-balance">${money(balancesByCustomer[customer.id]?.remaining || 0)}</span></div>
        <div class="row-action-cell"><span class="table-actions"><button class="icon-button" data-edit-customer="${customer.id}" aria-label="Edit ${escapeHtml(displayCustomerName(customer.name))}" title="Edit customer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>${(balancesByCustomer[customer.id]?.accounts || []).map((account) => !account.isPaid ? `<button class="icon-button success-icon" data-credit-account="${account.creditId}" aria-label="Record payment" title="Record payment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/><path d="M12 15h.01"/></svg></button>` : '').join('')}<button class="icon-button primary-icon" data-view-payment-history="${customer.id}" aria-label="Payment history" title="Payment history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></button></span></div>
      </div>
    `;
    }).join('') || '<div class="empty-state"><p>No customers found</p><small>Add a customer for this branch.</small></div>'}
  `;
  table.querySelectorAll('[data-edit-customer]').forEach((button) => button.addEventListener('click', () => openForm('editCustomer', button.dataset.editCustomer)));
  table.querySelectorAll('[data-credit-account]').forEach((button) => button.addEventListener('click', () => openCreditPayment(button.dataset.creditAccount)));
  table.querySelectorAll('[data-view-payment-history]').forEach((button) => button.addEventListener('click', () => openCreditHistory(button.dataset.viewPaymentHistory)));
}

function renderCreditPayments() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const accounts = salesHistory
    .filter((sale) => String(sale.paymentType || '').toLowerCase() === 'credit')
    .map((sale) => ({ saleId: sale.saleId, customerId: sale.customerId, customerName: sale.customerName, date: sale.date, total: Number(sale.total || 0), itemCount: (sale.items || []).reduce((count, item) => count + Number(item.qty || 0), 0) }))
    .filter((sale) => `${sale.saleId} ${sale.customerName}`.toLowerCase().includes(term))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  table.innerHTML = `
    <div class="table-row table-header">
      <span>Customer</span>
      <span>Credit Sale</span>
      <span>Credit Date</span>
      <span>Item Count</span>
      <span>Credit Amount</span>
    </div>

    ${accounts.map((account) => {
      return `
        <div class="table-row">
          <div class="product-cell">
            <strong class="product-name">${escapeHtml(displayCustomerName(account.customerName))}</strong>
            <span class="product-meta">${escapeHtml(account.customerId)}</span>
          </div>
          <div class="row-middle-cells">
            <strong class="product-name">${escapeHtml(account.saleId)}</strong>
            <span>${escapeHtml(account.date ? new Date(account.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '')}</span>
            <span>${account.itemCount.toLocaleString('en-PH')}</span>
            <strong class="price-text">${money(account.total)}</strong>
          </div>
        </div>
      `;
    }).join('') || '<div class="empty-state"><p>No credit sales found</p><small>Credit sales for the selected branch will appear here.</small></div>'}
  `;
}

function renderDailySpotCash() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const filtered = dailySpotCash
    .filter((item) => `${item.businessDate} ${item.openingCash} ${item.notes || ''}`.toLowerCase().includes(term))
    .sort((a, b) => new Date(b.businessDate) - new Date(a.businessDate));

  table.innerHTML = `
    <div class="table-row table-header">
      <span>Business Date</span>
      <span>Opening Cash Float</span>
      <span>Notes</span>
      <span>Last Updated</span>
      <span>Action</span>
    </div>
    ${filtered.map((item) => {
      const dateObj = item.businessDate ? new Date(`${item.businessDate}T00:00:00`) : null;
      const formattedDate = dateObj && !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
        : item.businessDate;
      const formattedUpdated = item.updatedAt
        ? new Date(item.updatedAt).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' })
        : '—';
      return `
        <div class="table-row">
          <div class="product-cell">
            <strong class="product-name">${escapeHtml(formattedDate)}</strong>
            <span class="product-meta">${escapeHtml(item.businessDate)}</span>
          </div>
          <div class="row-middle-cells">
            <strong class="price-text" style="color:var(--accent-emerald, #10b981); font-size:14px;">${money(item.openingCash)}</strong>
            <span class="branch-address" title="${escapeHtml(item.notes || '')}">${escapeHtml(item.notes || '—')}</span>
            <span class="product-meta" style="font-size:11.5px;">${escapeHtml(formattedUpdated)}</span>
          </div>
          <div class="row-action-cell">
            <span class="table-actions">
              <button class="icon-button" data-edit-spot-cash="${item.id}" aria-label="Edit Daily Spot Cash" title="Edit Daily Spot Cash">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </button>
              <button class="icon-button danger-icon" data-delete-spot-cash="${item.id}" aria-label="Delete Daily Spot Cash" title="Delete Daily Spot Cash">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </button>
            </span>
          </div>
        </div>
      `;
    }).join('') || '<div class="empty-state"><p>No Daily Spot Cash recorded</p><small>Record the opening cash before branch operations begin.</small></div>'}
  `;

  table.querySelectorAll('[data-edit-spot-cash]').forEach((button) => {
    button.addEventListener('click', () => openForm('editDailySpotCash', button.dataset.editSpotCash));
  });
  table.querySelectorAll('[data-delete-spot-cash]').forEach((button) => {
    button.addEventListener('click', () => deleteDailySpotCash(button.dataset.deleteSpotCash));
  });
}

function renderDailyExpenses() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const filtered = dailyExpenses
    .filter((item) => `${item.businessDate} ${item.category} ${item.description || ''} ${item.receiptReference || ''} ${item.amount}`.toLowerCase().includes(term))
    .sort((a, b) => new Date(b.businessDate) - new Date(a.businessDate));

  table.innerHTML = `
    <div class="table-row table-header">
      <span>Business Date</span>
      <span>Category</span>
      <span>Amount</span>
      <span>Description & Receipt</span>
      <span>Action</span>
    </div>
    ${filtered.map((item) => {
      const dateObj = item.businessDate ? new Date(`${item.businessDate}T00:00:00`) : null;
      const formattedDate = dateObj && !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
        : item.businessDate;
      return `
        <div class="table-row">
          <div class="product-cell">
            <strong class="product-name">${escapeHtml(formattedDate)}</strong>
            <span class="product-meta">${escapeHtml(item.businessDate)}</span>
          </div>
          <div class="row-middle-cells">
            <span class="category-badge">${escapeHtml(item.category)}</span>
            <strong class="price-text" style="color: #f87171; font-size: 14px;">${money(item.amount)}</strong>
            <div class="product-cell" style="min-width:0;">
              <span class="branch-address" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '—')}</span>
              ${item.receiptReference ? `<span class="product-meta" style="font-size:11px;">Ref: ${escapeHtml(item.receiptReference)}</span>` : ''}
            </div>
          </div>
          <div class="row-action-cell">
            <span class="table-actions">
              <button class="icon-button" data-edit-expense="${item.id}" aria-label="Edit Daily Expense" title="Edit Daily Expense">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </button>
              <button class="icon-button danger-icon" data-delete-expense="${item.id}" aria-label="Delete Daily Expense" title="Delete Daily Expense">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </button>
            </span>
          </div>
        </div>
      `;
    }).join('') || '<div class="empty-state"><p>No Daily Expenses recorded</p><small>Track cash expenses for this branch.</small></div>'}
  `;

  table.querySelectorAll('[data-edit-expense]').forEach((button) => {
    button.addEventListener('click', () => openForm('editDailyExpense', button.dataset.editExpense));
  });
  table.querySelectorAll('[data-delete-expense]').forEach((button) => {
    button.addEventListener('click', () => deleteDailyExpense(button.dataset.deleteExpense));
  });
}

async function deleteDailyExpense(id) {
  const item = dailyExpenses.find((entry) => entry.id === id);
  if (!item) return;
  const confirmed = await askConfirmation({
    title: 'Delete Daily Expense',
    eyebrow: 'DAILY EXPENSES',
    subtitle: 'Confirm expense deletion',
    message: `Delete the expense of <strong class="confirm-highlight-name">${money(item.amount)}</strong> (${escapeHtml(item.category)}) for <strong>${escapeHtml(item.businessDate)}</strong>?`,
    warning: 'This action cannot be undone and will be recorded in the audit trail.',
    confirmText: 'Delete Record',
    confirmType: 'danger',
  });
  if (!confirmed) return;
  try {
    const client = requireSupabase_();
    const { error } = await client.rpc('delete_daily_expense', { target_expense_id: id });
    if (error) return showToast(error.message, 'error');
    dailyExpenses = dailyExpenses.filter((entry) => entry.id !== id);
    renderInventory();
    showToast('Daily Expense record deleted.', 'success');
    backgroundRefresh();
  } catch (error) {
    showToast(error.message || 'Unable to delete record.', 'error');
  }
}

async function deleteDailySpotCash(id) {
  const item = dailySpotCash.find((entry) => entry.id === id);
  if (!item) return;
  const confirmed = await askConfirmation({
    title: 'Delete Daily Spot Cash',
    eyebrow: 'DAILY SPOT CASH',
    subtitle: 'Confirm record deletion',
    message: `Delete the opening float of <strong class="confirm-highlight-name">${money(item.openingCash)}</strong> for <strong>${escapeHtml(item.businessDate)}</strong>?`,
    warning: 'This action cannot be undone and will be recorded in the audit trail.',
    confirmText: 'Delete Record',
    confirmType: 'danger',
  });
  if (!confirmed) return;
  try {
    const client = requireSupabase_();
    const { error } = await client.rpc('delete_daily_spot_cash', { target_spot_cash_id: id });
    if (error) return showToast(error.message, 'error');
    dailySpotCash = dailySpotCash.filter((entry) => entry.id !== id);
    renderInventory();
    showToast('Daily Spot Cash record deleted.', 'success');
    backgroundRefresh();
  } catch (error) {
    showToast(error.message || 'Unable to delete record.', 'error');
  }
}

function renderSalesHistory() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const dateFrom = $('#salesDateFrom')?.value || '';
  const dateTo = $('#salesDateTo')?.value || '';
  const table = $('#inventoryTable');
  if (!table) return;
  const sales = salesHistory.filter((sale) => {
    const matchesTerm = `${sale.saleId} ${sale.customerName} ${sale.paymentType}`.toLowerCase().includes(term);
    const saleDate = saleDateKey(sale.date);
    return matchesTerm && (!dateFrom || saleDate >= dateFrom) && (!dateTo || saleDate <= dateTo);
  });
  table.innerHTML = `
    <div class="table-row table-header"><span>Receipt</span><span>Date and Time</span><span>Customer</span><span>Payment</span><span>Total</span><span>Action</span></div>
    ${sales.map((sale) => {
      const items = sale.items || [];
      const itemsSummary = items.length === 0
        ? 'No items recorded'
        : items.map((i) => `${i.name || 'Item'} (${i.qty}×)`).join(', ');
      const isCash = sale.paymentType === 'cash';
      const hasReturnHistory = saleReturns.some((item) => item.saleId === sale.saleId);
      return `
        <div class="table-row">
          <div class="product-cell sales-receipt-cell">
            <strong class="product-name">${escapeHtml(sale.saleId)}</strong>
            <span class="product-meta sales-items-summary" title="${escapeHtml(itemsSummary)}">${escapeHtml(itemsSummary)}</span>
          </div>
          <div class="row-middle-cells">
            <span class="branch-address sales-date-text">${escapeHtml(sale.date ? new Date(sale.date).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : '')}</span>
            <div class="product-cell sales-customer-cell">
              <strong class="product-name">${escapeHtml(displayCustomerName(sale.customerName))}</strong>
              <span class="product-meta">${!isCash ? `Balance: ${money(sale.creditBalance)}` : 'Paid in cash'}</span>
            </div>
            <span class="stock-pill sales-payment-badge ${isCash ? 'stock-normal' : 'category-badge'}">${escapeHtml(isCash ? 'Cash' : 'Credit')}</span>
            <span class="price-text sales-total-price">${money(sale.total)}</span>
          </div>
          <div class="row-action-cell sales-action-cell">
            <span class="table-actions">
              <button class="icon-button" data-view-sale="${escapeHtml(sale.saleId)}" aria-label="View sale receipt" title="View sale receipt">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button class="icon-button" data-manage-sale-return="${escapeHtml(sale.saleId)}" aria-label="Return, refund, or replace sale" title="Return, refund, or replace sale">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg>
              </button>
              ${hasReturnHistory ? `<button class="icon-button" data-view-sale-returns="${escapeHtml(sale.saleId)}" aria-label="View return history" title="View return history">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
              </button>` : ''}
            </span>
          </div>
        </div>
      `;
    }).join('') || '<div class="empty-state"><p>No sales found</p><small>Completed sales for the selected branch will appear here.</small></div>'}
  `;
  table.querySelectorAll('[data-view-sale]').forEach((button) => button.addEventListener('click', () => {
    const sale = salesHistory.find((item) => item.saleId === button.dataset.viewSale);
    if (sale) showSaleReceipt({ sale, items: sale.items, customerName: sale.customerName });
  }));
  table.querySelectorAll('[data-manage-sale-return]').forEach((button) => button.addEventListener('click', () => {
    const sale = salesHistory.find((item) => item.saleId === button.dataset.manageSaleReturn);
    if (sale) openSaleReturnDialog(sale);
  }));
  table.querySelectorAll('[data-view-sale-returns]').forEach((button) => button.addEventListener('click', () => {
    const sale = salesHistory.find((item) => item.saleId === button.dataset.viewSaleReturns);
    if (sale) openSaleReturnHistoryDialog(sale);
  }));
}

function saleReturnAvailableQty_(saleItem) {
  const alreadyReturned = saleReturnItems.filter((item) => item.saleItemId === saleItem.saleItemId).reduce((total, item) => total + Number(item.qty || 0), 0);
  return Math.max(Number(saleItem.qty || 0) - alreadyReturned, 0);
}

function returnResolutionButtons_(attributes) {
  return `<button type="button" class="resolve-btn restock-btn" title="Restock item to active inventory" aria-label="Restock" ${attributes} data-resolution="restocked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg><span class="resolve-btn-text">Restock</span></button><button type="button" class="resolve-btn supplier-btn" title="Return item to supplier" aria-label="Supplier Return" ${attributes} data-resolution="supplier_return"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M17 17V7H7"/></svg><span class="resolve-btn-text">Supplier Return</span></button><button type="button" class="resolve-btn danger-icon" title="Dispose / scrap damaged item" aria-label="Dispose" ${attributes} data-resolution="disposed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span class="resolve-btn-text">Dispose</span></button>`;
}

function returnDispositionChip_(state, qty) {
  if (state === 'quarantine') return `<span class="quarantine-chip">${Number(qty).toLocaleString('en-PH')} in quarantine</span>`;
  const label = state === 'restocked' ? '✓ Restocked' : state === 'supplier_return' ? '↗ Supplier Return' : state === 'disposed' ? 'Disposed' : 'Mixed resolved';
  return `<span class="disposition-chip ${escapeHtml(state)}">${label} (${Number(qty).toLocaleString('en-PH')})</span>`;
}

function renderSaleReturnExisting_(sale, containerId = 'saleReturnExisting', modal = 'return') {
  const container = $(`#${containerId}`);
  if (!container) return;
  const returns = saleReturns.filter((item) => item.saleId === sale.saleId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!returns.length) {
    container.innerHTML = '<div class="empty-state"><p>No returns recorded</p><small>This sale has no recorded refund, replacement, or quarantine activity.</small></div>';
    return;
  }
  container.innerHTML = `
    <div class="sale-return-section-head">
      <span class="label-text">Recorded Returns</span>
      <p class="field-hint">Complete the refund/replacement and inspect quarantine stock.</p>
    </div>
    <div class="sale-return-existing-list">
      ${returns.map((record) => {
        const lines = saleReturnItems.filter((item) => item.returnId === record.id);
        const hasRefund = lines.some((item) => item.actionType === 'refund');
        const hasReplacement = lines.some((item) => item.actionType === 'replacement');
        const pendingActions = [];
        if (hasRefund && !record.refundResolvedAt) {
          pendingActions.push(`<button class="button sale-return-action-btn refund-btn" type="button" data-complete-return-refund="${escapeHtml(record.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg><span>Complete ${money(record.refundAmount)} Refund</span></button>`);
        }
        if (hasReplacement && !record.replacementReleasedAt) {
          pendingActions.push(`<button class="button sale-return-action-btn replacement-btn" type="button" data-release-replacement="${escapeHtml(record.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg><span>Release Replacement</span></button>`);
        }
        const financialAction = pendingActions.length ? `<div class="sale-return-record-actions">${pendingActions.join('')}</div>` : '';
        return `<article class="sale-return-record">
          <div class="sale-return-record-head">
            <div class="sale-return-record-meta">
              <span class="sale-return-record-id">${escapeHtml(record.id)}</span>
              <span class="sale-type-pill return">${escapeHtml([hasRefund ? 'Refund' : '', hasReplacement ? 'Replacement' : '', lines.some((item) => item.actionType === 'return') ? 'Return Only' : ''].filter(Boolean).join(' + '))}</span>
              <span class="sale-return-record-status"><span class="status-pulse-dot"></span>${escapeHtml(record.status)}</span>
            </div>
            ${record.reason ? `<div class="sale-return-record-reason-tag"><span class="reason-label">Reason:</span> <span class="sale-return-record-reason">${escapeHtml(record.reason)}</span></div>` : ''}
          </div>
          ${financialAction}
          ${lines.map((line) => {
            const name = allProducts.find((product) => product.id === line.productId)?.name || line.productId;
            const actionBadge = line.actionType === 'refund'
              ? `<span class="sale-item-action-badge refund"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Refund${Number(line.refundAmount || 0) > 0 ? ` · ${money(line.refundAmount)}` : ''}</span>`
              : line.actionType === 'replacement'
              ? `<span class="sale-item-action-badge replacement"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>Replace${Number(line.replacementQty || 0) > 0 ? ` · ${Number(line.replacementQty).toLocaleString('en-PH')} qty` : ''}</span>`
              : `<span class="sale-item-action-badge return-only"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg>Return Only</span>`;

            const isBundle = allProducts.find((product) => product.id === line.productId)?.productType === 'bundle';
            if (isBundle) {
              const componentLots = inventoryReturnLots.filter((lot) => lot.returnItemId === line.id);
              const components = Object.values(componentLots.reduce((groups, lot) => {
                const group = groups[lot.productId] ||= { productId: lot.productId, qty: 0, states: [] };
                group.qty += Number(lot.qty || 0); group.states.push(lot.state);
                return groups;
              }, {}));
              return `<div class="return-item-group bundle-group">
                <div class="bundle-group-header">
                  <div class="bundle-group-info">
                    <span class="item-type-pill bundle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>Bundle</span>
                    <strong class="bundle-group-name">${escapeHtml(name)}</strong>
                    ${actionBadge}
                  </div>
                  <span class="bundle-group-badge">${components.length} component${components.length === 1 ? '' : 's'}</span>
                </div>
                <div class="bundle-components-list">
                  ${components.map((component) => {
                    const componentName = allProducts.find((product) => product.id === component.productId)?.name || component.productId;
                    const state = component.states.every((value) => value === component.states[0]) ? component.states[0] : 'mixed_resolved';
                    return `<div class="bundle-component-row ${state !== 'quarantine' ? 'is-resolved' : ''}">
                      <div class="bundle-component-info">
                        <span class="bundle-tree-indicator">↳</span>
                        <strong class="bundle-component-name">${escapeHtml(componentName)}</strong>
                        ${returnDispositionChip_(state, component.qty)}
                      </div>
                      <div class="sale-return-resolution-actions">
                        ${state === 'quarantine' ? returnResolutionButtons_(`data-resolve-bundle-return-component="${escapeHtml(line.id)}" data-component-product="${escapeHtml(component.productId)}"`) : '<span class="sale-return-resolved-pill">Resolved</span>'}
                      </div>
                    </div>`;
                  }).join('') || '<div class="sale-return-complete">No component quarantine lots were found for this bundle return.</div>'}
                </div>
              </div>`;
            }
            const isQuarantine = line.condition === 'quarantine';
            return `<div class="return-item-group single-group ${!isQuarantine ? 'is-resolved' : ''}">
              <div class="single-item-row">
                <div class="single-item-info">
                  <span class="item-type-pill individual"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>Single</span>
                  <strong class="single-item-name">${escapeHtml(name)}</strong>
                  ${actionBadge}
                  ${returnDispositionChip_(line.condition, line.qty)}
                </div>
                <div class="sale-return-resolution-actions">
                  ${isQuarantine ? returnResolutionButtons_(`data-resolve-sale-return="${escapeHtml(line.id)}"`) : '<span class="sale-return-resolved-pill">Resolved</span>'}
                </div>
              </div>
            </div>`;
          }).join('')}
        </article>`;
      }).join('')}
    </div>`;
  container.querySelectorAll('[data-complete-return-refund]').forEach((button) => button.addEventListener('click', () => resolveSaleReturnFinancial_(sale, button.dataset.completeReturnRefund, modal)));
  container.querySelectorAll('[data-release-replacement]').forEach((button) => button.addEventListener('click', () => releaseSaleReplacement_(sale, button.dataset.releaseReplacement, modal)));
  container.querySelectorAll('[data-resolve-sale-return]').forEach((button) => button.addEventListener('click', () => resolveSaleReturnItem_(sale, button.dataset.resolveSaleReturn, button.dataset.resolution, modal)));
  container.querySelectorAll('[data-resolve-bundle-return-component]').forEach((button) => button.addEventListener('click', () => resolveBundleReturnComponent_(sale, button.dataset.resolveBundleReturnComponent, button.dataset.componentProduct, button.dataset.resolution, modal)));
}

function updateSaleReturnLineAction_(sale, saleItemId) {
  const qty = Number(document.querySelector(`[data-sale-return-qty="${saleItemId}"]`)?.value || 0);
  const action = document.querySelector(`[data-return-action="${saleItemId}"]`)?.value || '';
  const line = document.querySelector(`[data-sale-return-line="${saleItemId}"]`);
  const refundField = document.querySelector(`[data-refund-field="${saleItemId}"]`);
  const replacementField = document.querySelector(`[data-replacement-field="${saleItemId}"]`);
  if (line) line.classList.toggle('is-selected', qty > 0 && Boolean(action));
  if (refundField) refundField.hidden = action !== 'refund' || qty <= 0;
  if (replacementField) replacementField.hidden = action !== 'replacement' || qty <= 0;
  const saleItem = sale.items.find((item) => item.saleItemId === saleItemId);
  const refundInput = document.querySelector(`[data-refund-amount="${saleItemId}"]`);
  if (refundInput) {
    if (action === 'refund' && qty > 0 && document.activeElement !== refundInput) refundInput.value = (qty * Number(saleItem?.price || 0)).toFixed(2);
    if (action !== 'refund' || qty <= 0) refundInput.value = '0.00';
  }
  const replacementQty = document.querySelector(`[data-replacement-qty="${saleItemId}"]`);
  if (replacementQty) replacementQty.value = qty > 0 ? String(qty) : '0';
}

function openSaleReturnDialog(sale) {
  const dialog = $('#saleReturnDialog');
  if (!dialog) return;
  $('#saleReturnTitle').textContent = `Return ${sale.saleId}`;
  $('#saleReturnSubtitle').textContent = `${displayCustomerName(sale.customerName)} · returned stock starts in quarantine.`;
  $('#saleReturnSummary').innerHTML = `
    <div class="sale-return-summary-card">
      <div class="sale-return-summary-info">
        <div class="sale-return-id-row">
          <span class="sale-return-id-badge">${escapeHtml(sale.saleId)}</span>
          <span class="sale-type-pill ${sale.paymentType === 'credit' ? 'credit' : 'cash'}">${escapeHtml(sale.paymentType === 'credit' ? 'Credit Sale' : 'Cash Sale')}</span>
        </div>
        <span class="sale-return-summary-cust">${escapeHtml(displayCustomerName(sale.customerName))}</span>
      </div>
      <div class="sale-return-summary-totals">
        <div class="sale-return-total-col">
          <span class="sale-return-total-label">Total Sale</span>
          <strong class="sale-return-total-val">${money(sale.total)}</strong>
        </div>
        ${sale.paymentType === 'credit' ? `
        <div class="sale-return-total-col balance">
          <span class="sale-return-total-label">Credit Balance</span>
          <strong class="sale-return-total-val text-gold">${money(sale.creditBalance)}</strong>
        </div>` : ''}
      </div>
    </div>`;
  $('#saleReturnLines').innerHTML = (sale.items || []).map((item) => {
    const availableQty = saleReturnAvailableQty_(item);
    return `<div class="sale-return-line ${availableQty <= 0 ? 'is-exhausted' : ''}" data-sale-return-line="${escapeHtml(item.saleItemId)}">
      <div class="sale-return-line-header">
        <div class="sale-return-item-info">
          <strong class="sale-return-item-name">${escapeHtml(item.name)}</strong>
        </div>
        <div class="sale-return-item-chips">
          <span class="sale-return-chip sold">Sold: ${Number(item.qty).toLocaleString('en-PH')} ${escapeHtml(item.unit)}</span>
          <span class="sale-return-chip ${availableQty > 0 ? 'available' : 'zero'}">Avail to return: ${availableQty.toLocaleString('en-PH')}</span>
        </div>
      </div>
      <div class="sale-return-line-controls">
        <div class="sale-return-qty-wrap">
          <label class="sale-return-control-label" for="return-qty-${escapeHtml(item.saleItemId)}">Return Qty</label>
          <input id="return-qty-${escapeHtml(item.saleItemId)}" class="sale-return-qty-input" data-sale-return-qty="${escapeHtml(item.saleItemId)}" data-max-qty="${availableQty}" data-sale-item-id="${escapeHtml(item.saleItemId)}" type="number" min="0" max="${availableQty}" step="0.001" value="0" aria-label="Returned quantity for ${escapeHtml(item.name)}" ${availableQty <= 0 ? 'disabled' : ''}/>
        </div>
        <div class="sale-return-action-wrap">
          <label class="sale-return-control-label">Action</label>
          <select data-return-action="${escapeHtml(item.saleItemId)}" aria-label="Return action for ${escapeHtml(item.name)}" ${availableQty <= 0 ? 'disabled' : ''}><option value="">Select action</option><option value="refund">Refund</option><option value="replacement">Replace</option></select>
        </div>
        <div data-refund-field="${escapeHtml(item.saleItemId)}" class="sale-return-refund-item-field" hidden>
          <label class="sale-return-control-label">Refund Amount</label>
          <div class="input-with-prefix"><span class="input-prefix">PHP</span><input class="sale-return-amount-input" data-refund-amount="${escapeHtml(item.saleItemId)}" type="number" min="0.01" step="0.01" value="0.00" aria-label="Refund amount for ${escapeHtml(item.name)}" /></div>
        </div>
        <div data-replacement-field="${escapeHtml(item.saleItemId)}" class="sale-return-replacement-field" hidden>
          <div class="sale-return-repl-divider" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="repl-arrow-icon"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </div>
          <div class="sale-return-repl-select-wrap">
            <label class="sale-return-control-label">Replacement</label>
            <strong class="sale-return-same-item">Same item: ${escapeHtml(item.name)}</strong>
            <input data-replacement-product="${escapeHtml(item.saleItemId)}" type="hidden" value="${escapeHtml(item.productId)}" />
          </div>
          <div class="sale-return-repl-qty-wrap">
            <label class="sale-return-control-label">Repl Qty</label>
            <input class="sale-return-qty-input" data-replacement-qty="${escapeHtml(item.saleItemId)}" type="number" min="0.001" step="0.001" value="0" readonly aria-label="Replacement quantity for ${escapeHtml(item.name)}"/>
          </div>
        </div>
      </div>
    </div>`;
  }).join('') || '<div class="empty-state"><p>No sale items recorded</p></div>';
  $('#saleReturnReason').value = '';
  $('#saleReturnError').textContent = '';
  $('#saleReturnLines').querySelectorAll('[data-sale-return-qty]').forEach((input) => input.addEventListener('input', () => {
    const max = Number(input.dataset.maxQty || 0);
    if (Number(input.value || 0) > max) input.value = max;
    updateSaleReturnLineAction_(sale, input.dataset.saleItemId);
  }));
  $('#saleReturnLines').querySelectorAll('[data-return-action]').forEach((input) => input.addEventListener('change', () => updateSaleReturnLineAction_(sale, input.dataset.returnAction)));
  (sale.items || []).forEach((item) => updateSaleReturnLineAction_(sale, item.saleItemId));
  initCustomDropdowns(dialog);
  if (!dialog.open) dialog.showModal();
  const returnBody = dialog.querySelector('.sale-return-body');
  if (returnBody) returnBody.scrollTop = 0;
}

function openSaleReturnHistoryDialog(sale) {
  const dialog = $('#saleReturnHistoryDialog');
  if (!dialog) return;
  $('#saleReturnHistoryTitle').textContent = `Return History ${sale.saleId}`;
  $('#saleReturnHistorySubtitle').textContent = `${displayCustomerName(sale.customerName)} · refund, replacement, and quarantine actions.`;
  $('#saleReturnHistorySummary').innerHTML = `<strong>${escapeHtml(sale.saleId)}</strong><span>${escapeHtml(sale.paymentType === 'credit' ? `Credit sale · balance ${money(sale.creditBalance)}` : `Cash sale · total ${money(sale.total)}`)}</span>`;
  $('#saleReturnHistoryError').textContent = '';
  renderSaleReturnExisting_(sale, 'saleReturnHistoryExisting', 'history');
  if (!dialog.open) dialog.showModal();
}

async function resolveSaleReturnItem_(sale, returnItemId, resolution, modal = 'return') {
  const labels = { restocked: 'restock this item', supplier_return: 'mark this item for supplier return', disposed: 'dispose this item' };
  if (!await askConfirmation({ title: 'Resolve Returned Item', eyebrow: 'SALES RETURN', subtitle: 'Confirm inventory disposition', message: `Do you want to ${labels[resolution]}?`, warning: 'This action removes the item from quarantine and is recorded in the audit history.', confirmText: 'Confirm', confirmType: resolution === 'disposed' ? 'danger' : 'primary' })) return;
  try { await api('resolveSaleReturnItem', { returnItemId, resolution }); await refresh(false); modal === 'history' ? openSaleReturnHistoryDialog(sale) : openSaleReturnDialog(sale); showToast('Returned item resolved.', 'success'); } catch (error) { $(`#saleReturn${modal === 'history' ? 'History' : ''}Error`).textContent = error.message; }
}

async function resolveBundleReturnComponent_(sale, returnItemId, productId, resolution, modal = 'history') {
  const component = allProducts.find((item) => item.id === productId);
  const labels = { restocked: 'restock this component', supplier_return: 'return this component to the supplier', disposed: 'dispose this component' };
  if (!await askConfirmation({ title: 'Resolve Bundle Component', eyebrow: 'SALES RETURN', subtitle: component?.name || 'Confirm component disposition', message: `Do you want to ${labels[resolution]}?`, warning: 'Only this bundle component is affected. The other returned components remain in quarantine until individually resolved.', confirmText: 'Confirm', confirmType: resolution === 'disposed' ? 'danger' : 'primary' })) return;
  try { await api('resolveBundleReturnComponent', { returnItemId, productId, resolution }); await refresh(false); modal === 'history' ? openSaleReturnHistoryDialog(sale) : openSaleReturnDialog(sale); showToast('Bundle component resolved.', 'success'); } catch (error) { $(`#saleReturn${modal === 'history' ? 'History' : ''}Error`).textContent = error.message; }
}

async function resolveSaleReturnFinancial_(sale, returnId, modal = 'return') {
  if (!await askConfirmation({ title: 'Complete Refund', eyebrow: 'SALES RETURN', subtitle: 'Confirm financial adjustment', message: 'Confirm that the customer refund has been completed.', warning: 'For credit sales, this reduces the outstanding customer balance. Cash refunds are recorded in the audit trail.', confirmText: 'Complete Refund', confirmType: 'primary' })) return;
  try { await api('completeSaleRefund', { returnId }); await refresh(false); modal === 'history' ? openSaleReturnHistoryDialog(sale) : openSaleReturnDialog(sale); showToast('Refund completed.', 'success'); } catch (error) { $(`#saleReturn${modal === 'history' ? 'History' : ''}Error`).textContent = error.message; }
}

async function releaseSaleReplacement_(sale, returnId, modal = 'return') {
  if (!await askConfirmation({ title: 'Release Replacement', eyebrow: 'SALES RETURN', subtitle: 'Confirm zero-value replacement release', message: 'Release the selected replacement stock to the customer?', warning: 'Replacement stock is deducted using FIFO and remains linked to this return.', confirmText: 'Release Replacement', confirmType: 'primary' })) return;
  try { await api('releaseSaleReplacement', { returnId }); await refresh(false); modal === 'history' ? openSaleReturnHistoryDialog(sale) : openSaleReturnDialog(sale); showToast('Replacement released.', 'success'); } catch (error) { $(`#saleReturn${modal === 'history' ? 'History' : ''}Error`).textContent = error.message; }
}

function openCreditHistory(historyId) {
  const customer = customers.find((item) => item.id === historyId);
  const isCustomerHistory = Boolean(customer);
  const account = creditAccounts.find((item) => item.creditId === historyId);
  const saleRecord = salesHistory.find((item) => item.saleId === historyId);
  const openingRecord = openingCreditAccounts.find((item) => item.creditId === historyId);
  const customerCreditAccounts = isCustomerHistory
    ? [
      ...salesHistory.filter((item) => item.customerId === customer.id && String(item.paymentType || '').toLowerCase() === 'credit').map((item) => ({ creditId: item.saleId, total: item.total })),
      ...openingCreditAccounts.filter((item) => item.customerId === customer.id).map((item) => ({ creditId: item.creditId, total: item.total })),
    ]
    : [];
  const customerCreditIds = new Set(customerCreditAccounts.map((item) => item.creditId));
  const payments = isCustomerHistory
    ? creditPayments.filter((item) => customerCreditIds.has(item.creditId || item.saleId))
    : creditPayments.filter((item) => (item.creditId || item.saleId) === historyId);

  const customerName = customer?.name || account?.customerName || saleRecord?.customerName || openingRecord?.customerName || payments[0]?.customerName || 'Customer';
  const customerId = customer?.id || account?.customerId || saleRecord?.customerId || openingRecord?.customerId || payments[0]?.customerId || '';
  const total = isCustomerHistory ? customerCreditAccounts.reduce((sum, item) => sum + Number(item.total || 0), 0) : account ? Number(account.total) : Number(saleRecord?.total || openingRecord?.total || 0);
  const paid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const balance = isCustomerHistory ? Math.max(total - paid, 0) : account ? Number(account.balance) : Math.max(total - paid, 0);
  const paymentCreditId = isCustomerHistory ? creditAccounts.find((item) => item.customerId === customer.id && Number(item.balance || 0) > 0.00001)?.creditId : historyId;
  const percentPaid = total > 0 ? Math.min(Math.round((paid / total) * 100), 100) : 0;

  const titleEl = $('#creditHistoryCustomerName');
  const subtitleEl = $('#creditHistorySaleSubtitle');
  if (titleEl) titleEl.textContent = displayCustomerName(customerName);
  if (subtitleEl) subtitleEl.textContent = isCustomerHistory
    ? `All credit accounts - ${customerId}`
    : `${account?.sourceLabel || (openingRecord ? 'Previous Balance' : 'Credit Sale')}: ${account?.reference || openingRecord?.reference || historyId}${customerId ? ` - ${customerId}` : ''}`;

  const summaryEl = $('#creditHistoryModalSummary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="credit-modal-stat">
        <span class="credit-modal-stat-label">Total Credit</span>
        <strong class="credit-modal-stat-val">${money(total)}</strong>
      </div>
      <div class="credit-modal-stat emerald">
        <span class="credit-modal-stat-label">Payments Made (${percentPaid}%)</span>
        <strong class="credit-modal-stat-val emerald">${money(paid)}</strong>
      </div>
      <div class="credit-modal-stat gold">
        <span class="credit-modal-stat-label">Remaining Balance</span>
        <strong class="credit-modal-stat-val gold">${money(balance)}</strong>
      </div>
    `;
  }

  const listEl = $('#creditHistoryModalList');
  if (listEl) {
    if (payments.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding: 24px 12px;">
          <p>No payments recorded yet</p>
          <small>No payments have been posted for this customer credit.</small>
        </div>
      `;
    } else {
      listEl.innerHTML = `
        <div class="credit-modal-payments-table">
          <div class="credit-modal-payments-head">
            <span>Payment Date</span>
            <span>Amount</span>
            <span>Reference / Notes</span>
            <span style="text-align:right;">Action</span>
          </div>
          ${payments.map((p) => `
            <div class="credit-modal-payments-row">
              <div class="credit-modal-date-col">
                <strong class="credit-date-text">${escapeHtml(p.date ? new Date(p.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '')}</strong>
                <span class="credit-time-text">${escapeHtml(p.date ? new Date(p.date).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : '')}</span>
              </div>
              <div class="credit-modal-amount-col">
                <span class="payment-collected-badge">+ ${money(p.amount)}</span>
              </div>
              <div class="credit-modal-notes-col">
                <span class="credit-history-notes">${escapeHtml(p.notes || 'Payment settlement')}</span>
              </div>
              <div class="credit-modal-action-col">
                <button class="icon-button danger-icon credit-modal-del-btn" data-modal-delete-payment="${escapeHtml(p.id)}" aria-label="Delete payment" title="Delete payment record"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-1-1-1-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  const recordBtn = $('#creditHistoryRecordNewBtn');
  if (recordBtn) {
    recordBtn.style.display = balance > 0 && paymentCreditId ? 'inline-flex' : 'none';
    recordBtn.onclick = () => {
      $('#creditHistoryDialog').close();
      openCreditPayment(paymentCreditId);
    };
  }

  listEl.querySelectorAll('[data-modal-delete-payment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteCreditPayment(btn.dataset.modalDeletePayment);
      openCreditHistory(historyId);
    });
  });

  const dialog = $('#creditHistoryDialog');
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
  }
}

function openCreditPayment(creditId) {
  const account = creditAccounts.find((item) => item.creditId === creditId);
  if (!account) return;
  pendingCreditAccount = account;
  $('#creditCustomer').value = displayCustomerName(account.customerName);
  $('#creditSaleId').value = account.sourceLabel || 'Credit Account';
  $('#creditBalance').value = account.balance.toFixed(2);
  $('#creditAmount').value = '0.00';
  $('#creditAmount').max = account.balance.toFixed(2);
  $('#creditNotes').value = '';
  $('#creditPaymentError').textContent = '';
  $('#creditPaymentDialog').showModal();
}

async function deleteCreditPayment(paymentId) {
  const payment = creditPayments.find((item) => item.id === paymentId);
  if (!payment) return;
  const confirmed = await askConfirmation({
    title: 'Delete Credit Payment',
    eyebrow: 'CREDIT PAYMENTS',
    subtitle: 'Correct a payment mistake',
    message: `Delete the <strong class="confirm-highlight-name">${money(payment.amount)}</strong> payment from ${escapeHtml(displayCustomerName(payment.customerName))}?`,
    warning: 'This payment will be removed and the credit balance will increase again.',
    confirmText: 'Delete Payment',
    confirmType: 'danger',
  });
  if (!confirmed) return;
  try {
    await api('deleteCreditPayment', { paymentId, branchId: activeBranchId });
    // Optimistic: remove payment from local array and recalculate credit accounts
    creditPayments = creditPayments.filter((p) => p.id !== paymentId);
    creditAccounts = calculateOutstandingCreditAccounts(salesHistory, creditPayments, openingCreditAccounts);
    renderInventory();
    showToast('Credit payment deleted. Balance updated.', 'success');
    backgroundRefresh();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderTransfers() {
  const term = ($('#searchInput')?.value || '').trim().toLowerCase();
  const table = $('#inventoryTable');
  if (!table) return;
  const grouped = new Map();
  transfers.forEach((transfer) => {
    const key = transfer.batchId || transfer.id;
    const group = grouped.get(key) || { ...transfer, id: key, isBatch: Boolean(transfer.batchId), members: [] };
    group.members.push(transfer);
    grouped.set(key, group);
  });
  const rows = [...grouped.values()].filter((transfer) => `${transfer.id} ${transfer.sourceBranchName} ${transfer.destinationBranchName} ${transfer.members.map((item) => item.productName).join(' ')} ${transfer.status}`.toLowerCase().includes(term));
  const action = (transfer) => {
    if (transfer.status === 'Draft' && transfer.sourceBranchId === activeBranchId) {
      return `
        <button class="icon-button primary-icon" data-transfer-action="dispatch" data-transfer-id="${transfer.id}" aria-label="Dispatch transfer" title="Dispatch transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></button>
        <button class="icon-button danger-icon" data-transfer-action="cancel" data-transfer-id="${transfer.id}" aria-label="Cancel transfer" title="Cancel transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      `;
    }
    if (transfer.status === 'In Transit' && transfer.destinationBranchId === activeBranchId) {
      return `
        <button class="icon-button success-icon" data-transfer-action="receive" data-transfer-id="${transfer.id}" aria-label="Receive transfer" title="Receive transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
      `;
    }
    if (transfer.status === 'In Transit' && transfer.sourceBranchId === activeBranchId) {
      return `
        <button class="icon-button danger-icon" data-transfer-action="cancel" data-transfer-id="${transfer.id}" aria-label="Cancel transfer" title="Cancel transfer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      `;
    }
    return '<span style="color:var(--text-muted);font-size:13px;font-weight:600;padding-left:4px;">&mdash;</span>';
  };
  table.innerHTML = `
    <div class="table-row table-header">
      <span>Transfer</span>
      <span>Route</span>
      <span>Product</span>
      <span>Status</span>
      <span>Action</span>
    </div>
    ${rows.map((transfer) => `
      <div class="table-row">
        <div class="product-cell">
          <strong class="product-name">${escapeHtml(transfer.id)}</strong>
          <span class="product-meta">${escapeHtml(transfer.createdAt ? new Date(transfer.createdAt).toLocaleDateString('en-PH') : '')}</span>
        </div>
        <div class="row-middle-cells">
          <span class="branch-address">${escapeHtml(transfer.sourceBranchName)} to ${escapeHtml(transfer.destinationBranchName)}</span>
          <div class="product-cell">
            <strong class="product-name">${escapeHtml(transfer.isBatch ? `${transfer.members.length} transfer items` : transfer.productName)}</strong>
            <span class="product-meta">${escapeHtml(transfer.isBatch ? transfer.members.map((item) => `${item.productName} (${item.qty} ${item.unit})`).join(' • ') : `${transfer.qty} ${transfer.unit}`)}</span>
          </div>
          <span class="stock-pill ${transfer.status === 'Received' ? 'stock-normal' : transfer.status === 'Cancelled' ? 'stock-low' : 'category-badge'}">${escapeHtml(transfer.status)}</span>
        </div>
        <div class="row-action-cell">
          <span class="table-actions">${action(transfer)}</span>
        </div>
      </div>
    `).join('') || '<div class="empty-state"><p>No stock transfers found</p><small>Create a transfer from the selected branch.</small></div>'}
  `;
  table.querySelectorAll('[data-transfer-action]').forEach((button) => button.addEventListener('click', () => handleTransferAction(button)));
}

async function handleTransferAction(button) {
  const action = button.dataset.transferAction;
  const rawTransfer = transfers.find((item) => item.batchId === button.dataset.transferId) || transfers.find((item) => item.id === button.dataset.transferId);
  const transfer = rawTransfer?.batchId ? { ...rawTransfer, isBatch: true, members: transfers.filter((item) => item.batchId === rawTransfer.batchId) } : rawTransfer;
  if (!transfer || !['dispatch', 'receive', 'cancel'].includes(action)) return;
  if (action === 'receive') {
    openTransferReceiptDialog_(transfer);
    return;
  }

  const copy = {
    dispatch: {
      title: 'Dispatch Transfer',
      eyebrow: 'STOCK TRANSFERS',
      subtitle: 'Confirm stock departure',
      confirmText: 'Dispatch Transfer',
      confirmType: 'primary',
      warning: transfer.isBatch ? `This will dispatch all ${transfer.members.length} component lines from ${transfer.sourceBranchName}.` : `This will deduct ${transfer.qty} ${transfer.unit} from ${transfer.sourceBranchName} and mark the transfer as In Transit.`
    },
    receive: {
      title: 'Receive Transfer',
      eyebrow: 'STOCK TRANSFERS',
      subtitle: 'Confirm stock arrival',
      confirmText: 'Receive Stock',
      confirmType: 'success',
      warning: transfer.isBatch ? `This will receive all ${transfer.members.length} component lines into ${transfer.destinationBranchName}.` : `This will add ${transfer.qty} ${transfer.unit} to ${transfer.destinationBranchName} inventory.`
    },
    cancel: {
      title: 'Cancel Transfer',
      eyebrow: 'STOCK TRANSFERS',
      subtitle: 'Confirm transfer cancellation',
      confirmText: 'Cancel Transfer',
      confirmType: 'danger',
      warning: transfer.status === 'In Transit'
        ? (transfer.isBatch ? `This will return all ${transfer.members.length} component lines to ${transfer.sourceBranchName} inventory.` : `This will return ${transfer.qty} ${transfer.unit} back to ${transfer.sourceBranchName} inventory.`)
        : 'This will cancel the draft transfer. No stock has been moved.'
    }
  }[action];

  const confirmed = await askConfirmation({
    title: copy.title,
    eyebrow: copy.eyebrow,
    subtitle: copy.subtitle,
    message: `Are you sure you want to ${action} <strong class="confirm-highlight-name">${escapeHtml(transfer.isBatch ? transfer.id : transfer.productName)}</strong>${transfer.isBatch ? ` (${transfer.members.length} component lines)` : ` (${transfer.qty} ${escapeHtml(transfer.unit)})`}?`,
    warning: copy.warning,
    confirmText: copy.confirmText,
    confirmType: copy.confirmType
  });

  if (!confirmed) return;

  try {
    const result = transfer.isBatch
      ? await api('processTransferBatch', { batchId: transfer.batchId, batchAction: action })
      : await api({ dispatch: 'dispatchTransfer', receive: 'receiveTransfer', cancel: 'cancelTransfer' }[action], { transferId: transfer.id, branchId: activeBranchId });
    // Optimistic: update transfer status locally and re-render immediately
    const statusMap = { dispatch: 'In Transit', receive: 'Received', cancel: 'Cancelled' };
    const newStatus = statusMap[action];
    transfers = transfers.map((t) => (transfer.isBatch ? t.batchId === transfer.batchId : t.id === transfer.id) ? { ...t, status: newStatus } : t);
    renderInventory();
    showToast(`Transfer ${action === 'receive' ? 'received' : action === 'dispatch' ? 'dispatched' : 'cancelled'}.`, 'success');
    backgroundRefresh();
  } catch (error) {
    showToast(error.message || 'Failed to process transfer.', 'error');
  }
}

function openTransferReceiptDialog_(transfer) {
  pendingTransferReceipt = transfer;
  activeForm = 'receiveTransfer';
  const lines = transfer.isBatch ? transfer.members : [transfer];
  $('#modalEyebrow').textContent = 'STOCK TRANSFERS';
  $('#dialogTitle').textContent = 'Receive transfer';
  $('#modalSubtitle').textContent = 'Inspect each line before it enters available inventory.';
  $('#modalIconWrap').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>';
  $('#formSubmit').innerHTML = '<span class="button-text">Receive stock</span>';
  $('#formError').textContent = '';
  $('#formDialog').dataset.formLayout = 'scrollable';
  $('#formDialog').dataset.formType = 'receiveTransfer';
  const container = $('#formFields');
  container.scrollTop = 0;

  const sourceBranch = branches.find((b) => b.id === transfer.sourceBranchId)?.name || transfer.sourceBranchName || transfer.sourceBranchId || 'Source Branch';
  const destBranch = branches.find((b) => b.id === transfer.destinationBranchId)?.name || transfer.destinationBranchName || transfer.destinationBranchId || 'Destination Branch';

  const catalog = (allProducts && allProducts.length ? allProducts : products) || [];
  const bundleProducts = catalog.filter((p) => p.productType === 'bundle').sort((a, b) => b.name.length - a.name.length);

  const getLineGroup = (line) => {
    const note = (line.notes || '').trim();

    // 1. Direct bundle note: "Bundle: <bundleName>"
    if (/^bundle:/i.test(note)) {
      const raw = note.replace(/^bundle:\s*/i, '').trim();
      const matched = bundleProducts.find((p) =>
        raw.toLowerCase() === p.name.toLowerCase() ||
        raw.toLowerCase().startsWith(p.name.toLowerCase() + ' -')
      );
      if (matched) return { type: 'bundle', name: matched.name, key: `bundle:${matched.id}` };
      const dashIdx = raw.lastIndexOf(' - ');
      const bundleName = dashIdx > 0 ? raw.substring(0, dashIdx).trim() : raw;
      return { type: 'bundle', name: bundleName || 'Bundle / Set', key: `bundle:${(bundleName || 'bundle').toLowerCase()}` };
    }

    // 2. Note "Bundle <id>:" pattern
    const bundleIdMatch = note.match(/^bundle\s+([A-Za-z0-9_-]+):?(.*)$/i);
    if (bundleIdMatch) {
      const id = bundleIdMatch[1].trim();
      const matched = catalog.find((p) => p.id === id);
      return { type: 'bundle', name: matched ? matched.name : `Bundle ${id}`, key: `bundle:${id.toLowerCase()}` };
    }

    // 3. Note "Set: <setName>" pattern
    if (/^set:/i.test(note)) {
      const raw = note.replace(/^set:\s*/i, '').trim();
      const dashIdx = raw.lastIndexOf(' - ');
      const setName = dashIdx > 0 ? raw.substring(0, dashIdx).trim() : raw;
      return { type: 'bundle', name: setName || 'Set', key: `bundle:${(setName || 'set').toLowerCase()}` };
    }

    // 4. Product itself is a bundle product
    const directProduct = catalog.find((p) => p.id === line.productId);
    if (directProduct && directProduct.productType === 'bundle') {
      return { type: 'bundle', name: directProduct.name, key: `bundle:${directProduct.id}` };
    }

    // 5. Standalone individual product
    return { type: 'individual', name: 'Individual Products', key: 'individual' };
  };

  const groupMap = new Map();
  lines.forEach((line) => {
    const grp = getLineGroup(line);
    if (!groupMap.has(grp.key)) {
      groupMap.set(grp.key, { type: grp.type, name: grp.name, lines: [] });
    }
    groupMap.get(grp.key).lines.push(line);
  });
  const lineGroups = [...groupMap.values()];

  container.innerHTML = `
    <div class="form-field-group full-field transfer-receive-summary-card">
      <div class="transfer-receive-summary-head">
        <div class="transfer-receive-id-wrap">
          <span class="category-badge">MANIFEST</span>
          <strong>${escapeHtml(transfer.id || transfer.batchId || 'Transfer')}</strong>
        </div>
        <span class="stock-pill category-badge">${lines.length} Line${lines.length === 1 ? '' : 's'}</span>
      </div>
      <div class="transfer-receive-route">
        <span><b>From:</b> ${escapeHtml(sourceBranch)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="route-arrow"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <span><b>To:</b> ${escapeHtml(destBranch)}</span>
      </div>
      <p class="transfer-receive-hint">Accepted units enter available stock immediately. Quarantined units are isolated for inspection.</p>
    </div>

    <div class="form-field-group full-field transfer-receive-batch-wrap">
      <div class="transfer-receive-grid-wrap">
        <div class="transfer-receive-grid-table">
          <div class="transfer-receive-grid-header">
            <span class="col-product">Transferred Product</span>
            <span class="col-total">Shipped</span>
            <span class="col-accept">Accept to Stock</span>
            <span class="col-quarantine">Quarantine</span>
            <span class="col-status">Status</span>
          </div>
          <div class="transfer-receive-lines">
            ${lineGroups.map((group) => `
              <div class="transfer-receive-group" data-group-type="${group.type}">
                <div class="transfer-group-header">
                  <div class="transfer-group-title-wrap">
                    <span class="transfer-group-icon ${group.type === 'bundle' ? 'bundle-icon' : 'individual-icon'}" aria-hidden="true">
                      ${group.type === 'bundle'
                        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>'
                        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>'
                      }
                    </span>
                    <div class="transfer-group-title-col">
                      <span class="transfer-group-type-label">${group.type === 'bundle' ? 'Bundle / Set' : 'Individual Products'}</span>
                      <strong class="transfer-group-name">${escapeHtml(group.type === 'bundle' ? group.name : 'Standalone Products')}</strong>
                    </div>
                    <span class="stock-pill category-badge ${group.type === 'bundle' ? 'bundle-pill' : 'individual-pill'}">
                      ${group.type === 'bundle' ? 'Bundle Set' : 'Individual'}
                    </span>
                  </div>
                  <span class="transfer-group-count">${group.lines.length} ${group.type === 'bundle' ? 'Component' : 'Product'}${group.lines.length === 1 ? '' : 's'}</span>
                </div>
                <div class="transfer-group-rows">
                  ${group.lines.map((line) => `
                    <div class="transfer-receive-grid-row ${group.type === 'bundle' ? 'is-bundle-component' : ''}" data-receipt-transfer="${escapeHtml(line.id)}" data-receipt-total="${line.qty}">
                      <div class="grid-cell col-product">
                        <div class="product-name-with-indicator">
                          ${group.type === 'bundle' ? '<span class="bundle-connector-dot" title="Bundle component"></span>' : ''}
                          <div class="product-name-block">
                            <strong class="receipt-product-name">${escapeHtml(line.productName)}</strong>
                            <span class="receipt-unit-hint">${escapeHtml(line.unit || 'unit')}</span>
                          </div>
                        </div>
                      </div>
                      <div class="grid-cell col-total">
                        <span class="shipped-badge">${Number(line.qty).toLocaleString('en-PH')}</span>
                      </div>
                      <div class="grid-cell col-accept">
                        <input name="acceptedQty" type="number" min="0" max="${line.qty}" step="0.001" value="${line.qty}" required aria-label="Accepted quantity" />
                      </div>
                      <div class="grid-cell col-quarantine">
                        <input name="quarantineQty" type="number" min="0" max="${line.qty}" step="0.001" value="0" required aria-label="Quarantine quantity" />
                      </div>
                      <div class="grid-cell col-status">
                        <span class="stock-pill category-badge in-transit-badge">In Transit</span>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="form-field-group full-field transfer-quarantine-reason-field">
      <label for="transferQuarantineReason">
        <span class="label-text">Inspection Reason (if quarantining units)</span>
      </label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <input id="transferQuarantineReason" name="quarantineReason" placeholder="Describe damage, discrepancy, or reason for quarantine" autocomplete="off" />
      </div>
      <p class="field-hint">Required only if any line has quarantined units.</p>
    </div>
  `;

  const formatQty = (n) => {
    const num = Math.round(Number(n) * 1000) / 1000;
    if (!Number.isFinite(num) || num <= 0) return '0';
    return String(num);
  };

  // Auto-balance acceptedQty and quarantineQty on input and ensure 0 if blank
  container.querySelectorAll('.transfer-receive-grid-row').forEach((row) => {
    const total = Number(row.dataset.receiptTotal) || 0;
    const acceptInput = row.querySelector('[name="acceptedQty"]');
    const quarantineInput = row.querySelector('[name="quarantineQty"]');
    if (!acceptInput || !quarantineInput) return;

    acceptInput.addEventListener('input', () => {
      const raw = acceptInput.value.trim();
      if (raw === '') {
        quarantineInput.value = formatQty(total);
        return;
      }
      const val = parseFloat(raw);
      if (!Number.isNaN(val)) {
        const clamped = Math.min(Math.max(0, val), total);
        if (clamped !== val) acceptInput.value = formatQty(clamped);
        quarantineInput.value = formatQty(total - clamped);
      }
    });

    acceptInput.addEventListener('blur', () => {
      if (acceptInput.value.trim() === '') {
        acceptInput.value = '0';
        quarantineInput.value = formatQty(total);
      }
    });

    quarantineInput.addEventListener('input', () => {
      const raw = quarantineInput.value.trim();
      if (raw === '') {
        acceptInput.value = formatQty(total);
        return;
      }
      const val = parseFloat(raw);
      if (!Number.isNaN(val)) {
        const clamped = Math.min(Math.max(0, val), total);
        if (clamped !== val) quarantineInput.value = formatQty(clamped);
        acceptInput.value = formatQty(total - clamped);
      }
    });

    quarantineInput.addEventListener('blur', () => {
      if (quarantineInput.value.trim() === '') {
        quarantineInput.value = '0';
        acceptInput.value = formatQty(total);
      }
    });
  });

  $('#formDialog').showModal();
}

function renderBranchSelector() {
  const selector = $('#branchSelector');
  if (!selector) return;
  const account = currentSession?.account;
  const activeBranches = sortByName_(branches.filter((branch) => branch.status === 'Active' && (account?.role !== 'staff' || branch.id === account.branchId)));
  if (activeBranches.length === 0) {
    activeBranches.push({ id: 'MAIN', name: 'Main Branch' });
  }
  if (!activeBranches.some((branch) => branch.id === activeBranchId)) activeBranchId = activeBranches[0]?.id || 'MAIN';
  selector.innerHTML = activeBranches.map((branch) => `<option value="${escapeHtml(branch.id)}">${escapeHtml(branch.name)}</option>`).join('');
  selector.value = activeBranchId;
  selector.disabled = account?.role === 'staff';
  updateCustomDropdown(selector);
  updateActiveBranchLabels();
  renderSidebarBranchMenu();
}

function updateActiveBranchLabels() {
  const branch = branches.find((item) => item.id === activeBranchId);
  const name = branch?.name || 'Main Branch';
  const status = branch?.status || 'Active';
  const sideLabel = $('#sidebarBranchName');
  if (sideLabel) sideLabel.textContent = name;
  const badge = $('#sidebarBranchBadge');
  if (badge) {
    const isOnline = status === 'Active';
    badge.className = `branch-status-badge ${isOnline ? 'online' : 'offline'}`;
    badge.innerHTML = `<span class="pulse-dot"></span><span class="status-text">${isOnline ? 'Online' : 'Offline'}</span>`;
  }
  renderSidebarBranchMenu();
}

function renderSidebarBranchMenu() {
  const menu = $('#sidebarBranchMenu');
  if (!menu) return;
  const account = currentSession?.account;
  const activeBranches = branches.filter((branch) => branch.status === 'Active' && (account?.role !== 'staff' || branch.id === account.branchId));
  if (activeBranches.length === 0) {
    activeBranches.push({ id: 'MAIN', name: 'Main Branch' });
  }
  menu.innerHTML = activeBranches.map((b) => `
    <div class="dropdown-option${b.id === activeBranchId ? ' selected' : ''}" role="option" data-value="${escapeHtml(b.id)}" tabindex="0">
      <div class="branch-option-content">
        <span class="branch-opt-name">${escapeHtml(b.name)}</span>
        <span class="branch-opt-type">${escapeHtml(b.type || 'Branch')}</span>
      </div>
      <svg class="opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  `).join('');

  menu.querySelectorAll('.dropdown-option').forEach((opt) => {
    opt.addEventListener('click', async (e) => {
      e.stopPropagation();
      const val = opt.dataset.value;
      const dropdown = $('#sidebarBranchDropdown');
      if (dropdown) closeDropdown(dropdown, $('#sidebarBranchTrigger'));
      await setActiveBranch(val);
    });
    opt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        opt.click();
      }
    });
  });
}

function initSidebarBranchSwitcher() {
  const trigger = $('#sidebarBranchTrigger');
  const dropdown = $('#sidebarBranchDropdown');
  if (!trigger || !dropdown) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('open');
    document.querySelectorAll('.custom-dropdown.open').forEach((d) => {
      if (d !== dropdown) closeDropdown(d, d.querySelector('.dropdown-trigger') || d.querySelector('button'));
    });
    if (isOpen) {
      closeDropdown(dropdown, trigger);
    } else {
      openDropdown(dropdown, trigger);
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const isOpen = dropdown.classList.contains('open');
      if (!isOpen) openDropdown(dropdown, trigger);
      const activeOpt = dropdown.querySelector('.dropdown-option.selected') || dropdown.querySelector('.dropdown-option');
      if (activeOpt) activeOpt.focus();
    } else if (e.key === 'Escape') {
      closeDropdown(dropdown, trigger);
    }
  });
}

async function setActiveBranch(branchId) {
  if (!await enforcePasswordResetLogout_()) return;
  if (branchId === activeBranchId) return;
  activeBranchId = branchId;
  localStorage.setItem(ACTIVE_BRANCH_KEY, activeBranchId);
  cart = [];
  renderCart();
  updateActiveBranchLabels();
  await refresh();
  showToast(`${branches.find((branch) => branch.id === branchId)?.name || 'Branch'} is now active.`, 'success');
}

let passwordResetLogoutInFlight_ = false;

async function enforcePasswordResetLogout_() {
  if (!currentSession?.token || !supabaseClient || passwordResetLogoutInFlight_) return !passwordResetLogoutInFlight_;
  const client = requireSupabase_();
  const { data: profile, error } = await client
    .from('profiles')
    .select('must_change_password, status')
    .eq('user_id', currentSession.account.id)
    .maybeSingle();

  if (!error && profile?.status === 'Active' && !profile.must_change_password) return true;
  passwordResetLogoutInFlight_ = true;
  try {
    await api('logout');
  } catch (_) {
    // Local session removal below still prevents continued POS use.
  }
  localStorage.removeItem(ADMIN_SESSION_KEY);
  currentSession = null;
  cart = [];
  renderCart();
  $('#authOverlay').hidden = false;
  await initAuth();
  showToast(profile?.must_change_password ? 'Your password was reset. Sign in with the temporary password to continue.' : 'Your account is unavailable.', 'info');
  return false;
}

/* ==========================================================================
   CART & CASH CHECKOUT
   ========================================================================== */
function updateCartScrollFade() {
  const container = $('#cartItems');
  if (!container) return;
  if (!cart.length) {
    container.classList.remove('can-scroll-down', 'can-scroll-up');
    return;
  }
  const scrollTolerance = 4;
  const canScrollDown = container.scrollHeight > container.clientHeight && (container.scrollTop + container.clientHeight < container.scrollHeight - scrollTolerance);
  const canScrollUp = container.scrollTop > scrollTolerance;

  container.classList.toggle('can-scroll-down', canScrollDown);
  container.classList.toggle('can-scroll-up', canScrollUp);
}

function updateReceiptScrollFade() {
  const container = $('#receiptDialog .receipt-body');
  if (!container) return;
  const scrollTolerance = 4;
  const canScrollDown = container.scrollHeight > container.clientHeight && (container.scrollTop + container.clientHeight < container.scrollHeight - scrollTolerance);
  const canScrollUp = container.scrollTop > scrollTolerance;

  container.classList.toggle('can-scroll-down', canScrollDown);
  container.classList.toggle('can-scroll-up', canScrollUp);
}

function hasSellingPriceOverride(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function getCartPriceBreakdown(item) {
  const overridePrice = hasSellingPriceOverride(item.overridePrice) ? Number(item.overridePrice) : (hasSellingPriceOverride(item.sellingPriceOverride) ? Number(item.sellingPriceOverride) : NaN);
  if (Number.isFinite(overridePrice) && overridePrice >= 0) {
    const qty = Number(item.qty) || 0;
    return [{ qty, sellingPrice: overridePrice, total: qty * overridePrice }];
  }
  let remaining = Number(item.qty) || 0;
  const batches = sellingPriceBatches.filter((batch) => batch.productId === item.id && batch.qty > 0);
  const lines = [];
  for (const batch of batches) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, batch.qty);
    lines.push({ qty, sellingPrice: batch.sellingPrice, total: qty * batch.sellingPrice });
    remaining -= qty;
  }
  if (remaining > 0) lines.push({ qty: remaining, sellingPrice: Number(item.price) || 0, total: remaining * (Number(item.price) || 0) });
  return lines;
}

function cartItemTotal(item) {
  return getCartPriceBreakdown(item).reduce((total, line) => total + line.total, 0);
}

function displayedSellingPrice(product) {
  const cartItem = cart.find((item) => item.id === product.id);
  const breakdown = cartItem ? getCartPriceBreakdown(cartItem) : [];
  return breakdown.length ? breakdown[breakdown.length - 1].sellingPrice : product.price;
}

function renderCart() {
  const container = $('#cartItems');
  const badge = $('#mobileCartBadge');
  const orderCount = $('#cartItemsCount');
  const orderCountValue = $('#cartItemsCountValue');
  const totalCount = cart.reduce((sum, item) => sum + item.qty, 0);
  if (badge) badge.textContent = totalCount;
  if (orderCount) orderCount.hidden = !cart.length;
  if (orderCountValue) orderCountValue.textContent = `${cart.length} item${cart.length > 1 ? 's' : ''}`;

  if (!cart.length) {
    container.classList.remove('can-scroll-down', 'can-scroll-up');
    container.innerHTML = `
      <div class="empty-state">
        <svg class="empty-cart-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>
        <p>Cart is empty</p>
        <small>Select items from the catalog</small>
      </div>
    `;
    $('#cartTotal').textContent = money(0);
    return;
  }

  container.innerHTML = `
    ${cart.map((item) => `
      <div class="cart-card">
        <div class="cart-card-header">
          <div class="cart-item-info">
            <strong class="cart-item-title">${escapeHtml(item.name)}</strong>
            <span class="cart-item-meta">${escapeHtml(item.unit || 'unit')} &bull; FIFO price: ${money(getCartPriceBreakdown(item)[0]?.sellingPrice || item.price)}</span>
            ${item.tankInventory ? '<span class="refill-exchange-note">Refill exchange: empty tank returned</span>' : ''}
          </div>
          <button class="remove cart-remove-btn" aria-label="Remove ${escapeHtml(item.name)}" data-remove="${item.id}" title="Remove item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </div>
        <div class="cart-card-body">
          <div class="cart-control-col">
            <label class="cart-control-label" for="cartQty_${item.id}">Quantity</label>
            <div class="cart-qty-stepper">
              <button type="button" class="cart-step-btn" data-step-qty="${item.id}" data-delta="-1" aria-label="Decrease quantity">&minus;</button>
              <input id="cartQty_${item.id}" aria-label="Quantity for ${escapeHtml(item.name)}" type="number" min="1" max="${item.stock}" value="${item.qty}" data-qty="${item.id}" />
              <button type="button" class="cart-step-btn" data-step-qty="${item.id}" data-delta="1" aria-label="Increase quantity">&plus;</button>
            </div>
          </div>
          <div class="cart-control-col price-col cart-batch-prices">
            <span class="cart-control-label">${hasSellingPriceOverride(item.overridePrice) || hasSellingPriceOverride(item.sellingPriceOverride) ? 'Override Price' : 'Batch Selling Price'}</span>
            ${getCartPriceBreakdown(item).map((line) => `<span class="cart-batch-price">${line.qty} &times; ${money(line.sellingPrice)}</span>`).join('')}
          </div>
          <div class="cart-subtotal-col">
            <span class="cart-control-label">Subtotal</span>
            <strong class="item-subtotal">${money(cartItemTotal(item))}</strong>
          </div>
        </div>
      </div>
    `).join('')}
  `;

  $('#cartTotal').textContent = money(cart.reduce((total, item) => total + cartItemTotal(item), 0));

  container.querySelectorAll('[data-qty]').forEach((input) => input.addEventListener('change', () => updateQty(input.dataset.qty, input.value)));
  container.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    cart = cart.filter((item) => item.id !== button.dataset.remove);
    renderCart();
    renderInventory();
  }));
  container.querySelectorAll('[data-step-qty]').forEach((button) => button.addEventListener('click', () => {
    const item = cart.find((entry) => entry.id === button.dataset.stepQty);
    if (!item) return;
    const delta = Number(button.dataset.delta) || 0;
    const newQty = item.qty + delta;
    if (newQty < 1) return;
    if (newQty > item.stock) {
      showToast(`Cannot exceed current stock limit of ${item.stock}.`, 'error');
      return;
    }
    item.qty = newQty;
    renderCart();
    renderInventory();
  }));

  requestAnimationFrame(updateCartScrollFade);
}

function addToCart(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  const existing = cart.find((item) => item.id === id);
  if (existing) {
    if (existing.qty < product.qty) {
      existing.qty += 1;
      showToast(`Increased ${product.name} quantity to ${existing.qty}.`, 'info');
    } else {
      showToast(`Cannot exceed current stock limit of ${product.qty}.`, 'error');
      return;
    }
  } else {
    cart.push({ ...product, stock: product.qty, qty: 1 });
    showToast(`Added ${product.name} to cart.`, 'success');
  }
  renderCart();
  renderInventory();
}

function updateQty(id, value) {
  const item = cart.find((entry) => entry.id === id);
  if (!item) return;
  item.qty = Math.min(item.stock, Math.max(1, Number(value) || 1));
  renderCart();
  renderInventory();
}

function openProductPriceOverride(id) {
  const item = products.find((entry) => entry.id === id);
  const dialog = $('#productPriceOverrideDialog');
  const input = $('#cartPriceOverrideInput');
  if (!item || !dialog || !input) return;
  const currentPrice = hasSellingPriceOverride(item.sellingPriceOverride) ? Number(item.sellingPriceOverride) : NaN;
  const standardTotal = getCartPriceBreakdown({ ...item, sellingPriceOverride: undefined, overridePrice: undefined }).reduce((total, line) => total + line.total, 0);
  $('#cartPriceOverrideProduct').textContent = item.name;
  $('#cartPriceOverrideHint').textContent = `Current batch price: ${money(standardTotal / item.qty)} per ${item.unit || 'unit'}.`;
  input.value = Number.isFinite(currentPrice) ? currentPrice.toFixed(2) : (standardTotal / item.qty).toFixed(2);
  $('#cartPriceOverrideError').textContent = '';
  $('#productPriceOverrideClear').hidden = !Number.isFinite(currentPrice);
  dialog.dataset.productId = item.id;
  dialog.showModal();
  requestAnimationFrame(() => input.focus());
}


/* ==========================================================================
   REFRESH DATA
   ========================================================================== */
async function refresh(showSkeleton = true) {
  if (!currentSession?.token) return;
  // Deduplication guard: if a refresh is already in flight, skip to prevent double-fetching
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (showSkeleton) activeView === 'dashboard' ? renderDashboardSkeleton() : renderSkeletonTable();
  try {
    const data = await api('getAppData', { branchId: activeBranchId }, 'GET');
    branches = data.branches;
    renderBranchSelector();
    products = data.inventory;
    customers = data.customers;
    transfers = data.transfers || [];
    creditPayments = data.creditPayments || [];
    salesHistory = data.salesHistory || [];
    saleReturns = data.saleReturns || [];
    saleReturnItems = data.saleReturnItems || [];
    inventoryReturnLots = data.inventoryReturnLots || [];
    inventoryQuarantineCases = data.inventoryQuarantineCases || [];
    inventoryQuarantineItems = data.inventoryQuarantineItems || [];
    dailySpotCash = data.dailySpotCash || [];
    dailyExpenses = data.dailyExpenses || [];
    openingCreditAccounts = data.openingCreditAccounts || [];
    creditAccounts = calculateOutstandingCreditAccounts(salesHistory, creditPayments, openingCreditAccounts);
    inventoryReportData = data.inventoryReport || {};
    stockInHistory = data.stockInHistory || [];
    sellingPriceBatches = data.sellingPriceBatches || [];
    bundleComponents = data.bundleComponents || [];
    bundleAvailability = data.bundleAvailability || {};
    allProducts = data.products;
    if (activeView === 'staffAccounts') staffAccounts = await api('getStaffAccounts', {}, 'GET');
    if (activeView === 'adminAccount') { adminAccount = await api('getAdminAccount', {}, 'GET'); adminAccounts = await api('getAdminAccounts', {}, 'GET'); }
    // Smart render: only update what's actually visible
    if (activeView === 'dashboard') {
      renderDashboard();
    } else {
      renderInventory();
      if (activeView === 'pos') renderCart();
    }
  } catch (error) {
    try {
      if (activeView !== 'dashboard') renderInventory();
    } catch (renderError) {
      const table = $('#inventoryTable');
      if (table) table.innerHTML = `<div class="empty-state"><p>Unable to load this view</p><small>${escapeHtml(renderError.message || 'Please refresh and try again.')}</small></div>`;
    }
    showToast(error.message || 'Unable to load data.', 'error');
  } finally {
    refreshInFlight = false;
  }
}

/* ==========================================================================
   MODALS & FORMS
   (User Rule: Always use loading spinner on add and save within the modal)
   ========================================================================== */
function openForm(type, productId = '') {
  activeForm = type;
  $('#formError').textContent = '';
  const product = products.find((item) => item.id === productId);
  const branch = branches.find((item) => item.id === productId);
  const customer = customers.find((item) => item.id === productId);
  const permissions = currentSession?.account?.permissions || ['*'];
  const canRecordOpeningCredit = permissions.includes('*') || permissions.includes('credits');
  const customerPreviousBalance = Number(openingCreditAccounts.find((item) => item.customerId === customer?.id)?.total || 0);
  editingProductId = productId;

  const formMeta = {
    product: {
      title: 'Add product',
      eyebrow: 'CATALOG REGISTRATION',
      subtitle: 'Register a new merchandise item into the catalog.',
      submit: 'Add product',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>`,
    },
    edit: {
      title: 'Edit product',
      eyebrow: 'CATALOG SPECIFICATION',
      subtitle: 'Modify product specifications and stock alerts.',
      submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    linkProduct: {
      title: 'Add existing product', eyebrow: 'BRANCH PRODUCT SETUP', subtitle: 'Make a catalog product available in the selected branch.', submit: 'Add to branch',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/><circle cx="12" cy="12" r="9"/></svg>`,
    },
    stock: {
      title: 'Stock in replenishment',
      eyebrow: 'INVENTORY RESTOCK',
      subtitle: 'Receive inbound stock shipments.',
      submit: 'Save stock',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v14"/><path d="m19 9-7 7-7-7"/><circle cx="12" cy="21" r="1"/></svg>`,
    },
    branch: {
      title: 'Add branch', eyebrow: 'BRANCH MANAGEMENT', subtitle: 'Create a location for independent inventory and sales.', submit: 'Add branch',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 7h4M10 12h4M10 17h4"/></svg>`,
    },
    editBranch: {
      title: 'Edit branch', eyebrow: 'BRANCH MANAGEMENT', subtitle: 'Update the branch location and availability.', submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    customer: {
      title: 'Add customer', eyebrow: 'CUSTOMER MANAGEMENT', subtitle: 'Register a customer for the selected branch.', submit: 'Add customer',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>`,
    },
    editCustomer: {
      title: 'Edit customer', eyebrow: 'CUSTOMER MANAGEMENT', subtitle: 'Update customer information for the selected branch.', submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    staff: {
      title: 'Add staff account', eyebrow: 'STAFF ACCOUNTS', subtitle: 'Assign a branch and the menus this staff member may use.', submit: 'Create staff',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>`,
    },
    editStaff: {
      title: 'Edit staff account', eyebrow: 'STAFF ACCOUNTS', subtitle: 'Update the branch assignment and allowed menus.', submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    resetStaff: {
      title: 'Reset staff password', eyebrow: 'STAFF SECURITY', subtitle: 'Assign a new temporary password for this staff member.', submit: 'Reset password',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>`,
    },
    admin: {
      title: 'Add administrator', eyebrow: 'ADMINISTRATION', subtitle: 'Administrators receive full access to every branch and menu.', submit: 'Add administrator',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>`,
    },
    editAdmin: {
      title: 'Edit administrator', eyebrow: 'ADMINISTRATION', subtitle: 'Update your administrator profile.', submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    dailySpotCash: {
      title: 'Add Daily Spot Cash',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Record the opening cash float for today’s operations.',
      submit: 'Save Spot Cash',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>`,
    },
    editDailySpotCash: {
      title: 'Edit Daily Spot Cash',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Update the opening float amount or notes.',
      submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    dailyExpenses: {
      title: 'Add Daily Expense',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Record a cash expense for the active branch.',
      submit: 'Save Expense',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v12"/></svg>`,
    },
    editDailyExpense: {
      title: 'Edit Daily Expense',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Update the recorded cash expense details.',
      submit: 'Save changes',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    },
    transfer: {
      title: 'New stock transfer', eyebrow: 'BRANCH OPERATIONS', subtitle: 'Create a draft transfer from the selected branch.', submit: 'Create draft',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>`,
    },
  }[type] || {
    title: 'Product form',
    eyebrow: 'MERCHANDISE',
    subtitle: 'Manage catalog and store inventory.',
    submit: 'Save',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>`,
  };

  $('#dialogTitle').textContent = formMeta.title;
  const eyebrowEl = $('#modalEyebrow');
  if (eyebrowEl) eyebrowEl.textContent = formMeta.eyebrow;
  const subtitleEl = $('#modalSubtitle');
  if (subtitleEl) subtitleEl.textContent = formMeta.subtitle;
  const iconWrap = $('#modalIconWrap');
  if (iconWrap) iconWrap.innerHTML = formMeta.icon;

  $('#formSubmit').innerHTML = `<span class="button-text">${formMeta.submit}</span>`;

  const selected = (value, expected) => (value === expected ? ' selected' : '');
  const staff = staffAccounts.find((item) => item.id === productId);
  const productType = product?.productType || 'individual';
  const isBundle = productType === 'bundle';
  const bundleItems = product?.components?.length ? product.components : [{ productId: '', qty: 1 }];
  const bundleOptions = sortByName_(allProducts.filter((item) => item.productType === 'individual' && item.status === 'Active' && item.id !== productId))
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} (${escapeHtml(item.unit || 'unit')})</option>`).join('');
  const bundleRows = bundleItems.map((item) => `
    <div class="bundle-component-row" data-bundle-component-row>
      <select name="bundleComponentProduct" required>
        <option value="" disabled${item.productId ? '' : ' selected'}>Select component</option>
        ${bundleOptions.replace(`value="${escapeHtml(item.productId)}"`, `value="${escapeHtml(item.productId)}" selected`)}
      </select>
      <input name="bundleComponentQty" type="number" min="0.001" step="0.001" value="${escapeHtml(item.qty)}" required aria-label="Component quantity" />
      <button type="button" class="icon-button danger-icon bundle-component-remove" aria-label="Remove component" title="Remove component"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>`).join('');

  const productFields = `
    <div class="form-field-group full-field">
      <label for="modalProdName">
        <span class="label-text">Product Name <span class="required">*</span></span>
      </label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><line x1="7" x2="7.01" y1="7" y2="7"/></svg>
        <input id="modalProdName" name="name" placeholder="e.g. Petron 11kg" value="${escapeHtml(product?.name || '')}" required autocomplete="off" />
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalProdCategory">
        <span class="label-text">Category <span class="required">*</span></span>
      </label>
      <select id="modalProdCategory" name="category" required>
        <option value="" disabled${product ? '' : ' selected'}>Select category</option>
        ${PRODUCT_CATEGORIES.map((cat) => `<option value="${cat}"${selected(product?.category, cat)}>${cat}</option>`).join('')}
      </select>
    </div>
    <div class="form-field-group">
      <label for="modalProdUnit">
        <span class="label-text">Unit of Measure <span class="required">*</span></span>
      </label>
      <select id="modalProdUnit" name="unit" required>
        <option value="" disabled${product ? '' : ' selected'}>Select unit</option>
        ${PRODUCT_UNITS.map((unit) => `<option value="${unit}"${selected(product?.unit, unit)}>${unit}</option>`).join('')}
      </select>
    </div>
    <div class="form-field-group">
      <label for="modalProductType"><span class="label-text">Product Type <span class="required">*</span></span></label>
      ${type === 'edit' ? `<input type="hidden" name="productType" value="${productType}" /><select id="modalProductType" disabled><option value="${productType}">${isBundle ? 'Bundle / Set' : 'Individual Item'}</option></select>` : `<select id="modalProductType" name="productType" required><option value="individual"${selected(productType, 'individual')}>Individual Item</option><option value="bundle"${selected(productType, 'bundle')}>Bundle / Set</option></select>`}
      ${type === 'edit' ? '<p class="field-hint">Product type is locked after creation to preserve stock history.</p>' : ''}
    </div>
    <div class="form-field-group" data-bundle-field${isBundle ? '' : ' hidden'}>
      <label for="modalBundlePrice"><span class="label-text">Bundle Selling Price (PHP) <span class="required">*</span></span></label>
      <div class="input-with-prefix"><span class="input-prefix">PHP</span><input id="modalBundlePrice" name="bundlePrice" type="number" min="0" step="0.01" value="${isBundle ? escapeHtml(product?.bundlePrice ?? '') : ''}" ${isBundle ? 'required' : 'disabled'} placeholder="0.00" /></div>
    </div>
    <div class="form-field-group full-field" data-bundle-field${isBundle ? '' : ' hidden'}>
      <div class="bundle-components-head">
        <div><span class="label-text">Bundle Components <span class="required">*</span></span><p class="field-hint">Only individual items can be used. Bundle stock is calculated from these quantities.</p></div>
        <button type="button" class="button button-secondary bundle-component-add"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Add Component</span></button>
      </div>
      <div class="bundle-components-list">${bundleRows}</div>
    </div>
    <div class="form-field-group">
      <label for="modalProdLowStock">
        <span class="label-text">Low Stock Warning Level <span class="required">*</span></span>
      </label>
      <div class="number-stepper">
        <svg class="input-icon warning-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <input id="modalProdLowStock" name="lowStockLevel" type="number" min="0" step="1" value="${product?.lowStockLevel ?? 5}" required />
        <div class="stepper-buttons">
          <button type="button" class="stepper-btn" data-step-target="modalProdLowStock" data-step-dir="1" aria-label="Increase warning level" title="Increase">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
          </button>
          <button type="button" class="stepper-btn" data-step-target="modalProdLowStock" data-step-dir="-1" aria-label="Decrease warning level" title="Decrease">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="form-field-group${isBundle ? '' : ' full-field'}" data-product-status-field>
      <label for="modalProdStatus">
        <span class="label-text">Status</span>
      </label>
      <select id="modalProdStatus" name="status">
        <option value="Active"${selected(product?.status || 'Active', 'Active')}>Active</option>
        <option value="Inactive"${selected(product?.status, 'Inactive')}>Inactive</option>
      </select>
    </div>
  `;

  const stockProductList = sortByName_((allProducts && allProducts.length ? allProducts : products).filter((item) => item.productType !== 'bundle'));
  const stockOptions = stockProductList.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.unit || 'unit')})</option>`).join('');
  const stockLine = () => `
    <div class="stock-in-grid-row" data-stock-in-line>
      <div class="grid-cell cell-product">
        <select name="productId" required>
          <option value="" disabled selected>Select product to stock in</option>
          ${stockOptions}
        </select>
      </div>
      <div class="grid-cell cell-qty">
        <input name="qty" type="number" min="1" step="1" placeholder="1" required />
      </div>
      <div class="grid-cell cell-price">
        <div class="input-with-prefix compact-prefix">
          <span class="input-prefix">₱</span>
          <input name="sellingPrice" type="number" min="0" step="0.01" placeholder="0.00" required />
        </div>
      </div>
      <div class="grid-cell cell-quarantine">
        <input name="quarantineQty" type="number" min="0" step="1" value="0" placeholder="0" />
      </div>
      <div class="grid-cell cell-reason">
        <input name="quarantineReason" placeholder="Reason (if quarantined)" autocomplete="off" />
      </div>
      <div class="grid-cell cell-action">
        <button type="button" class="icon-button danger-icon stock-in-line-remove" aria-label="Remove item" title="Remove item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
    </div>
  `;

  const availableProducts = sortByName_(allProducts.filter((item) => !products.some((productItem) => productItem.id === item.id)));
  const linkProductFields = `
    <div class="form-field-group full-field"><label for="modalLinkProduct"><span class="label-text">Catalog Product <span class="required">*</span></span></label><select id="modalLinkProduct" name="productId" required ${availableProducts.length ? '' : 'disabled'}><option value="" disabled selected>${availableProducts.length ? 'Select product to add' : 'All catalog products are already in this branch'}</option>${availableProducts.map((item) => `<option value="${item.id}" data-low-stock="${item.lowStockLevel}">${escapeHtml(item.name)} (${escapeHtml(item.sku)})</option>`).join('')}</select></div>
    <div class="form-field-group"><label for="modalLinkLowStock"><span class="label-text">Low Stock Warning Level <span class="required">*</span></span></label><input id="modalLinkLowStock" name="lowStockLevel" type="number" min="0" step="1" value="5" required /></div>
    <div class="form-field-group"><label for="modalLinkStatus"><span class="label-text">Status</span></label><select id="modalLinkStatus" name="status"><option value="Active" selected>Active</option><option value="Inactive">Inactive</option></select></div>
  `;

  const branchFields = `
    <div class="form-field-group full-field">
      <label for="modalBranchName"><span class="label-text">Branch Name <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M19 21v-4"/><path d="M19 17a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v4"/><path d="M9 10a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1"/><rect x="3" y="3" width="18" height="4" rx="1"/></svg>
        <input id="modalBranchName" name="name" placeholder="e.g. North Satellite Branch" value="${escapeHtml(branch?.name || '')}" required autocomplete="off" />
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalBranchType"><span class="label-text">Branch Type <span class="required">*</span></span></label>
      <select id="modalBranchType" name="type" required>
        <option value="Main"${selected(branch?.type || 'Satellite', 'Main')}>Main</option>
        <option value="Satellite"${selected(branch?.type || 'Satellite', 'Satellite')}>Satellite</option>
      </select>
    </div>
    <div class="form-field-group">
      <label for="modalBranchStatus"><span class="label-text">Status</span></label>
      <select id="modalBranchStatus" name="status">
        <option value="Active"${selected(branch?.status || 'Active', 'Active')}>Active</option>
        <option value="Inactive"${selected(branch?.status, 'Inactive')}>Inactive</option>
      </select>
    </div>
    <div class="form-field-group full-field">
      <label for="modalBranchAddress"><span class="label-text">Address</span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        <input id="modalBranchAddress" name="address" placeholder="Street, barangay, city" value="${escapeHtml(branch?.address || '')}" autocomplete="off" />
      </div>
    </div></div>`;
  const stockFields = `
    <div class="form-field-group full-field stock-in-meta-row">
      <label for="modalStockSupplierReference"><span class="label-text">Supplier / Reference</span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/><path d="M9 9h.01"/><path d="M15 9h.01"/></svg>
        <input id="modalStockSupplierReference" name="supplierReference" placeholder="Supplier name, invoice or receipt number" autocomplete="off" />
      </div>
    </div>
    <div class="form-field-group full-field stock-in-batch-section">
      <div class="bundle-components-head stock-in-header-bar">
        <div>
          <span class="label-text">Stock-In Items <span class="required">*</span></span>
          <p class="field-hint">Add individual products from this delivery. Enter quarantine quantity & reason if units need inspection.</p>
        </div>
        <button type="button" class="button button-primary stock-in-line-add">
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Add Item</span>
        </button>
      </div>
      <div class="stock-in-grid-wrap">
        <div class="stock-in-grid-table">
          <div class="stock-in-grid-header">
            <span class="header-product">Product <span class="required">*</span></span>
            <span class="header-qty">Recv Qty <span class="required">*</span></span>
            <span class="header-price">Selling Price (PHP) <span class="required">*</span></span>
            <span class="header-quarantine">Quarantine Qty</span>
            <span class="header-reason">Quarantine Reason</span>
            <span class="header-action"></span>
          </div>
          <div class="stock-in-lines">${stockLine()}</div>
        </div>
      </div>
    </div>
  `;

  const customerFields = `
    <div class="form-field-group full-field">
      <label for="modalCustomerName"><span class="label-text">Customer Name <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <input id="modalCustomerName" name="name" placeholder="e.g. Juan Dela Cruz" value="${escapeHtml(customer?.name || '')}" required autocomplete="off" />
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalCustomerPhone"><span class="label-text">Mobile Number</span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <input id="modalCustomerPhone" name="phone" type="tel" placeholder="e.g. 0917 123 4567" value="${escapeHtml(customer?.phone || '')}" autocomplete="tel" />
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalCustomerStatus"><span class="label-text">Status</span></label>
      <select id="modalCustomerStatus" name="status">
        <option value="Active"${selected(customer?.status || 'Active', 'Active')}>Active</option>
        <option value="Inactive"${selected(customer?.status, 'Inactive')}>Inactive</option>
      </select>
    </div>
    <div class="form-field-group full-field">
      <label for="modalCustomerAddress"><span class="label-text">Address</span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        <input id="modalCustomerAddress" name="address" placeholder="Street, barangay, city" value="${escapeHtml(customer?.address || '')}" autocomplete="street-address" />
      </div>
    </div>
    ${(type === 'customer' || type === 'editCustomer') && canRecordOpeningCredit ? `
      <div class="form-field-group full-field">
        <label for="modalCustomerPreviousBalance"><span class="label-text">Previous Balance <span class="optional-label">(optional)</span></span></label>
        <input id="modalCustomerPreviousBalance" name="previousBalance" type="number" min="0" step="0.01" value="${type === 'editCustomer' ? customerPreviousBalance.toFixed(2) : '0.00'}" inputmode="decimal" />
        <p class="field-hint">Amount owed before this POS was started. You can update it when correcting the customer's prior balance.</p>
      </div>
    ` : ''}
  `;

  const destinationBranches = sortByName_(branches.filter((item) => item.id !== activeBranchId && item.status === 'Active'));
  const transferProducts = sortByName_(products.filter((item) => item.status === 'Active' && Number(item.qty || 0) > 0));
  const transferOptions = transferProducts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.productType === 'bundle' ? ' (Bundle / Set)' : ''} - Available: ${Number(item.qty || 0)} ${escapeHtml(item.unit || 'unit')}</option>`).join('');
  const transferFields = `
    <div class="form-field-group full-field">
      <label for="modalTransferDestination"><span class="label-text">Destination Branch <span class="required">*</span></span></label>
      <select id="modalTransferDestination" name="destinationBranchId" required ${destinationBranches.length ? '' : 'disabled'}>
        <option value="" disabled selected>${destinationBranches.length ? 'Select destination branch' : 'Create another active branch first'}</option>
        ${destinationBranches.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-field-group full-field">
      <div class="bundle-components-head">
        <div>
          <span class="label-text">Transfer Items <span class="required">*</span></span>
          <p class="field-hint">Add individual products or Bundle / Set items. Bundles automatically transfer their components.</p>
        </div>
        <button type="button" class="button button-secondary transfer-line-add">
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:4px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Add Item</span>
        </button>
      </div>
      <div class="transfer-lines-header">
        <span>Product or Bundle</span>
        <span>Qty</span>
        <span></span>
      </div>
      <div class="transfer-lines">
        <div class="bundle-component-row" data-transfer-line>
          <select name="transferProduct" required>
            <option value="" disabled selected>${transferProducts.length ? 'Select product or bundle' : 'No available source products'}</option>
            ${transferOptions}
          </select>
          <input name="transferQty" class="transfer-qty-input" type="number" min="1" step="1" value="1" required aria-label="Transfer quantity" placeholder="1" />
          <button type="button" class="icon-button danger-icon transfer-line-remove" aria-label="Remove transfer item" title="Remove item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </div>
      </div>
    </div>
    <div class="form-field-group full-field">
      <label for="modalTransferNotes"><span class="label-text">Reference / Notes</span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <input id="modalTransferNotes" name="notes" placeholder="Optional transfer memo or driver / shipment reference" autocomplete="off" />
      </div>
    </div>
  `;

  const menuOptions = [
    ['pos', 'Point of Sale'],
    ['products', 'Product Registration'],
    ['inventory', 'Inventory Stock'],
    ['transfers', 'Stock Transfers'],
    ['dailySpotCash', 'Daily Spot Cash'],
    ['dailyExpenses', 'Daily Expenses'],
    ['customers', 'Customers'],
    ['credits', 'Credit History'],
    ['sales', 'Sales History'],
    ['inventoryReports', 'Inventory Reports']
  ];
  const menuIcons = {
    pos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    products: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>',
    inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>',
    transfers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>',
    customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    credits: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>',
    sales: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    inventoryReports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    dailySpotCash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>',
    dailyExpenses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/></svg>'
  };
  const staffFields = `
    <div class="form-field-group">
      <label for="modalStaffName"><span class="label-text">Full Name <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <input id="modalStaffName" name="fullName" value="${escapeHtml(staff?.fullName || '')}" placeholder="e.g. Maria Santos" required autocomplete="name">
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalStaffUsername"><span class="label-text">Username <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>
        <input id="modalStaffUsername" name="username" value="${escapeHtml(staff?.username || '')}" ${type === 'editStaff' ? 'readonly' : ''} placeholder="e.g. staff_maria" required autocapitalize="none">
      </div>
    </div>
    ${type === 'staff' ? `
      <div class="form-field-group full-field">
        <label for="modalStaffEmail"><span class="label-text">Email Address <span class="required">*</span></span></label>
        <div class="input-with-icon">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/></svg>
          <input id="modalStaffEmail" name="email" type="email" placeholder="staff@example.com" required autocomplete="email" autocapitalize="none">
        </div>
      </div>
    ` : ''}
    ${type === 'staff' ? `
      <div class="form-field-group full-field">
        <label for="modalStaffPassword"><span class="label-text">Temporary Password <span class="required">*</span></span></label>
        <div class="input-with-icon password-input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input id="modalStaffPassword" name="password" type="password" minlength="8" placeholder="Minimum 8 characters" required autocomplete="new-password">
          <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
            <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          </button>
        </div>
      </div>
    ` : ''}
    ${type === 'editStaff'
      ? `<div class="form-field-group full-field"><label for="modalStaffBranch"><span class="label-text">Assigned Branch</span></label><input id="modalStaffBranch" value="${escapeHtml(branches.find((item) => item.id === staff?.branchId)?.name || staff?.branchId || '')}" readonly aria-describedby="modalStaffBranchHint"><p id="modalStaffBranchHint" class="field-hint">This branch is locked after account creation to protect branch records.</p></div>`
      : `<div class="form-field-group full-field"><label for="modalStaffBranch"><span class="label-text">Assigned Branch <span class="required">*</span></span></label><select id="modalStaffBranch" name="branchId" required><option value="" disabled selected>Select branch</option>${sortByName_(branches.filter((item) => item.status === 'Active')).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</select></div>`}
    <div class="form-field-group full-field">
      <span class="label-text">Allowed Sidebar Menus <span class="required">*</span></span>
      <div class="staff-permission-grid">
        ${menuOptions.map(([value, label]) => {
          const isChecked = Boolean(staff?.permissions?.includes(value));
          return `
            <label class="staff-permission-option${isChecked ? ' is-checked' : ''}">
              <input type="checkbox" name="permissions" value="${value}"${isChecked ? ' checked' : ''}>
              <span class="custom-checkbox" aria-hidden="true">
                <svg class="custom-checkbox-icon" viewBox="0 0 12 10" fill="none">
                  <path d="M1.5 5.2L4.2 8L10.5 1.8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="staff-permission-icon-wrap" aria-hidden="true">${menuIcons[value] || ''}</span>
              <span class="staff-permission-label">${label}</span>
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `;
  const currentAdmin = type === 'editAdmin' ? adminAccounts.find((account) => account.id === productId) : adminAccount || currentSession?.account;
  const adminFields = `
    <div class="form-field-group">
      <label for="modalAdminName"><span class="label-text">Full Name <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <input id="modalAdminName" name="fullName" value="${type === 'editAdmin' ? escapeHtml(currentAdmin?.fullName || '') : ''}" placeholder="e.g. Administrator" required autocomplete="name">
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalAdminUsername"><span class="label-text">Username <span class="required">*</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>
        <input id="modalAdminUsername" name="username" value="${type === 'editAdmin' ? escapeHtml(currentAdmin?.username || '') : ''}" placeholder="e.g. admin" required autocapitalize="none">
      </div>
    </div>
    ${type === 'admin' ? `
      <div class="form-field-group full-field">
        <label for="modalAdminEmail"><span class="label-text">Email Address <span class="required">*</span></span></label>
        <div class="input-with-icon">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/></svg>
          <input id="modalAdminEmail" name="email" type="email" placeholder="admin@example.com" required autocomplete="email" autocapitalize="none">
        </div>
      </div>
    ` : ''}
    ${type === 'admin' ? `
      <div class="form-field-group full-field">
        <label for="modalAdminPassword"><span class="label-text">Password <span class="required">*</span></span></label>
        <div class="input-with-icon password-input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input id="modalAdminPassword" name="password" type="password" minlength="8" placeholder="Minimum 8 characters" required autocomplete="new-password">
          <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
            <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          </button>
        </div>
      </div>
    ` : ''}
    ${type === 'admin' ? `
      <div class="form-field-group full-field">
        <label for="modalAdminConfirmPassword"><span class="label-text">Confirm Password <span class="required">*</span></span></label>
        <div class="input-with-icon password-input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input id="modalAdminConfirmPassword" name="confirmPassword" type="password" minlength="8" placeholder="Confirm password" required autocomplete="new-password">
          <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1"><svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg></button>
        </div>
      </div>
    ` : ''}
    ${type === 'editAdmin' ? `
      <div class="form-section-divider full-field">
        <div class="form-section-header">
          <div class="form-section-title-wrap">
            <svg class="form-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span>Change Password</span>
          </div>
          <span class="form-section-badge">Optional</span>
        </div>
        <p class="form-section-subtitle">${currentAdmin?.id === currentSession?.account?.id ? 'Leave blank to keep your current password' : 'Set a temporary password to require a new password at the next sign-in'}</p>
      </div>
      <div class="form-field-group">
        <label for="modalAdminNewPassword"><span class="label-text">New Password</span></label>
        <div class="input-with-icon password-input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input id="modalAdminNewPassword" name="newPassword" type="password" minlength="8" placeholder="Min. 8 characters" autocomplete="new-password">
          <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
            <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          </button>
        </div>
      </div>
      <div class="form-field-group">
        <label for="modalAdminConfirmPassword"><span class="label-text">Confirm Password</span></label>
        <div class="input-with-icon password-input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4a1 1 0 0 0-1.4 0l-2.1 2.1a1 1 0 0 0 0 1.4Z"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>
          <input id="modalAdminConfirmPassword" name="confirmPassword" type="password" minlength="8" placeholder="Confirm new password" autocomplete="new-password">
          <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
            <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          </button>
        </div>
      </div>
    ` : ''}
  `;

  const resetStaffFields = `
    <div class="form-field-group full-field">
      <div class="staff-reset-summary-card">
        <div class="staff-reset-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M19 8v6M22 11h-6"/></svg>
        </div>
        <div class="staff-reset-info">
          <strong class="staff-reset-name">${escapeHtml(staff?.fullName || 'Staff Member')}</strong>
          <span class="staff-reset-meta">${escapeHtml(staff?.username ? `@${staff.username}` : '')}${staff?.branchId ? ` &bull; ${escapeHtml(branches.find((b) => b.id === staff.branchId)?.name || 'Assigned Branch')}` : ''}</span>
        </div>
      </div>
    </div>
    <div class="form-field-group full-field">
      <label for="modalResetStaffPassword"><span class="label-text">New Temporary Password <span class="required">*</span></span></label>
      <div class="input-with-icon password-input-wrap">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <input id="modalResetStaffPassword" name="temporaryPassword" type="password" minlength="8" placeholder="Minimum 8 characters" required autocomplete="new-password">
        <button type="button" class="password-toggle-btn" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
          <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
        </button>
      </div>
      <p class="field-hint">All active sessions for this account will end immediately. The staff member must set a new permanent password after signing in.</p>
    </div>
  `;

  const spotCash = dailySpotCash.find((item) => item.id === productId);
  const today = new Date().toISOString().slice(0, 10);
  const dailySpotCashFields = `
    <div class="form-field-group">
      <label for="modalSpotCashDate"><span class="label-text">Business Date <span class="required">*</span></span></label>
      <input id="modalSpotCashDate" name="businessDate" type="date" value="${escapeHtml(spotCash?.businessDate || today)}" required />
    </div>
    <div class="form-field-group">
      <label for="modalSpotCashAmount"><span class="label-text">Opening Cash Float (PHP) <span class="required">*</span></span></label>
      <div class="input-with-prefix">
        <span class="input-prefix">PHP</span>
        <input id="modalSpotCashAmount" name="openingCash" type="number" min="0" step="0.01" placeholder="0.00" value="${spotCash ? escapeHtml(spotCash.openingCash) : ''}" required inputmode="decimal" />
      </div>
    </div>
    <div class="form-field-group full-field">
      <label for="modalSpotCashNotes"><span class="label-text">Notes / Remarks <span class="optional-label">(optional)</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <input id="modalSpotCashNotes" name="notes" placeholder="e.g. Verified opening float before counter opens" value="${escapeHtml(spotCash?.notes || '')}" autocomplete="off" />
      </div>
    </div>
  `;

  const expenseItem = dailyExpenses.find((item) => item.id === productId);
  const expenseToday = new Date().toISOString().slice(0, 10);
  const dailyExpenseFields = `
    <div class="form-field-group">
      <label for="modalExpenseDate"><span class="label-text">Business Date <span class="required">*</span></span></label>
      <input id="modalExpenseDate" name="businessDate" type="date" value="${escapeHtml(expenseItem?.businessDate || expenseToday)}" required />
    </div>
    <div class="form-field-group">
      <label for="modalExpenseCategory"><span class="label-text">Category <span class="required">*</span></span></label>
      <select id="modalExpenseCategory" name="category" required>
        <option value="" disabled ${!expenseItem ? 'selected' : ''}>Select category</option>
        ${DAILY_EXPENSE_CATEGORIES.map((cat) => `<option value="${escapeHtml(cat)}" ${expenseItem?.category === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
      </select>
    </div>
    <div class="form-field-group">
      <label for="modalExpenseAmount"><span class="label-text">Cash Amount (PHP) <span class="required">*</span></span></label>
      <div class="input-with-prefix">
        <span class="input-prefix">PHP</span>
        <input id="modalExpenseAmount" name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" value="${expenseItem ? escapeHtml(expenseItem.amount) : ''}" required inputmode="decimal" />
      </div>
    </div>
    <div class="form-field-group">
      <label for="modalExpenseReceipt"><span class="label-text">Receipt / Invoice No. <span class="optional-label">(optional)</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <input id="modalExpenseReceipt" name="receiptReference" placeholder="e.g. OR-10824" value="${escapeHtml(expenseItem?.receiptReference || '')}" autocomplete="off" />
      </div>
    </div>
    <div class="form-field-group full-field">
      <label for="modalExpenseDesc"><span class="label-text">Description / Remarks <span class="optional-label">(optional)</span></span></label>
      <div class="input-with-icon">
        <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <input id="modalExpenseDesc" name="description" placeholder="e.g. Purchased cleaning supplies from store" value="${escapeHtml(expenseItem?.description || '')}" autocomplete="off" />
      </div>
    </div>
  `;

  const container = $('#formFields');
  const compactFormTypes = new Set(['product', 'edit', 'linkProduct', 'branch', 'editBranch', 'customer', 'editCustomer', 'admin', 'editAdmin', 'resetStaff', 'dailySpotCash', 'editDailySpotCash', 'dailyExpenses', 'editDailyExpense']);
  $('#formDialog').dataset.formLayout = compactFormTypes.has(type) ? 'compact' : 'scrollable';
  $('#formDialog').dataset.formType = type;
  container.scrollTop = 0;
  container.innerHTML = type === 'product' || type === 'edit' ? productFields : type === 'linkProduct' ? linkProductFields : type === 'branch' || type === 'editBranch' ? branchFields : type === 'customer' || type === 'editCustomer' ? customerFields : type === 'staff' || type === 'editStaff' ? staffFields : type === 'resetStaff' ? resetStaffFields : type === 'admin' || type === 'editAdmin' ? adminFields : type === 'transfer' ? transferFields : type === 'dailySpotCash' || type === 'editDailySpotCash' ? dailySpotCashFields : type === 'dailyExpenses' || type === 'editDailyExpense' ? dailyExpenseFields : stockFields;

  // Initialize smooth dropdowns and custom datepickers for newly injected fields
  initCustomDropdowns(container);
  initCustomDatePickers(container);

  // Replace the delegated handler on every modal open; retaining old handlers
  // was appending two blank lines after the form had been opened before.
  container.onclick = (event) => {
    const addBtn = event.target.closest('.stock-in-line-add');
    if (addBtn) {
      event.preventDefault();
      const list = container.querySelector('.stock-in-lines');
      if (!list) return;
      const temp = document.createElement('div');
      temp.innerHTML = stockLine();
      const newLine = temp.firstElementChild;
      if (newLine) {
        list.appendChild(newLine);
        initCustomDropdowns(newLine);
        newLine.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }
    const remove = event.target.closest('.stock-in-line-remove');
    if (remove) {
      event.preventDefault();
      const lines = container.querySelectorAll('[data-stock-in-line]');
      if (lines.length <= 1) return showToast('A stock-in receipt needs at least one item.', 'error');
      remove.closest('[data-stock-in-line]')?.remove();
    }
  };

  // Sync state for permission checkbox cards
  container.querySelectorAll('.staff-permission-option input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const option = checkbox.closest('.staff-permission-option');
      if (option) {
        option.classList.toggle('is-checked', checkbox.checked);
      }
    });
  });

  const linkedProductSelect = $('#modalLinkProduct');
  if (linkedProductSelect) {
    linkedProductSelect.addEventListener('change', () => {
      const option = linkedProductSelect.options[linkedProductSelect.selectedIndex];
      $('#modalLinkLowStock').value = option?.dataset.lowStock || 5;
    });
  }

  const productTypeSelect = $('#modalProductType');
  const setBundleFields = () => {
    const bundle = productTypeSelect?.value === 'bundle';
    container.querySelectorAll('[data-bundle-field]').forEach((field) => { field.hidden = !bundle; });
    const price = $('#modalBundlePrice');
    if (price) { price.disabled = !bundle; price.required = bundle; }
    container.querySelector('[data-product-status-field]')?.classList.toggle('full-field', !bundle);
    container.querySelectorAll('[name="bundleComponentProduct"], [name="bundleComponentQty"]').forEach((input) => { input.disabled = !bundle; input.required = bundle; });
  };
  productTypeSelect?.addEventListener('change', setBundleFields);
  const componentList = container.querySelector('.bundle-components-list');
  const addBundleComponent = () => {
    if (!componentList) return;
    const row = document.createElement('div');
    row.className = 'bundle-component-row';
    row.dataset.bundleComponentRow = '';
    row.innerHTML = `<select name="bundleComponentProduct" required><option value="" disabled selected>Select component</option>${bundleOptions}</select><input name="bundleComponentQty" type="number" min="0.001" step="0.001" value="1" required aria-label="Component quantity" /><button type="button" class="icon-button danger-icon bundle-component-remove" aria-label="Remove component" title="Remove component"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`;
    componentList.appendChild(row);
    initCustomDropdowns(row);
    setBundleFields();
  };
  container.querySelector('.bundle-component-add')?.addEventListener('click', addBundleComponent);
  componentList?.addEventListener('click', (event) => {
    const button = event.target.closest('.bundle-component-remove');
    if (!button) return;
    const rows = componentList.querySelectorAll('[data-bundle-component-row]');
    if (rows.length === 1) return showToast('A bundle needs at least one component.', 'error');
    button.closest('[data-bundle-component-row]')?.remove();
  });
  setBundleFields();

  const transferLineList = container.querySelector('.transfer-lines');
  container.querySelector('.transfer-line-add')?.addEventListener('click', () => {
    if (!transferLineList) return;
    const row = document.createElement('div');
    row.className = 'bundle-component-row'; row.dataset.transferLine = '';
    row.innerHTML = `<select name="transferProduct" required><option value="" disabled selected>Select product or bundle</option>${transferOptions}</select><input name="transferQty" class="transfer-qty-input" type="number" min="1" step="1" value="1" required aria-label="Transfer quantity" placeholder="1" /><button type="button" class="icon-button danger-icon transfer-line-remove" aria-label="Remove transfer item" title="Remove item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`;
    transferLineList.appendChild(row); initCustomDropdowns(row);
  });
  transferLineList?.addEventListener('click', (event) => {
    const button = event.target.closest('.transfer-line-remove');
    if (!button) return;
    if (transferLineList.querySelectorAll('[data-transfer-line]').length === 1) return showToast('A transfer needs at least one item.', 'error');
    button.closest('[data-transfer-line]')?.remove();
  });

  // Initialize smooth number steppers with event delegation
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (!btn) return;
    e.preventDefault();
    const targetId = btn.dataset.stepTarget;
    const input = targetId ? document.getElementById(targetId) : btn.closest('.number-stepper')?.querySelector('input');
    if (!input) return;
    const dir = Number(btn.dataset.stepDir) || 1;
    const step = Number(input.step) || 1;
    const min = input.min !== '' ? Number(input.min) : -Infinity;
    const max = input.max !== '' ? Number(input.max) : Infinity;
    let val = (Number(input.value) || 0) + dir * step;
    if (val < min) val = min;
    if (val > max) val = max;
    input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  $('#formDialog').showModal();
  if (type === 'resetStaff') {
    setTimeout(() => {
      $('#modalResetStaffPassword')?.focus();
    }, 60);
  }
}

async function deleteProduct(productId) {
  const product = products.find((item) => item.id === productId);
  if (!product) return;
  const confirmed = await askConfirmation({
    title: 'Delete Product',
    eyebrow: 'CATALOG MANAGEMENT',
    subtitle: 'Permanent action • please confirm',
    message: `Are you sure you want to delete <strong class="confirm-highlight-name">${escapeHtml(product.name)}</strong>?`,
    warning: 'Unused products are permanently deleted. Products with Stock In, transfer, or sale records are archived and removed from the active catalog.',
    confirmText: 'Delete Product',
    confirmType: 'danger'
  });

  if (!confirmed) return;

  try {
    const result = await api('deleteProduct', { productId });
    // Optimistic: remove from local array and re-render immediately
    products = products.filter((item) => item.id !== productId);
    allProducts = allProducts.filter((item) => item.id !== productId);
    renderInventory();
    showToast(result?.archived ? 'Product archived; its transaction history was preserved.' : 'Product deleted successfully.', 'success');
    backgroundRefresh();
  } catch (error) {
    showToast(error.message || 'Failed to delete product.', 'error');
  }
}

/* ==========================================================================
   NAVIGATION & VIEWS
   ========================================================================== */
function setView(view, preserveSidebarOpen = false) {
  const validViews = ['dashboard', 'pos', 'products', 'bundleMonitoring', 'inventory', 'quarantine', 'quarantineReport', 'branches', 'transfers', 'dailySpotCash', 'dailyExpenses', 'customers', 'credits', 'sales', 'inventoryReports', 'staffAccounts', 'adminAccount'];
  const permissions = currentSession?.account?.permissions || ['*'];
  const dailySpotCashNav = document.querySelector('[data-view="dailySpotCash"]');
  if (dailySpotCashNav) dailySpotCashNav.hidden = !permissions.includes('*') && !permissions.includes('dailySpotCash');
  const dailyExpensesNav = document.querySelector('[data-view="dailyExpenses"]');
  if (dailyExpensesNav) dailyExpensesNav.hidden = !permissions.includes('*') && !permissions.includes('dailyExpenses');
  const requiredPermission = ['quarantine', 'quarantineReport'].includes(view) ? 'inventory' : view === 'bundleMonitoring' ? 'products' : view;
  if (view !== 'dashboard' && !permissions.includes('*') && !permissions.includes(requiredPermission)) view = permissions[0] || 'pos';
  if (!validViews.includes(view)) view = 'pos';
  activeView = view;
  localStorage.setItem(ACTIVE_VIEW_KEY, activeView);
  const details = {
    dashboard: ['WORKSPACE', 'Dashboard', 'BRANCH OVERVIEW', 'Operational Snapshot'],
    pos: ['WORKSPACE', 'Point of Sale', 'INVENTORY', 'Available Products'],
    products: ['CATALOG', 'Product Registration', 'PRODUCT CATALOG', 'Registered Products'],
    bundleMonitoring: ['CATALOG', 'Bundles Monitoring', 'BUNDLE INVENTORY', 'Production and Empty Shell Availability'],
    inventory: ['BRANCH INVENTORY', 'Inventory Stock', 'STOCK CONTROL', 'Main Branch Stock'],
    quarantine: ['INVENTORY CONTROL', 'Quarantined Items', 'INSPECTION HOLDING AREA', 'Items Awaiting Disposition'],
    quarantineReport: ['REPORTING', 'Quarantine Report', 'QUARANTINE REPORT', 'Branch Quarantine Report'],
    branches: ['BRANCH OPERATIONS', 'Branches', 'LOCATION DIRECTORY', 'Main and Satellite Branches'],
    customers: ['CUSTOMER ACCOUNTS', 'Customers', 'CUSTOMER DIRECTORY', 'Customers in the Selected Branch'],
    credits: ['CUSTOMER ACCOUNTS', 'Credit History', 'ACCOUNT RECEIVABLES', 'Customer Credit History'],
    sales: ['REPORTING', 'Sales History', 'SALES LEDGER', 'Branch Sales History'],
    inventoryReports: ['REPORTING', 'Inventory Reports', 'INVENTORY REPORT', 'Active Branch Stock Report'],
    transfers: ['BRANCH OPERATIONS', 'Stock Transfers', 'TRANSFER TRACKING', 'Outgoing and Incoming Branch Stock'],
    dailySpotCash: ['BRANCH OPERATIONS', 'Daily Spot Cash', 'OPENING CASH', 'Daily Branch Opening Float'],
    dailyExpenses: ['BRANCH OPERATIONS', 'Daily Expenses', 'DAILY EXPENSES', 'Cash-only Daily Expenses'],
    staffAccounts: ['ADMINISTRATION', 'Staff Accounts', 'STAFF ACCOUNTS', 'Manage Staff Access'],
    adminAccount: ['ADMINISTRATION', 'Admin Account', 'ADMINISTRATION', 'Administrator Accounts'],
  }[view] || ['WORKSPACE', 'Point of Sale', 'INVENTORY', 'Available Products'];

  $('#pageEyebrow').textContent = details[0];
  $('#pageTitle').textContent = details[1];
  $('#catalogEyebrow').textContent = details[2];
  $('#catalogTitle').textContent = details[3];
  const searchInput = $('#searchInput');
  if (searchInput) {
    searchInput.placeholder = view === 'customers'
      ? 'Search customer name, phone, or address...'
      : view === 'branches'
      ? 'Search branch name, type, or address...'
      : view === 'transfers'
      ? 'Search transfer, branch, product, or status...'
      : view === 'credits'
      ? 'Search customer, credit sale, or payment note...'
      : view === 'sales'
      ? 'Search receipt, customer, or payment type...'
      : view === 'inventoryReports'
      ? 'Search product name, SKU, or category...'
      : view === 'staffAccounts'
      ? 'Search staff name or username...'
      : view === 'quarantine'
      ? 'Search case ID, reference, supplier, or reason...'
      : view === 'quarantineReport'
      ? 'Search product, case ID, reason, or disposition...'
      : view === 'dailySpotCash'
      ? 'Search date, notes, or opening cash...'
      : view === 'dailyExpenses'
      ? 'Search date, category, description, or receipt...'
      : view === 'bundleMonitoring'
      ? 'Search bundle or component...'
      : 'Search product name, SKU, or category...';
  }

  const viewIcons = {
    dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
    pos: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
    products: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>`,
    bundleMonitoring: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10l2 4-2 14H7L5 7l2-4Z"/><path d="M5 7h14M9 3v4m6-4v4"/><path d="M9 12h6M9 16h6"/></svg>`,
    inventory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>`,
    quarantine: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
    quarantineReport: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6z"/><path d="M14 2v4h4"/><path d="m9 15 2 2 4-4"/><path d="M9 11h6"/></svg>`,
    branches: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 7h4M10 12h4M10 17h4"/></svg>`,
    customers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>`,
    credits: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>`,
    sales: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`,
    inventoryReports: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6z"/><path d="M14 2v4h4"/><path d="M9 12h6M9 16h6M9 20h4"/></svg>`,
    transfers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>`,
    staffAccounts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M19 8v6M22 11h-6"/></svg>`,
    adminAccount: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>`,
    dailySpotCash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>`,
    dailyExpenses: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v12"/></svg>`,
  };

  const catalogIconWrap = $('#catalogIconWrap');
  if (catalogIconWrap && viewIcons[view]) {
    catalogIconWrap.innerHTML = viewIcons[view];
  }

  const isPos = view === 'pos';
  const isDashboard = view === 'dashboard';
  const dashboard = $('#dashboard');
  const catalog = $('#products');
  if (dashboard) dashboard.hidden = !isDashboard;
  if (catalog) catalog.hidden = isDashboard;
  const cartSection = $('#cartSection');
  if (cartSection) {
    cartSection.hidden = !isPos;
    cartSection.style.display = isPos ? '' : 'none';
  }
  const sectionActions = $('#sectionActions');
  if (sectionActions) sectionActions.style.display = isPos || view === 'bundleMonitoring' || view === 'credits' || view === 'sales' || view === 'inventoryReports' || view === 'quarantine' || view === 'quarantineReport' ? 'none' : 'flex';
  const addBtn = $('#addProductButton');
  if (addBtn) addBtn.hidden = view !== 'products';
  const addExistingProductBtn = $('#addExistingProductButton');
  if (addExistingProductBtn) addExistingProductBtn.hidden = view !== 'products';
  const stockBtn = $('#stockInButton');
  if (stockBtn) stockBtn.hidden = view !== 'inventory';
  const stockInHistoryBtn = $('#stockInHistoryButton');
  if (stockInHistoryBtn) stockInHistoryBtn.hidden = view !== 'inventory';
  const branchBtn = $('#addBranchButton');
  if (branchBtn) branchBtn.hidden = view !== 'branches';
  const customerBtn = $('#addCustomerButton');
  if (customerBtn) customerBtn.hidden = view !== 'customers';
  const transferBtn = $('#addTransferButton');
  if (transferBtn) transferBtn.hidden = view !== 'transfers';
  const spotCashBtn = $('#addDailySpotCashButton');
  if (spotCashBtn) spotCashBtn.hidden = view !== 'dailySpotCash';
  const expenseBtn = $('#addDailyExpenseButton');
  if (expenseBtn) expenseBtn.hidden = view !== 'dailyExpenses';
  const staffBtn = $('#addStaffButton');
  if (staffBtn) staffBtn.hidden = view !== 'staffAccounts';
  const adminBtn = $('#addAdminButton');
  if (adminBtn) adminBtn.hidden = view !== 'adminAccount';
  const inventoryPdfBtn = $('#generateInventoryPdfButton');
  if (inventoryPdfBtn) inventoryPdfBtn.hidden = view !== 'inventoryReports';
  $('#pos').dataset.view = view;

  // Mobile cart button only visible on POS view
  const mobileCartToggle = $('#mobileCartToggle');
  if (mobileCartToggle) {
    mobileCartToggle.hidden = !isPos;
  }
  const salesDateRange = $('#salesDateRange');
  if (salesDateRange) salesDateRange.hidden = view !== 'sales';
  const quarantineDateRange = $('#quarantineDateRange');
  if (quarantineDateRange) quarantineDateRange.hidden = view !== 'quarantineReport';
  const profilePanel = $('#accountProfilePanel');
  if (profilePanel && view !== 'adminAccount') profilePanel.hidden = true;
  if (view === 'sales') {
    ensureSalesDateDefaults();
    updateSalesPrintPeriod();
  }
  if (view === 'quarantineReport') {
    ensureQuarantineDateDefaults();
    updateQuarantinePrintPeriod();
  }
  if (view !== 'sales' && view !== 'quarantineReport') {
    const period = $('#salesPrintPeriod');
    if (period) period.textContent = '';
  }

  // Reset mobile cart view state when navigating
  $('#pos').classList.remove('show-mobile-cart');
  const toggleBtn = $('#mobileCartToggle');
  if (toggleBtn) toggleBtn.classList.remove('active');

  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));

  if (!preserveSidebarOpen) {
    $('#sidebar').classList.remove('open');
    $('#sidebarBackdrop').classList.remove('active');
    localStorage.setItem(SIDEBAR_OPEN_KEY, 'false');
  }
  renderInventory();
  if (currentSession?.token && !currentSession.account?.mustChangePassword) refresh();
}

/* ==========================================================================
   EVENT LISTENERS & BINDINGS
   ========================================================================== */
// Settings Dialog
const settingsBtn = $('#settingsButton');
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    $('#apiUrlInput').value = supabaseConfig.url || '';
    $('#settingsDialog').showModal();
  });
}

// Sidebar & Responsive Navigation
const SIDEBAR_COLLAPSED_KEY = 'ce-pos-sidebar-collapsed';
const SIDEBAR_OPEN_KEY = 'ce-pos-sidebar-open';
const appShell = $('.app-shell');
const menuToggle = $('#menuToggle');
const sidebar = $('#sidebar');
const backdrop = $('#sidebarBackdrop');
const sidebarCollapseBtn = $('#sidebarCollapseBtn');

function isMobileScreen() {
  return window.innerWidth <= 860;
}

function initSidebarState() {
  const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'false';
  const open = localStorage.getItem(SIDEBAR_OPEN_KEY) === 'true';
  appShell.classList.toggle('sidebar-collapsed', collapsed);
  if (isMobileScreen()) {
    sidebar.classList.toggle('open', open);
    if (backdrop) backdrop.classList.toggle('active', open);
  } else {
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }
}

function handleMenuToggle() {
  if (isMobileScreen()) {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('active', sidebar.classList.contains('open'));
    localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebar.classList.contains('open')));
  } else {
    // Desktop / Tablet: uncollapse or toggle
    appShell.classList.toggle('sidebar-collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, appShell.classList.contains('sidebar-collapsed'));
  }
}

function handleSidebarCollapse() {
  if (isMobileScreen()) {
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
    localStorage.setItem(SIDEBAR_OPEN_KEY, 'false');
  } else {
    appShell.classList.add('sidebar-collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');
  }
}

menuToggle.addEventListener('click', handleMenuToggle);
if (sidebarCollapseBtn) {
  sidebarCollapseBtn.addEventListener('click', handleSidebarCollapse);
}
backdrop.addEventListener('click', () => {
  sidebar.classList.remove('open');
  backdrop.classList.remove('active');
  localStorage.setItem(SIDEBAR_OPEN_KEY, 'false');
});

window.addEventListener('resize', () => {
  initSidebarState();
  if (!isMobileScreen()) {
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
  }
});

// Mobile Cart Toggle & Back Button
$('#mobileCartToggle').addEventListener('click', () => {
  const isPos = activeView === 'pos';
  if (!isPos) setView('pos');
  const showing = $('#pos').classList.toggle('show-mobile-cart');
  $('#mobileCartToggle').classList.toggle('active', showing);
});

const cartBackButton = $('#cartBackButton');
if (cartBackButton) {
  cartBackButton.addEventListener('click', () => {
    $('#pos').classList.remove('show-mobile-cart');
    const toggle = $('#mobileCartToggle');
    if (toggle) toggle.classList.remove('active');
  });
}

const cartScrollContainer = $('#cartItems');
if (cartScrollContainer) {
  cartScrollContainer.addEventListener('scroll', updateCartScrollFade, { passive: true });
}
const receiptScrollContainer = $('#receiptDialog .receipt-body');
if (receiptScrollContainer) {
  receiptScrollContainer.addEventListener('scroll', updateReceiptScrollFade, { passive: true });
}
window.addEventListener('resize', updateCartScrollFade, { passive: true });
window.addEventListener('resize', updateReceiptScrollFade, { passive: true });
window.addEventListener('resize', scheduleBadgeAlignment, { passive: true });

const inventoryTableElement = $('#inventoryTable');
if (inventoryTableElement) {
  const inventoryTableObserver = new MutationObserver(scheduleBadgeAlignment);
  inventoryTableObserver.observe(inventoryTableElement, { childList: true, subtree: true });
  scheduleBadgeAlignment();
}

document.querySelectorAll('[data-view]').forEach((link) => link.addEventListener('click', async () => {
  if (await enforcePasswordResetLogout_()) setView(link.dataset.view);
}));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => {
  const dialogId = button.dataset.close;
  const dlg = $(`#${dialogId}`);
  if (dlg) dlg.close();
}));

const actionConfirmDialog = $('#actionConfirmDialog');
if (actionConfirmDialog) {
  actionConfirmDialog.addEventListener('close', () => {
    if (pendingActionConfirmResolver) {
      pendingActionConfirmResolver(false);
      pendingActionConfirmResolver = null;
    }
  });
}

const actionConfirmSubmitBtn = $('#actionConfirmSubmitBtn');
if (actionConfirmSubmitBtn) {
  actionConfirmSubmitBtn.addEventListener('click', () => {
    const resolver = pendingActionConfirmResolver;
    pendingActionConfirmResolver = null;
    const dialog = $('#actionConfirmDialog');
    if (dialog) dialog.close();
    if (resolver) resolver(true);
  });
}

$('#productPriceOverrideForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = $('#productPriceOverrideDialog');
  const item = products.find((entry) => entry.id === dialog?.dataset.productId);
  const input = $('#cartPriceOverrideInput');
  const price = Number(input?.value);
  if (!item || !Number.isFinite(price) || price < 0) {
    $('#cartPriceOverrideError').textContent = 'Enter a valid selling price.';
    return;
  }
  try {
    const result = await api('setProductSellingPriceOverride', { productId: item.id, price, branchId: activeBranchId });
    products = products.map((product) => product.id === item.id ? { ...product, ...result } : product);
    cart = cart.map((cartItem) => cartItem.id === item.id ? { ...cartItem, ...result } : cartItem);
    dialog.close();
    renderInventory();
    renderCart();
    showToast(`Selling price overridden for ${item.name}.`, 'success');
  } catch (error) {
    $('#cartPriceOverrideError').textContent = error.message || 'Unable to save the selling-price override.';
  }
});

$('#productPriceOverrideClear')?.addEventListener('click', async () => {
  const dialog = $('#productPriceOverrideDialog');
  const item = products.find((entry) => entry.id === dialog?.dataset.productId);
  if (!item) return;
  try {
    const result = await api('setProductSellingPriceOverride', { productId: item.id, price: '', branchId: activeBranchId });
    products = products.map((product) => product.id === item.id ? { ...product, ...result } : product);
    cart = cart.map((cartItem) => cartItem.id === item.id ? { ...cartItem, ...result } : cartItem);
    dialog.close();
    renderInventory();
    renderCart();
    showToast('FIFO batch selling price restored.', 'info');
  } catch (error) {
    $('#cartPriceOverrideError').textContent = error.message || 'Unable to clear the selling-price override.';
  }
});

// Settings Form submission with loading spinner
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#settingsDialog').close();
  showToast('This POS is configured to use Supabase.', 'info');
});

// Modal Form submission with loading spinner (User Rule)
$('#addProductButton').addEventListener('click', () => openForm('product'));
$('#addExistingProductButton').addEventListener('click', () => openForm('linkProduct'));
$('#stockInButton').addEventListener('click', () => openForm('stock'));
$('#stockInHistoryButton').addEventListener('click', showStockInHistory);
const stockInSearchInput = $('#stockInSearchInput');
if (stockInSearchInput) {
  stockInSearchInput.addEventListener('input', () => renderStockInHistoryTable(stockInSearchInput.value));
  stockInSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renderStockInHistoryTable(stockInSearchInput.value);
    }
  });
}
const stockInSearchBtn = $('#stockInSearchButton');
if (stockInSearchBtn) {
  stockInSearchBtn.addEventListener('click', () => {
    renderStockInHistoryTable($('#stockInSearchInput')?.value || '');
  });
}
$('#addBranchButton').addEventListener('click', () => openForm('branch'));
$('#addCustomerButton').addEventListener('click', () => openForm('customer'));
$('#addTransferButton').addEventListener('click', () => openForm('transfer'));
$('#addDailySpotCashButton')?.addEventListener('click', () => openForm('dailySpotCash'));
$('#addDailyExpenseButton')?.addEventListener('click', () => openForm('dailyExpenses'));
$('#addStaffButton').addEventListener('click', () => openForm('staff'));
$('#addAdminButton').addEventListener('click', () => openForm('admin'));
$('#generateInventoryPdfButton').addEventListener('click', generateInventoryReportPdf);

$('#modalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  if (!formEl.checkValidity()) {
    formEl.reportValidity();
    return;
  }
  const form = new FormData(formEl);
  if (activeForm === 'receiveTransfer') {
    formEl.querySelectorAll('[data-receipt-transfer]').forEach((row) => {
      const a = row.querySelector('[name="acceptedQty"]');
      const q = row.querySelector('[name="quarantineQty"]');
      if (a && a.value.trim() === '') a.value = '0';
      if (q && q.value.trim() === '') q.value = '0';
    });
    const transfer = pendingTransferReceipt;
    const lines = transfer ? (transfer.isBatch ? transfer.members : [transfer]) : [];
    const receiptLines = [...formEl.querySelectorAll('[data-receipt-transfer]')].map((row) => ({
      transferId: row.dataset.receiptTransfer,
      acceptedQty: Number(row.querySelector('[name="acceptedQty"]')?.value || 0),
      quarantineQty: Number(row.querySelector('[name="quarantineQty"]')?.value || 0),
      total: Number(row.dataset.receiptTotal || 0),
    }));
    const invalid = !transfer || receiptLines.length !== lines.length || receiptLines.some((line) => !Number.isFinite(line.acceptedQty) || !Number.isFinite(line.quarantineQty) || line.acceptedQty < 0 || line.quarantineQty < 0 || Math.abs(line.acceptedQty + line.quarantineQty - line.total) > 0.0001);
    const quarantineQty = receiptLines.reduce((total, line) => total + line.quarantineQty, 0);
    const reason = String(form.get('quarantineReason') || '').trim();
    if (invalid) { showToast('For every line, available inventory plus quarantine must equal the transferred quantity.', 'error'); return; }
    if (quarantineQty > 0 && !reason) { showToast('Enter the inspection reason for quarantined units.', 'error'); return; }
    if (!await askConfirmation({ title: 'Receive Transfer', eyebrow: 'STOCK TRANSFERS', subtitle: 'Confirm inspection result', message: `Receive <strong>${receiptLines.length}</strong> transfer line${receiptLines.length === 1 ? '' : 's'} with <strong>${quarantineQty}</strong> unit${quarantineQty === 1 ? '' : 's'} held for inspection?`, warning: 'Only accepted units become available inventory. Quarantined units can be resolved later from Quarantined Items.', confirmText: 'Receive Stock', confirmType: 'success' })) return;
    const submitBtn = $('#formSubmit'); const originalText = submitBtn.querySelector('.button-text')?.textContent || 'Receive stock';
    submitBtn.disabled = true; submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Receiving...</span>';
    try {
      if (transfer.isBatch) await api('receiveTransferBatchWithQuarantine', { batchId: transfer.batchId, lines: receiptLines, reason });
      else await api('receiveTransferWithQuarantine', { ...receiptLines[0], reason });
      $('#formDialog').close(); pendingTransferReceipt = null;
      showToast(quarantineQty > 0 ? 'Transfer received; quarantined units are ready for inspection.' : 'Transfer received successfully.', 'success');
      await refresh(false);
    } catch (error) { $('#formError').textContent = error.message || 'Unable to receive transfer.'; showToast(error.message || 'Unable to receive transfer.', 'error'); }
    finally { submitBtn.disabled = false; submitBtn.innerHTML = `<span class="button-text">${originalText}</span>`; }
    return;
  }
  if (activeForm === 'admin' && form.get('password') !== form.get('confirmPassword')) {
    showToast('Password and confirmation do not match.', 'error');
    return;
  }
  let productBundleComponents = [];
  let transferLines = [];
  let stockInLines = [];
  if (activeForm === 'product' || activeForm === 'edit') {
    try {
      productBundleComponents = readBundleComponents_(formEl, String(form.get('productType') || 'individual'));
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
  }
  if (activeForm === 'transfer') {
    try { transferLines = readTransferLines_(formEl); } catch (error) { showToast(error.message, 'error'); return; }
  }
  if (activeForm === 'stock') {
    try { stockInLines = readStockInLines_(formEl); } catch (error) { showToast(error.message, 'error'); return; }
  }

  let confirmConfig = {
    title: 'Confirm Changes',
    eyebrow: 'CONFIRM ACTION',
    subtitle: 'Please review before saving',
    message: 'Are you sure you want to save these changes?',
    confirmText: 'Save',
    confirmType: 'primary'
  };

  if (activeForm === 'product') {
    const name = form.get('name') || 'product';
    confirmConfig = {
      title: 'Add New Product',
      eyebrow: 'PRODUCT REGISTRATION',
      subtitle: 'Register catalog item',
      message: `Are you sure you want to add <strong class="confirm-highlight-name">${escapeHtml(name)}</strong> into the product catalog?`,
      confirmText: 'Add Product',
      confirmType: 'primary'
    };
  } else if (activeForm === 'edit') {
    const name = form.get('name') || 'product';
    confirmConfig = {
      title: 'Save Product Changes',
      eyebrow: 'PRODUCT CATALOG',
      subtitle: 'Update item specification',
      message: `Are you sure you want to save changes to <strong class="confirm-highlight-name">${escapeHtml(name)}</strong>?`,
      confirmText: 'Save Changes',
      confirmType: 'primary'
    };
  } else if (activeForm === 'linkProduct') {
    const productId = form.get('productId');
    const prod = allProducts.find((p) => p.id === productId);
    const name = prod?.name || 'selected product';
    confirmConfig = {
      title: 'Link Product to Branch',
      eyebrow: 'BRANCH INVENTORY',
      subtitle: 'Add item to current branch inventory',
      message: `Are you sure you want to add <strong class="confirm-highlight-name">${escapeHtml(name)}</strong> to this branch?`,
      confirmText: 'Link Product',
      confirmType: 'primary'
    };
  } else if (activeForm === 'branch') {
    const name = form.get('name') || 'branch';
    confirmConfig = {
      title: 'Add New Branch',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Register new location',
      message: `Are you sure you want to create branch <strong class="confirm-highlight-name">${escapeHtml(name)}</strong>?`,
      confirmText: 'Add Branch',
      confirmType: 'primary'
    };
  } else if (activeForm === 'editBranch') {
    const name = form.get('name') || 'branch';
    confirmConfig = {
      title: 'Save Branch Changes',
      eyebrow: 'BRANCH OPERATIONS',
      subtitle: 'Update location details',
      message: `Are you sure you want to save changes for branch <strong class="confirm-highlight-name">${escapeHtml(name)}</strong>?`,
      confirmText: 'Save Changes',
      confirmType: 'primary'
    };
  } else if (activeForm === 'customer') {
    const name = form.get('name') || 'customer';
    confirmConfig = {
      title: 'Add New Customer',
      eyebrow: 'CUSTOMER ACCOUNTS',
      subtitle: 'Register customer account',
      message: `Are you sure you want to add customer <strong class="confirm-highlight-name">${escapeHtml(displayCustomerName(name))}</strong>?`,
      confirmText: 'Add Customer',
      confirmType: 'primary'
    };
  } else if (activeForm === 'editCustomer') {
    const name = form.get('name') || 'customer';
    confirmConfig = {
      title: 'Save Customer Changes',
      eyebrow: 'CUSTOMER ACCOUNTS',
      subtitle: 'Update account profile',
      message: `Are you sure you want to save changes for customer <strong class="confirm-highlight-name">${escapeHtml(displayCustomerName(name))}</strong>?`,
      confirmText: 'Save Changes',
      confirmType: 'primary'
    };
  } else if (activeForm === 'staff' || activeForm === 'editStaff') {
    const name = form.get('fullName') || 'staff member';
    confirmConfig = {
      title: activeForm === 'staff' ? 'Create Staff Account' : 'Save Staff Changes',
      eyebrow: 'STAFF ACCOUNTS', subtitle: 'Confirm account access',
      message: `Are you sure you want to ${activeForm === 'staff' ? 'create an account for' : 'save changes for'} <strong class="confirm-highlight-name">${escapeHtml(name)}</strong>?`,
      warning: activeForm === 'staff' ? 'The staff member must change the temporary password after signing in.' : 'The selected branch and menus take effect immediately.',
      confirmText: activeForm === 'staff' ? 'Create Staff' : 'Save Changes', confirmType: 'primary'
    };
  } else if (activeForm === 'resetStaff') {
    const staff = staffAccounts.find((item) => item.id === editingProductId);
    confirmConfig = {
      title: 'Reset Staff Password',
      eyebrow: 'STAFF ACCOUNTS',
      subtitle: 'Temporary password confirmation',
      message: `Reset the temporary password for <strong class="confirm-highlight-name">${escapeHtml(staff?.fullName || 'this staff member')}</strong>?`,
      warning: 'All active sessions for this account will end immediately.',
      confirmText: 'Reset Password',
      confirmType: 'primary'
    };
  } else if (activeForm === 'admin' || activeForm === 'editAdmin') {
    const name = form.get('fullName') || 'administrator';
    confirmConfig = activeForm === 'admin'
      ? { title: 'Add Administrator', eyebrow: 'ADMINISTRATION', subtitle: 'Confirm full system access', message: `Are you sure you want to make <strong class="confirm-highlight-name">${escapeHtml(name)}</strong> an administrator?`, warning: 'This account will have access to all branches and all menus.', confirmText: 'Add Administrator', confirmType: 'primary' }
      : { title: 'Save Administrator Changes', eyebrow: 'ADMINISTRATION', subtitle: 'Confirm profile update', message: 'Are you sure you want to save these administrator profile changes?', confirmText: 'Save Changes', confirmType: 'primary' };
  } else if (activeForm === 'transfer') {
    const destId = form.get('destinationBranchId');
    const dest = branches.find((b) => b.id === destId);
    confirmConfig = {
      title: 'Create Stock Transfer',
      eyebrow: 'STOCK TRANSFERS',
      subtitle: 'Draft stock transfer',
      message: `Create a draft transfer with <strong>${transferLines.length} item${transferLines.length === 1 ? '' : 's'}</strong> to <strong>${escapeHtml(dest?.name || 'destination branch')}</strong>?`,
      confirmText: 'Create Draft',
      confirmType: 'primary'
    };
  } else if (activeForm === 'dailySpotCash' || activeForm === 'editDailySpotCash') {
    const businessDate = form.get('businessDate') || '';
    const openingCash = Number(form.get('openingCash') || 0);
    confirmConfig = {
      title: activeForm === 'editDailySpotCash' ? 'Save Spot Cash Changes' : 'Record Daily Spot Cash',
      eyebrow: 'DAILY SPOT CASH',
      subtitle: 'Opening cash float confirmation',
      message: `Save opening cash float of <strong class="confirm-highlight-name">${money(openingCash)}</strong> for <strong>${escapeHtml(businessDate)}</strong>?`,
      confirmText: activeForm === 'editDailySpotCash' ? 'Save Changes' : 'Record Spot Cash',
      confirmType: 'primary',
    };
  } else if (activeForm === 'dailyExpenses' || activeForm === 'editDailyExpense') {
    const businessDate = form.get('businessDate') || '';
    const category = form.get('category') || '';
    const amount = Number(form.get('amount') || 0);
    confirmConfig = {
      title: activeForm === 'editDailyExpense' ? 'Save Expense Changes' : 'Record Daily Expense',
      eyebrow: 'DAILY EXPENSES',
      subtitle: 'Cash expense confirmation',
      message: `${activeForm === 'editDailyExpense' ? 'Save changes to' : 'Record'} cash expense of <strong class="confirm-highlight-name">${money(amount)}</strong> (${escapeHtml(category)}) for <strong>${escapeHtml(businessDate)}</strong>?`,
      confirmText: activeForm === 'editDailyExpense' ? 'Save Changes' : 'Record Expense',
      confirmType: 'primary',
    };
  } else {
    const prod = products.find((p) => p.id === stockInLines[0]?.productId) || allProducts.find((p) => p.id === stockInLines[0]?.productId);
    const qty = stockInLines.reduce((total, line) => total + line.qty, 0);
    const quarantineQty = stockInLines.reduce((total, line) => total + line.quarantineQty, 0);
    const sellingPrice = form.get('sellingPrice') || '0';
    if (!Number.isFinite(quarantineQty) || quarantineQty < 0 || quarantineQty > Number(qty)) {
      showToast('Quarantine quantity must be between zero and the received quantity.', 'error');
      return;
    }
    const acceptedQty = Number(qty) - quarantineQty;
    confirmConfig = {
      title: 'Confirm Stock In',
      eyebrow: 'INVENTORY STOCK',
      subtitle: 'Add physical inventory stock',
      message: `Receive <strong>${stockInLines.length}</strong> item line${stockInLines.length === 1 ? '' : 's'} with <strong>${acceptedQty}</strong> accepted unit${acceptedQty === 1 ? '' : 's'}${quarantineQty ? ` and <strong>${quarantineQty}</strong> quarantined` : ''}?`,
      confirmText: 'Update Stock',
      confirmType: 'primary'
    };
  }

  const confirmed = await askConfirmation(confirmConfig);
  if (!confirmed) return;

  const submitBtn = $('#formSubmit');
  const originalText = submitBtn.querySelector('.button-text')?.textContent || 'Save';

  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="btn-spinner"></span><span>Saving...</span>`;
  $('#formError').textContent = '';

  try {
    $('#formError').textContent = '';
    // Optimistic local update per form type, then background sync
    if (activeForm === 'product') {
      const payload = Object.fromEntries(form);
      if (!payload.status) payload.status = 'Active';
      const result = await api('createProduct', { ...payload, bundleComponents: productBundleComponents, branchId: activeBranchId });
      products = [{ ...result, qty: 0, sku: result.sku || '' }, ...products];
      allProducts = [{ ...result }, ...allProducts];
      showToast('Product added successfully.', 'success');
    } else if (activeForm === 'edit') {
      const current = products.find((p) => p.id === editingProductId);
      const payload = { ...Object.fromEntries(form), productId: editingProductId };
      if (!payload.status) payload.status = current?.status || 'Active';
      const result = await api('updateProduct', { ...payload, bundleComponents: productBundleComponents, branchId: activeBranchId });
      products = products.map((p) => p.id === editingProductId ? { ...p, ...result } : p);
      showToast('Product updated successfully.', 'success');
    } else if (activeForm === 'linkProduct') {
      const result = await api('addProductToBranch', { ...Object.fromEntries(form), branchId: activeBranchId });
      products = [...products, { ...result, qty: 0 }];
      showToast('Product added to this branch.', 'success');
    } else if (activeForm === 'branch') {
      const result = await api('createBranch', Object.fromEntries(form));
      branches = [...branches, result];
      renderBranchSelector();
      showToast('Branch added successfully.', 'success');
    } else if (activeForm === 'editBranch') {
      const result = await api('updateBranch', { ...Object.fromEntries(form), branchId: editingProductId });
      branches = branches.map((b) => b.id === editingProductId ? { ...b, ...result } : b);
      renderBranchSelector();
      showToast('Branch updated successfully.', 'success');
    } else if (activeForm === 'customer') {
      const payload = Object.fromEntries(form);
      const previousBalance = Number(payload.previousBalance || 0);
      if (!Number.isFinite(previousBalance) || previousBalance < 0) throw new Error('Enter a valid previous balance.');
      const result = await api('createCustomer', { ...payload, previousBalance, branchId: activeBranchId });
      customers = [...customers, result];
      showToast(previousBalance > 0 ? 'Customer and previous balance added.' : 'Customer added successfully.', 'success');
    } else if (activeForm === 'editCustomer') {
      const payload = Object.fromEntries(form);
      const previousBalance = Number(payload.previousBalance || 0);
      if (!Number.isFinite(previousBalance) || previousBalance < 0) throw new Error('Enter a valid previous balance.');
      const result = await api('updateCustomer', { ...payload, previousBalance, customerId: editingProductId, branchId: activeBranchId });
      customers = customers.map((c) => c.id === editingProductId ? { ...c, ...result } : c);
      showToast('Customer and previous balance updated.', 'success');
    } else if (activeForm === 'staff' || activeForm === 'editStaff') {
      const payload = Object.fromEntries(form);
      payload.permissions = form.getAll('permissions');
      if (!payload.permissions.length) throw new Error('Select at least one allowed sidebar menu.');
      await api(activeForm === 'staff' ? 'createStaffAccount' : 'updateStaffAccount', activeForm === 'staff' ? payload : { ...payload, staffId: editingProductId });
      showToast(activeForm === 'staff' ? 'Staff account created.' : 'Staff account updated.', 'success');
    } else if (activeForm === 'resetStaff') {
      const password = form.get('temporaryPassword');
      if (!password || password.length < 8) throw new Error('Temporary password must be at least 8 characters.');
      await api('resetStaffPassword', { staffId: editingProductId, temporaryPassword: password });
      showToast('Temporary password saved.', 'success');
    } else if (activeForm === 'dailySpotCash' || activeForm === 'editDailySpotCash') {
      const businessDate = form.get('businessDate');
      const openingCash = Number(form.get('openingCash') || 0);
      const notes = String(form.get('notes') || '').trim();
      if (!businessDate) throw new Error('Please select a valid business date.');
      if (!Number.isFinite(openingCash) || openingCash < 0) throw new Error('Please enter a valid opening cash float.');
      const client = requireSupabase_();
      const { data, error } = activeForm === 'editDailySpotCash'
        ? await client.rpc('update_daily_spot_cash', { target_spot_cash_id: editingProductId, target_business_date: businessDate, opening_cash_input: openingCash, notes_input: notes })
        : await client.rpc('create_daily_spot_cash', { target_branch_id: activeBranchId, target_business_date: businessDate, opening_cash_input: openingCash, notes_input: notes });
      throwIfError_(error);
      if (activeForm === 'dailySpotCash') {
        dailySpotCash = [{ id: data.spot_cash_id, branchId: activeBranchId, businessDate, openingCash, notes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...dailySpotCash];
      } else {
        dailySpotCash = dailySpotCash.map((item) => item.id === editingProductId ? { ...item, businessDate, openingCash, notes, updatedAt: new Date().toISOString() } : item);
      }
      showToast(activeForm === 'editDailySpotCash' ? 'Daily Spot Cash updated.' : 'Daily Spot Cash recorded.', 'success');
      backgroundRefresh();
    } else if (activeForm === 'dailyExpenses' || activeForm === 'editDailyExpense') {
      const businessDate = form.get('businessDate');
      const category = String(form.get('category') || '').trim();
      const amount = Number(form.get('amount') || 0);
      const description = String(form.get('description') || '').trim();
      const receiptReference = String(form.get('receiptReference') || '').trim();
      if (!businessDate) throw new Error('Please select a valid business date.');
      if (!category) throw new Error('Please select an expense category.');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Please enter a valid cash amount greater than zero.');
      const client = requireSupabase_();
      const { data, error } = activeForm === 'editDailyExpense'
        ? await client.rpc('update_daily_expense', { target_expense_id: editingProductId, target_business_date: businessDate, target_category: category, target_description: description, target_amount: amount, target_receipt_reference: receiptReference })
        : await client.rpc('create_daily_expense', { target_branch_id: activeBranchId, target_business_date: businessDate, target_category: category, target_description: description, target_amount: amount, target_receipt_reference: receiptReference });
      throwIfError_(error);
      if (activeForm === 'dailyExpenses') {
        dailyExpenses = [{ id: data.expense_id, branchId: activeBranchId, businessDate, category, description, amount, receiptReference, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...dailyExpenses];
      } else {
        dailyExpenses = dailyExpenses.map((item) => item.id === editingProductId ? { ...item, businessDate, category, description, amount, receiptReference, updatedAt: new Date().toISOString() } : item);
      }
      showToast(activeForm === 'editDailyExpense' ? 'Daily Expense updated.' : 'Daily Expense recorded.', 'success');
      backgroundRefresh();
    } else if (activeForm === 'admin') {
      await api('createAdminAccount', Object.fromEntries(form));
      showToast('Administrator account created.', 'success');
    } else if (activeForm === 'editAdmin') {
      const payload = Object.fromEntries(form);
      if (payload.newPassword !== payload.confirmPassword) throw new Error('New password and confirmation do not match.');
      const account = await api('updateAdminAccount', { adminId: editingProductId, fullName: payload.fullName, username: payload.username, newPassword: payload.newPassword });
      if (account.id === currentSession.account.id) {
        currentSession.account = { ...currentSession.account, ...account };
        localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(currentSession));
      }
      showToast('Administrator profile updated.', 'success');
    } else if (activeForm === 'transfer') {
      const result = await api('createTransferBatch', { destinationBranchId: form.get('destinationBranchId'), notes: form.get('notes') || '', lines: transferLines, sourceBranchId: activeBranchId });
      if (result?.transfers?.length) showToast(`Transfer draft ${result.batchId} created with ${result.transfers.length} component line${result.transfers.length === 1 ? '' : 's'}.`, 'success');
    } else {
      // stockIn
      const branchId = activeBranchId;
      const result = await api('receiveStockInBatch', { branchId, lines: stockInLines, supplierReference: form.get('supplierReference') || '' });
      showToast(`Stock receipt ${result.stockInBatchId} saved with ${result.lineCount} item line${result.lineCount === 1 ? '' : 's'}.`, 'success');
    }
    $('#formDialog').close();
    renderInventory();
    if (activeView === 'pos') renderCart();
    backgroundRefresh();

  } catch (error) {
    const isDuplicateUsername = /username is already in use/i.test(error.message || '');
    $('#formError').textContent = isDuplicateUsername ? '' : error.message;
    showToast(error.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<span class="button-text">${originalText}</span>`;
  }
});

$('#searchInput').addEventListener('input', debounce(renderInventory, 150));
$('#salesDateFrom').addEventListener('change', () => {
  const dateFrom = $('#salesDateFrom');
  const dateTo = $('#salesDateTo');
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
    dateTo.value = dateFrom.value;
    syncCustomDatePicker(dateTo);
  }
  syncCustomDatePicker(dateFrom);
  updateSalesPrintPeriod();
  renderInventory();
});
$('#salesDateTo').addEventListener('change', () => {
  const dateFrom = $('#salesDateFrom');
  const dateTo = $('#salesDateTo');
  if (dateFrom.value && dateTo.value && dateTo.value < dateFrom.value) {
    dateFrom.value = dateTo.value;
    syncCustomDatePicker(dateFrom);
  }
  syncCustomDatePicker(dateTo);
  updateSalesPrintPeriod();
  renderInventory();
});
$('#generateSalesPdfButton').addEventListener('click', generateSalesPdf);
$('#exportSalesPdfButton').addEventListener('click', exportSalesPdf);

const quarantineDateFrom = $('#quarantineDateFrom');
if (quarantineDateFrom) {
  quarantineDateFrom.addEventListener('change', () => {
    const dateFrom = $('#quarantineDateFrom');
    const dateTo = $('#quarantineDateTo');
    if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
      dateTo.value = dateFrom.value;
      syncCustomDatePicker(dateTo);
    }
    syncCustomDatePicker(dateFrom);
    updateQuarantinePrintPeriod();
    renderInventory();
  });
}

const quarantineDateTo = $('#quarantineDateTo');
if (quarantineDateTo) {
  quarantineDateTo.addEventListener('change', () => {
    const dateFrom = $('#quarantineDateFrom');
    const dateTo = $('#quarantineDateTo');
    if (dateFrom.value && dateTo.value && dateTo.value < dateFrom.value) {
      dateFrom.value = dateTo.value;
      syncCustomDatePicker(dateFrom);
    }
    syncCustomDatePicker(dateTo);
    updateQuarantinePrintPeriod();
    renderInventory();
  });
}

const generateQuarantinePdfButton = $('#generateQuarantinePdfButton');
if (generateQuarantinePdfButton) {
  generateQuarantinePdfButton.addEventListener('click', generateQuarantinePdf);
}

$('#branchSelector').addEventListener('change', (event) => {
  setActiveBranch(event.target.value).catch((error) => showToast(error.message, 'error'));
});

$('#clearCartButton').addEventListener('click', async () => {
  if (!cart.length) return;
  const confirmed = await askConfirmation({
    title: 'Clear Cart',
    eyebrow: 'POINT OF SALE',
    subtitle: 'Remove pending items',
    message: `Are you sure you want to clear <strong>${cart.length} item(s)</strong> from your cart?`,
    warning: 'All selected products and entered quantities will be removed.',
    confirmText: 'Clear Cart',
    confirmType: 'danger'
  });
  if (!confirmed) return;

  cart = [];
  renderCart();
  renderInventory();
  showToast('Cart cleared.', 'info');
});

$('#creditPaymentDialog').addEventListener('close', () => { pendingCreditAccount = null; });
$('#creditPaymentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingCreditAccount) return;
  const amount = Number($('#creditAmount').value);
  const error = $('#creditPaymentError');
  if (!Number.isFinite(amount) || amount <= 0) {
    error.textContent = 'Enter a payment amount greater than zero.';
    return;
  }
  if (amount > pendingCreditAccount.balance + 0.00001) {
    error.textContent = 'Payment cannot exceed the outstanding balance.';
    return;
  }
  error.textContent = '';
  const confirmed = await askConfirmation({
    title: 'Record Credit Payment',
    eyebrow: 'CREDIT PAYMENTS',
    subtitle: 'Confirm payment amount',
    message: `Record <strong class="confirm-highlight-name">${money(amount)}</strong> from ${escapeHtml(displayCustomerName(pendingCreditAccount.customerName))}?`,
    warning: `The remaining balance will be ${money(pendingCreditAccount.balance - amount)}.`,
    confirmText: 'Save Payment',
    confirmType: 'primary',
  });
  if (!confirmed) return;
  const submitBtn = $('#creditPaymentSubmit');
  const originalContent = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Saving payment...</span>';
  try {
    const payment = await api('recordCreditPayment', {
      branchId: activeBranchId,
      saleId: pendingCreditAccount.creditId,
      amount,
      notes: $('#creditNotes').value.trim(),
    });
    $('#creditPaymentDialog').close();
    // Optimistic: add the payment locally and recalculate balances
    creditPayments = [{ id: `CPY-OPT-${Date.now()}`, creditId: pendingCreditAccount.creditId, saleId: pendingCreditAccount.saleId || '', customerId: pendingCreditAccount.customerId, customerName: pendingCreditAccount.customerName, amount, date: new Date().toISOString(), notes: $('#creditNotes').value.trim() }, ...creditPayments];
    creditAccounts = calculateOutstandingCreditAccounts(salesHistory, creditPayments, openingCreditAccounts);
    renderInventory();
    showToast(`Payment recorded. Remaining balance: ${money(payment.balance)}.`, 'success');
    backgroundRefresh();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalContent;
  }
});

function saleSubtotal() {
  return cart.reduce((total, item) => total + cartItemTotal(item), 0);
}

function syncSaleCustomerOptions(paymentType) {
  const customerSelect = $('#saleCustomer');
  if (!customerSelect || customerSelect.dataset.paymentMode === paymentType) return;
  const selectedCustomerId = customerSelect.value;
  const activeCustomers = sortByName_(customers.filter((customer) => customer.status === 'Active'));
  const placeholder = paymentType === 'credit'
    ? '<option value="" disabled>Select active customer</option>'
    : '<option value="">WALK-IN CUSTOMER</option>';
  customerSelect.innerHTML = `${placeholder}${activeCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(displayCustomerName(customer.name))}${customer.phone ? ` - ${escapeHtml(customer.phone)}` : ''}</option>`).join('')}`;
  customerSelect.value = activeCustomers.some((customer) => customer.id === selectedCustomerId) ? selectedCustomerId : '';
  customerSelect.required = paymentType === 'credit';
  customerSelect.dataset.paymentMode = paymentType;
  updateCustomDropdown(customerSelect);
}

function updateSaleCheckoutValues() {
  const subtotal = saleSubtotal();
  const discountInput = $('#saleDiscount');
  const discount = Math.min(Math.max(Number(discountInput.value) || 0, 0), subtotal);
  const paymentType = document.querySelector('input[name="paymentType"]:checked')?.value || 'cash';
  syncSaleCustomerOptions(paymentType);
  const total = subtotal - discount;
  const tenderedInput = $('#saleCashTendered');
  const tendered = Number(tenderedInput.value) || 0;
  $('#saleSubtotal').value = subtotal.toFixed(2);
  $('#saleTotal').value = total.toFixed(2);
  $('#saleChange').value = Math.max(tendered - total, 0).toFixed(2);
  tenderedInput.disabled = paymentType === 'credit';
  $('#saleCashTenderedGroup').hidden = paymentType === 'credit';
  $('#saleChangeGroup').hidden = paymentType === 'credit';

  // Update elevated hero & summary elements
  const heroTotal = $('#saleHeroTotal');
  if (heroTotal) {
    heroTotal.textContent = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const subtotalDisp = $('#saleSubtotalDisplay');
  if (subtotalDisp) {
    subtotalDisp.textContent = money(subtotal);
  }
  const creditNotice = $('#saleCreditNotice');
  if (creditNotice) {
    creditNotice.hidden = paymentType !== 'credit';
  }
  const customerHint = $('#saleCustomerHint');
  if (customerHint) {
    if (paymentType === 'credit') {
      customerHint.textContent = 'Active customer account required for credit';
      customerHint.classList.add('warning-hint');
    } else {
      customerHint.textContent = 'Walk-in or select customer';
      customerHint.classList.remove('warning-hint');
    }
  }

  // Update dynamic change status banner
  const changeGroup = $('#saleChangeGroup');
  const heroChange = $('#saleHeroChange');
  const changeStatus = $('#saleChangeStatus');
  if (heroChange && changeGroup && changeStatus) {
    if (paymentType === 'cash') {
      const diff = Math.round((tendered - total) * 100) / 100;
      if (Math.abs(diff) < 0.005) {
        heroChange.textContent = 'PHP 0.00';
        changeStatus.textContent = 'Exact amount tendered';
        changeGroup.classList.remove('is-short');
        changeGroup.classList.add('is-exact');
      } else if (diff > 0) {
        heroChange.textContent = money(diff);
        changeStatus.textContent = 'Change to return to customer';
        changeGroup.classList.remove('is-short', 'is-exact');
      } else {
        heroChange.textContent = '-' + money(Math.abs(diff));
        changeStatus.textContent = `Short by ${money(Math.abs(diff))}`;
        changeGroup.classList.remove('is-exact');
        changeGroup.classList.add('is-short');
      }
    }
  }

  return { subtotal, discount, total, paymentType, tendered };
}

function openSaleCheckout() {
  if (!cart.length) {
    showToast('Please add items to cart before completing checkout.', 'error');
    return;
  }
  const customerSelect = $('#saleCustomer');
  customerSelect.dataset.paymentMode = '';
  customerSelect.value = '';
  $('#saleDiscount').value = '0';
  document.querySelector('input[name="paymentType"][value="cash"]').checked = true;
  $('#saleCashTendered').value = '0.00';
  $('#saleFormError').textContent = '';
  updateSaleCheckoutValues();
  $('#saleDialog').showModal();
  initCustomDropdowns($('#saleDialog'));
}

function showSaleReceipt({ sale, items, customerName }) {
  const branch = branches.find((item) => item.id === activeBranchId);
  const isCash = sale.paymentType === 'cash';
  $('#receiptBranch').textContent = branch?.name || 'Main Branch';
  $('#receiptSaleId').textContent = sale.saleId || 'N/A';
  $('#receiptDate').textContent = new Date(sale.date || Date.now()).toLocaleString('en-PH');
  $('#receiptCustomer').textContent = displayCustomerName(customerName || 'Walk-in customer');
  $('#receiptPayment').textContent = isCash ? 'Cash Payment' : 'Credit Account';

  const statusBadge = $('#receiptStatusBadge');
  if (statusBadge) {
    statusBadge.textContent = isCash ? 'PAID CASH' : 'CREDIT CHARGED';
    statusBadge.className = `receipt-status-badge ${isCash ? 'is-cash' : 'is-credit'}`;
  }

  const totalTitle = $('#receiptTotalTitle');
  const totalSub = $('#receiptTotalSub');
  if (totalTitle) {
    totalTitle.textContent = isCash ? 'Total Paid' : 'Total Charged';
  }
  if (totalSub) {
    totalSub.textContent = isCash ? 'Settled in full' : 'Charged to customer ledger';
  }

  $('#receiptItems').innerHTML = items.map((item) => `
    <div class="receipt-item-card">
      <div class="receipt-item-main">
        <strong class="receipt-item-name">${escapeHtml(item.name)}</strong>
        <div class="receipt-item-meta">
          <span class="receipt-qty-badge">${escapeHtml(String(item.qty))} ${escapeHtml(item.unit || 'unit')}</span>
          <span class="receipt-rate-text">${(item.priceBreakdown || [{ qty: item.qty, sellingPrice: item.price }]).map((line) => `${line.qty} &times; ${money(line.sellingPrice)}`).join(' + ')}</span>
        </div>
      </div>
      <strong class="receipt-item-total">${money(item.lineTotal ?? (item.qty * item.price))}</strong>
    </div>
  `).join('');

  $('#receiptSubtotal').textContent = money(sale.subtotal);
  $('#receiptDiscount').textContent = `- ${money(sale.discount)}`;
  $('#receiptDiscountRow').hidden = !Number(sale.discount);
  $('#receiptTotal').textContent = money(sale.total);

  const cashBreakdown = $('#receiptCashBreakdown');
  if (cashBreakdown) {
    cashBreakdown.hidden = !isCash;
  }
  $('#receiptTenderedRow').hidden = !isCash;
  $('#receiptChangeRow').hidden = !isCash;
  $('#receiptTendered').textContent = money(sale.cashTendered || 0);
  $('#receiptChange').textContent = money(sale.change || 0);
  $('#receiptDialog').showModal();
  requestAnimationFrame(updateReceiptScrollFade);
}

$('#receiptPrintBtn')?.addEventListener('click', () => {
  window.print();
});

$('#saleReturnForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saleId = $('#saleReturnTitle')?.textContent?.replace(/^Return\s+/, '') || '';
  const sale = salesHistory.find((item) => item.saleId === saleId);
  if (!sale) return;
  const lines = [...document.querySelectorAll('[data-sale-return-qty]')]
    .map((input) => {
      const qty = Number(input.value || 0);
      const saleItemId = input.dataset.saleItemId;
      const actionType = document.querySelector(`[data-return-action="${saleItemId}"]`)?.value || '';
      return {
        saleItemId,
        qty,
        actionType,
        refundAmount: actionType === 'refund' ? Number(document.querySelector(`[data-refund-amount="${saleItemId}"]`)?.value || 0) : 0,
        replacementProductId: document.querySelector(`[data-replacement-product="${saleItemId}"]`)?.value || '',
        replacementQty: Number(document.querySelector(`[data-replacement-qty="${saleItemId}"]`)?.value || 0),
      };
    }).filter((line) => line.qty > 0);
  const reason = $('#saleReturnReason').value.trim();
  const error = $('#saleReturnError');
  if (!lines.length) { error.textContent = 'Enter at least one returned item quantity.'; return; }
  if (!reason) { error.textContent = 'Enter the reason for this return.'; return; }
  if (lines.some((line) => !['refund', 'replacement'].includes(line.actionType))) { error.textContent = 'Choose Refund or Replace for every returned item.'; return; }
  if (lines.some((line) => {
    const originalItem = sale.items.find((item) => item.saleItemId === line.saleItemId);
    return line.actionType === 'replacement' && (!originalItem || line.replacementProductId !== originalItem.productId || line.replacementQty !== line.qty);
  })) { error.textContent = 'A replacement must be the same sold item and quantity.'; return; }
  if (lines.some((line) => line.actionType === 'refund' && line.refundAmount <= 0)) { error.textContent = 'Enter a valid refund amount for every refunded item.'; return; }
  const refundAmount = lines.filter((line) => line.actionType === 'refund').reduce((sum, line) => sum + line.refundAmount, 0);
  const submit = $('#saleReturnSubmit');
  const original = submit.innerHTML;
  submit.disabled = true;
  submit.innerHTML = '<span class="btn-spinner"></span><span>Receiving return...</span>';
  error.textContent = '';
  try {
    await api('receiveSaleReturn', { saleId: sale.saleId, returnType: 'return', lines, reason, refundAmount });
    await refresh(false);
    openSaleReturnDialog(sale);
    showToast('Return received into quarantine. Complete the next action below.', 'success');
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
    submit.innerHTML = original;
  }
});

$('#checkoutButton').addEventListener('click', openSaleCheckout);
$('#saleDiscount').addEventListener('input', updateSaleCheckoutValues);
$('#saleCashTendered').addEventListener('input', updateSaleCheckoutValues);
document.querySelectorAll('input[name="paymentType"]').forEach((input) => input.addEventListener('change', updateSaleCheckoutValues));

$('#saleExactBtn')?.addEventListener('click', () => {
  const subtotal = saleSubtotal();
  const discount = Math.min(Math.max(Number($('#saleDiscount').value) || 0, 0), subtotal);
  const total = subtotal - discount;
  $('#saleCashTendered').value = total.toFixed(2);
  updateSaleCheckoutValues();
});

document.querySelectorAll('.sale-preset-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    const addVal = Number(btn.dataset.add) || 0;
    const current = Number($('#saleCashTendered').value) || 0;
    $('#saleCashTendered').value = (current + addVal).toFixed(2);
    updateSaleCheckoutValues();
  });
});

$('#saleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = updateSaleCheckoutValues();
  const customerId = $('#saleCustomer').value;
  const error = $('#saleFormError');
  if (values.paymentType === 'credit' && !customerId) {
    error.textContent = 'Select a customer for a credit sale.';
    return;
  }
  if (values.paymentType === 'cash' && values.tendered < values.total) {
    error.textContent = 'Cash tendered must cover the total due.';
    return;
  }

  error.textContent = '';
  const customerName = customers.find((customer) => customer.id === customerId)?.name || 'Walk-in customer';
  const confirmed = await askConfirmation({
    title: values.paymentType === 'credit' ? 'Complete Credit Sale' : 'Complete Cash Sale',
    eyebrow: 'POINT OF SALE',
    subtitle: 'Confirm payment and checkout',
    message: `Complete this ${values.paymentType} sale for <strong class="confirm-highlight-name">${money(values.total)}</strong> to ${escapeHtml(displayCustomerName(customerName))}?`,
    warning: values.paymentType === 'credit'
      ? "The amount will be added to this customer's credit balance and branch stock will be deducted."
      : `Cash tendered: ${money(values.tendered)}. Change: ${money(values.tendered - values.total)}.`,
    confirmText: 'Complete Sale',
    confirmType: 'primary',
  });
  if (!confirmed) return;
  const submitBtn = $('#saleSubmit');
  const originalContent = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="btn-spinner"></span><span>Recording sale...</span>';
  try {
    const receiptItems = cart.map((item) => ({ ...item, priceBreakdown: getCartPriceBreakdown(item), lineTotal: cartItemTotal(item) }));
    const sale = await api('recordSale', {
      branchId: activeBranchId,
      customerId,
      paymentType: values.paymentType,
      discount: values.discount,
      cashTendered: values.paymentType === 'cash' ? values.tendered : 0,
      items: cart.map((item) => ({
        productId: item.id,
        qty: item.qty,
        ...(item.tankInventory ? { emptyReturn: true } : {}),
        ...(hasSellingPriceOverride(item.sellingPriceOverride) ? { price: Number(item.sellingPriceOverride) } : {}),
      })),
    });
    $('#saleDialog').close();
    // Optimistic: deduct sold quantities from local products and add sale to history
    const soldItems = cart.slice();
    cart = [];
    products = products.map((p) => {
      const soldItem = soldItems.find((item) => item.id === p.id);
      return soldItem ? { ...p, qty: Math.max((Number(p.qty) || 0) - soldItem.qty, 0) } : p;
    });
    await refresh(false);
    salesHistory = [{ ...sale, customerName, customerId, items: receiptItems, status: 'completed' }, ...salesHistory];
    if (values.paymentType === 'credit') {
      creditAccounts = calculateOutstandingCreditAccounts(salesHistory, creditPayments, openingCreditAccounts);
    }
    renderInventory();
    renderCart();
    showSaleReceipt({ sale, items: receiptItems, customerName });
    showToast(`Sale #${sale.saleId || 'Completed'} recorded: ${money(sale.total)}`, 'success');
    backgroundRefresh();
  } catch (error) {
    $('#saleFormError').textContent = error.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalContent;
  }

});

function renderAuthSkeletons() {
  const fields = $('#authFields');
  if (!fields) return;
  fields.innerHTML = `
    <div class="auth-skeleton-group">
      <div class="skeleton-shimmer auth-skeleton-label"></div>
      <div class="skeleton-shimmer auth-skeleton-input"></div>
    </div>
    <div class="auth-skeleton-group">
      <div class="skeleton-shimmer auth-skeleton-label"></div>
      <div class="skeleton-shimmer auth-skeleton-input"></div>
    </div>
  `;
}

function applySession(session, useRoleDefaultView = false) {
  currentSession = session;
  const account = session.account;
  const permittedViews = account.permissions || [];
  document.querySelectorAll('[data-view]').forEach((item) => {
    const requiredPermission = ['quarantine', 'quarantineReport'].includes(item.dataset.view) ? 'inventory' : item.dataset.view === 'bundleMonitoring' ? 'products' : item.dataset.view;
    const allowed = item.dataset.view === 'dashboard' || permittedViews.includes('*') || permittedViews.includes(requiredPermission);
    item.hidden = !allowed;
  });
  document.querySelectorAll('.side-nav .nav-label').forEach((label) => {
    let sibling = label.nextElementSibling;
    let hasVisibleMenu = false;
    while (sibling && !sibling.classList.contains('nav-label')) {
      if (sibling.matches('[data-view]') && !sibling.hidden) hasVisibleMenu = true;
      sibling = sibling.nextElementSibling;
    }
    label.hidden = !hasVisibleMenu;
  });
  if (account.role === 'staff') {
    activeBranchId = account.branchId;
    localStorage.setItem(ACTIVE_BRANCH_KEY, activeBranchId);
  }
  const requestedView = useRoleDefaultView
    ? account.role === 'admin' ? 'dashboard' : 'pos'
    : localStorage.getItem(ACTIVE_VIEW_KEY) || (account.role === 'admin' ? 'dashboard' : 'pos');
  setView(requestedView, true);
}

async function completeRequiredPasswordChange(temporaryPassword = '') {
  if (!currentSession?.account?.mustChangePassword) return true;
  if (!temporaryPassword) {
    await api('logout');
    throw new Error('Please sign in again to set your new password.');
  }
  const dialog = $('#requiredPasswordDialog');
  const form = $('#requiredPasswordForm');
  const submit = $('#requiredPasswordSubmit');
  const error = $('#requiredPasswordError');
  form.reset();
  error.textContent = '';
  dialog.showModal();
  await new Promise((resolve) => {
    const handleSubmit = async (event) => {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const values = new FormData(form);
      const newPassword = String(values.get('newPassword') || '');
      if (newPassword !== String(values.get('confirmPassword') || '')) {
        error.textContent = 'New password and confirmation do not match.';
        return;
      }
      submit.disabled = true;
      submit.innerHTML = '<span class="btn-spinner"></span><span>Saving...</span>';
      error.textContent = '';
      try {
        await api('changeOwnPassword', { currentPassword: temporaryPassword, newPassword });
        dialog.close();
        form.removeEventListener('submit', handleSubmit);
        resolve(true);
      } catch (changeError) {
        error.textContent = changeError.message || 'Unable to change password.';
      } finally {
        submit.disabled = false;
        submit.innerHTML = '<span class="button-text">Save New Password</span>';
      }
    };
    form.addEventListener('submit', handleSubmit);
    dialog.addEventListener('cancel', (event) => event.preventDefault(), { once: true });
  });
  currentSession.account.mustChangePassword = false;
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(currentSession));
  showToast('Password updated. Your account is ready.', 'success');
  return true;
}

async function initAuth() {
  const overlay = $('#authOverlay');
  overlay.classList.add('session-loading');
  if (supabaseClient) {
    let restoreError;
    try {
      let session;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          session = await api('restoreSession');
          break;
        } catch (error) {
          restoreError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!session) throw restoreError || new Error('Unable to restore session.');
      localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
      const requiresPasswordChange = session.account.mustChangePassword;
      applySession(session);
      await completeRequiredPasswordChange();
      overlay.hidden = true;
      if (requiresPasswordChange) await refresh();
      return;
    } catch (error) {
      const message = String(error?.message || '');
      const sessionInvalid = /session has expired|account is unavailable|not been assigned/i.test(message);
      if (sessionInvalid) {
        localStorage.removeItem(ADMIN_SESSION_KEY);
      } else {
        localStorage.removeItem(ADMIN_SESSION_KEY);
      }
    }
  }
  renderAuthSkeletons();
  try {
    const status = await api('getSetupStatus', {}, 'GET');
    const setup = status.needsAdmin && !localStorage.getItem(INITIAL_ADMIN_REGISTERED_KEY);
    $('#authEyebrow').textContent = setup ? 'FIRST-TIME SETUP' : 'ADMINISTRATION';
    $('#authTitle').textContent = setup ? 'Create administrator' : 'Sign in';
    $('#authCopy').textContent = setup ? 'Create the first administrator account for this POS.' : 'Use your administrator or staff email to continue.';
    $('#authSubmit').textContent = setup ? 'Create administrator' : 'Sign in';
    $('#authSubmit').hidden = false;
    $('#authFields').innerHTML = `
      ${setup ? `
        <label class="auth-field-group">
          <span class="auth-label-text">Full name</span>
          <div class="auth-input-wrap">
            <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <input name="fullName" autocomplete="name" placeholder="Enter administrator full name" required>
          </div>
        </label>
      ` : ''}
      <label class="auth-field-group">
        <span class="auth-label-text">${setup ? 'Username' : 'Email address'}</span>
        <div class="auth-input-wrap">
          <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <input name="${setup ? 'username' : 'email'}" type="${setup ? 'text' : 'email'}" autocomplete="${setup ? 'username' : 'email'}" placeholder="${setup ? 'Choose administrator username' : 'Enter email address'}" required spellcheck="false" autocapitalize="none">
        </div>
      </label>
      ${setup ? `
        <label class="auth-field-group">
          <span class="auth-label-text">Email address</span>
          <div class="auth-input-wrap">
            <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/></svg>
            <input name="email" type="email" autocomplete="email" placeholder="Enter administrator email" required spellcheck="false" autocapitalize="none">
          </div>
        </label>
      ` : ''}
      <label class="auth-field-group">
        <span class="auth-label-text">Password</span>
        <div class="auth-input-wrap">
          <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input name="password" type="password" minlength="8" autocomplete="current-password" placeholder="Enter password (min. 8 characters)" required>
          <button type="button" class="auth-toggle-pwd" aria-label="Toggle password visibility" title="Show/Hide password" tabindex="-1">
            <svg class="pwd-eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="pwd-eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
          </button>
        </div>
      </label>
    `;
    $('#authForm').dataset.mode = setup ? 'setup' : 'login';
    overlay.classList.remove('session-loading');
  } catch (error) {
    overlay.classList.remove('session-loading');
    $('#authError').textContent = error.message || 'Unable to reach Supabase. Refresh and try again.';
  }
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form);
  const setup = event.currentTarget.dataset.mode === 'setup';
  const submit = $('#authSubmit');
  const label = setup ? 'Create administrator' : 'Sign in';
  const loadingLabel = setup ? 'Creating administrator...' : 'Signing in...';
  $('#authError').textContent = '';
  submit.disabled = true;
  submit.innerHTML = `<span class="btn-spinner"></span><span>${loadingLabel}</span>`;
  try {
    const session = await api(setup ? 'createFirstAdmin' : 'login', payload);
    if (session.awaitingEmailConfirmation) {
      formElement.reset();
      showToast('Confirm your email, then sign in to finish setup.', 'info');
      await initAuth();
      return;
    }
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    const requiresPasswordChange = session.account.mustChangePassword;
    applySession(session, true);
    await completeRequiredPasswordChange(String(payload.password || ''));
    $('#authOverlay').hidden = true;
    if (requiresPasswordChange) await refresh();
    showToast(`Welcome, ${session.account.fullName}.`, 'success');
  } catch (error) {
    $('#authError').textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
});

$('#authForm').addEventListener('click', (event) => {
  const toggleBtn = event.target.closest('.auth-toggle-pwd');
  if (!toggleBtn) return;
  const input = toggleBtn.parentElement.querySelector('input[name="password"]');
  if (!input) return;
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  const showIcon = toggleBtn.querySelector('.pwd-eye-show');
  const hideIcon = toggleBtn.querySelector('.pwd-eye-hide');
  if (showIcon) showIcon.style.display = isPwd ? 'none' : 'block';
  if (hideIcon) hideIcon.style.display = isPwd ? 'block' : 'none';
});

document.addEventListener('click', (event) => {
  const toggleBtn = event.target.closest('.password-toggle-btn');
  if (!toggleBtn) return;
  const wrap = toggleBtn.closest('.password-input-wrap');
  if (!wrap) return;
  const input = wrap.querySelector('input');
  if (!input) return;
  const isPwd = input.type === 'password';
  input.type = isPwd ? 'text' : 'password';
  const showIcon = toggleBtn.querySelector('.pwd-eye-show');
  const hideIcon = toggleBtn.querySelector('.pwd-eye-hide');
  if (showIcon) showIcon.style.display = isPwd ? 'none' : 'block';
  if (hideIcon) hideIcon.style.display = isPwd ? 'block' : 'none';
  const label = isPwd ? 'Hide password' : 'Show password';
  toggleBtn.setAttribute('aria-label', label);
  toggleBtn.setAttribute('title', label);
});

$('#logoutButton').addEventListener('click', async () => {
  const confirmed = await askConfirmation({
    title: 'Sign Out',
    eyebrow: 'ADMINISTRATION',
    subtitle: 'End secure admin session',
    message: 'Are you sure you want to sign out of the system?',
    warning: 'Any active cart items and temporary inputs will be cleared.',
    confirmText: 'Sign Out',
    confirmType: 'danger',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`
  });
  if (!confirmed) return;

  const session = currentSession || JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || 'null');
  try {
    if (session?.token) await api('logout');
  } catch (error) {
    showToast(error.message || 'Unable to end the remote session.', 'error');
  }
  localStorage.removeItem(ADMIN_SESSION_KEY);
  currentSession = null;
  cart = [];
  renderCart();
  $('#authOverlay').hidden = false;
  await initAuth();
  showToast('You have been logged out.', 'info');
});

// Initialize POS view and initial fetch
initSidebarState();
initCustomDropdowns();
initCustomDatePickers();
initSidebarBranchSwitcher();
renderSidebarBranchMenu();
setView(localStorage.getItem(ACTIVE_VIEW_KEY) || 'pos', true);
initAuth();
