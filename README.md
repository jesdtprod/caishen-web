# FR Merchandise POS

Phase 1 provides a single-branch POS foundation using a static frontend and a Google Apps Script Web App backed by Google Sheets.

## Deploy the API

1. Create a Google Sheet and open **Extensions > Apps Script**.
2. Paste `apps-script/Code.gs` into the project, set `SPREADSHEET_ID`, then run `setupSheets` once from the editor.
3. Deploy as a Web App with access set for the users who will use the POS. Copy the deployment URL.
4. Open the web app, use the settings button, and paste the URL. The browser stores it locally.

Apps Script does not handle browser CORS preflight requests. The frontend sends write payloads as `text/plain`; `doPost` then parses JSON manually.

## Sheets Created

- `Branches`: branch ID, branch name, branch type, address
- `Products`: product ID, product name, unit, default selling price, category, auto-generated SKU, low-stock level, status
- `Inventory`: branch ID, product ID, quantity
- `Sales`: sale ID, branch ID, sale date, customer ID, total, payment type, status
- `SaleItems`: sale ID, product ID, quantity, unit price

The initial branch is `MAIN`. Add products through the web app, record stock-in, and complete cash sales from the POS panel. The cashier can override the selling price for each cart item; the exact sale price is saved in `SaleItems`.
