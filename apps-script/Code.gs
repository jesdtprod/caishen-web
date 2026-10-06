const SPREADSHEET_ID = '1HYt8MOZJ0JchXLCpAp5V5ypQ3-MRUMpmKlPWMlVVvPg';
const APP_DATA_VERSION_KEY = 'fr_pos_app_data_version';

const SHEETS = {
  Branches: ['branch_id', 'name', 'type', 'address', 'status'],
  Admins: ['admin_id', 'full_name', 'username', 'password_hash', 'status'],
  StaffAccounts: ['staff_id', 'full_name', 'username', 'password_hash', 'branch_id', 'permissions', 'status', 'must_change_password', 'last_login', 'password_reset_at'],
  Sessions: ['session_token', 'account_id', 'role', 'expires_at', 'status'],
  AccountAudit: ['audit_id', 'actor_id', 'action', 'target_id', 'details', 'date'],
  Products: ['product_id', 'name', 'unit', 'price', 'category', 'sku', 'low_stock_level', 'status'],
  BranchProducts: ['branch_id', 'product_id', 'price_override', 'low_stock_level', 'status'],
  Customers: ['customer_id', 'branch_id', 'name', 'phone', 'address', 'status'],
  Inventory: ['branch_id', 'product_id', 'qty'],
  StockIns: ['stock_in_id', 'branch_id', 'product_id', 'qty', 'date', 'status'],
  StockTransfers: ['transfer_id', 'source_branch_id', 'destination_branch_id', 'product_id', 'qty', 'status', 'created_at', 'dispatched_at', 'received_at', 'cancelled_at', 'notes'],
  Sales: ['sale_id', 'branch_id', 'date', 'customer_id', 'total', 'payment_type', 'status', 'discount', 'cash_tendered', 'change'],
  SaleItems: ['sale_id', 'product_id', 'qty', 'price'],
  CreditPayments: ['payment_id', 'branch_id', 'sale_id', 'customer_id', 'amount', 'date', 'notes'],
};

function doGet(e) {
  const data = e && e.parameter ? e.parameter : {};
  return respond_(route_(data.action, data));
}

function doPost(e) {
  const payload = JSON.parse(e.postData.contents || '{}');
  return respond_(route_(payload.action, payload));
}

function setupSheets() {
  const spreadsheet = getSpreadsheet_();
  Object.keys(SHEETS).forEach((name) => {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    ensureHeaders_(sheet, SHEETS[name]);
  });
  removeColumnByHeader_(spreadsheet.getSheetByName('Products'), 'cost_price');

  const branches = spreadsheet.getSheetByName('Branches');
  if (branches.getLastRow() === 1) branches.appendRow(['MAIN', 'Main Branch', 'Main', '', 'Active']);
  seedBranchProducts_();
  invalidateAppData_();
  return 'Sheets are ready.';
}

function route_(action, data) {
  try {
    if (!['getSetupStatus', 'createFirstAdmin', 'login', 'restoreSession', 'logout'].includes(action)) authorize_(data, action);
    switch (action) {
      case 'getProducts': return { ok: true, data: getProducts_() };
      case 'getAppData': return { ok: true, data: getAppData_(data.branchId || 'MAIN') };
      case 'getSetupStatus': return { ok: true, data: { needsAdmin: rows_('Admins').length === 0 } };
      case 'createFirstAdmin': return { ok: true, data: createFirstAdmin_(data) };
      case 'login': return { ok: true, data: login_(data) };
      case 'restoreSession': return { ok: true, data: restoreSession_(data) };
      case 'logout': return { ok: true, data: logout_(data) };
      case 'getStaffAccounts': return { ok: true, data: getStaffAccounts_(data) };
      case 'createStaffAccount': return { ok: true, data: createStaffAccount_(data) };
      case 'updateStaffAccount': return { ok: true, data: updateStaffAccount_(data) };
      case 'setStaffAccountStatus': return { ok: true, data: setStaffAccountStatus_(data) };
      case 'resetStaffPassword': return { ok: true, data: resetStaffPassword_(data) };
      case 'getAdminAccount': return { ok: true, data: getAdminAccount_(data) };
      case 'getAdminAccounts': return { ok: true, data: getAdminAccounts_(data) };
      case 'createAdminAccount': return { ok: true, data: createAdminAccount_(data) };
      case 'setAdminAccountStatus': return { ok: true, data: setAdminAccountStatus_(data) };
      case 'updateAdminAccount': return { ok: true, data: updateAdminAccount_(data) };
      case 'changeOwnPassword': return { ok: true, data: changeOwnPassword_(data) };
      case 'getBranches': return { ok: true, data: getBranches_() };
      case 'createBranch': return { ok: true, data: createBranch_(data) };
      case 'updateBranch': return { ok: true, data: updateBranch_(data) };
      case 'getCustomers': return { ok: true, data: getCustomers_(data.branchId || 'MAIN') };
      case 'createCustomer': return { ok: true, data: createCustomer_(data) };
      case 'updateCustomer': return { ok: true, data: updateCustomer_(data) };
      case 'getCreditData': return { ok: true, data: getCreditData_(data.branchId || 'MAIN') };
      case 'recordCreditPayment': return { ok: true, data: recordCreditPayment_(data) };
      case 'deleteCreditPayment': return { ok: true, data: deleteCreditPayment_(data) };
      case 'getSalesHistory': return { ok: true, data: getSalesHistory_(data.branchId || 'MAIN') };
      case 'getTransfers': return { ok: true, data: getTransfers_(data.branchId || 'MAIN') };
      case 'getTransferProducts': return { ok: true, data: getTransferProducts_(data.sourceBranchId, data.destinationBranchId) };
      case 'createTransfer': return { ok: true, data: createTransfer_(data) };
      case 'dispatchTransfer': return { ok: true, data: dispatchTransfer_(data) };
      case 'receiveTransfer': return { ok: true, data: receiveTransfer_(data) };
      case 'cancelTransfer': return { ok: true, data: cancelTransfer_(data) };
      case 'getInventory': return { ok: true, data: getInventory_(data.branchId || 'MAIN') };
      case 'createProduct': return { ok: true, data: createProduct_(data) };
      case 'addProductToBranch': return { ok: true, data: addProductToBranch_(data) };
      case 'updateProduct': return { ok: true, data: updateProduct_(data) };
      case 'deleteProduct': return { ok: true, data: deleteProduct_(data) };
      case 'stockIn': return { ok: true, data: stockIn_(data) };
      case 'recordSale': return { ok: true, data: recordSale_(data) };
      default: throw new Error('Unknown action.');
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function createFirstAdmin_(data) {
  if (rows_('Admins').length) throw new Error('An administrator already exists.');
  require_(data.fullName, 'Full name is required.');
  require_(data.username, 'Username is required.');
  require_(data.password, 'Password is required.');
  if (String(data.password).length < 8) throw new Error('Password must have at least 8 characters.');
  const admin = { id: id_('ADM'), fullName: data.fullName.trim(), username: data.username.trim().toLowerCase(), status: 'Active' };
  getSpreadsheet_().getSheetByName('Admins').appendRow([admin.id, admin.fullName, admin.username, hash_(data.password), admin.status]);
  return createSession_(admin);
}

function login_(data) {
  require_(data.username, 'Username is required.');
  require_(data.password, 'Password is required.');
  const username = data.username.trim().toLowerCase();
  const admin = rows_('Admins').find((row) => row.username === username && row.status === 'Active');
  if (admin && admin.password_hash === hash_(data.password)) return createSession_({ id: admin.admin_id, fullName: admin.full_name, username: admin.username, role: 'admin' });
  const staff = rows_('StaffAccounts').find((row) => row.username === username && row.status === 'Active');
  if (!staff || staff.password_hash !== hash_(data.password)) throw new Error('Invalid username or password.');
  updateSheetRow_('StaffAccounts', 'staff_id', staff.staff_id, { last_login: new Date() });
  return createSession_({ id: staff.staff_id, fullName: staff.full_name, username: staff.username, role: 'staff', branchId: staff.branch_id, permissions: parsePermissions_(staff.permissions), mustChangePassword: String(staff.must_change_password) === 'TRUE' });
}

function createSession_(account) {
  const token = Utilities.getUuid();
  const expiresAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000));
  const role = account.role || 'admin';
  getSpreadsheet_().getSheetByName('Sessions').appendRow([token, account.id, role, expiresAt, 'Active']);
  return { token, account: { id: account.id, fullName: account.fullName, username: account.username, role, branchId: account.branchId || '', permissions: account.permissions || ['*'], mustChangePassword: !!account.mustChangePassword } };
}

function restoreSession_(data) {
  require_(data.token, 'Session is required.');
  const session = rows_('Sessions').find((row) => row.session_token === data.token && row.status === 'Active' && new Date(row.expires_at) > new Date());
  if (!session) throw new Error('Your session has expired.');
  const account = sessionAccount_(session);
  if (!account) throw new Error('Account is unavailable.');
  return { token: data.token, account };
}

function logout_(data) {
  if (!data.token) return { loggedOut: true };
  const sheet = getSpreadsheet_().getSheetByName('Sessions');
  const values = sheet.getDataRange().getValues();
  const row = values.findIndex((record, index) => index > 0 && record[0] === data.token);
  if (row !== -1) sheet.getRange(row + 1, 5).setValue('Logged out');
  return { loggedOut: true };
}

function sessionAccount_(session) {
  if (session.role === 'admin') {
    const admin = rows_('Admins').find((row) => row.admin_id === session.account_id && row.status === 'Active');
    return admin ? { id: admin.admin_id, fullName: admin.full_name, username: admin.username, role: 'admin', branchId: '', permissions: ['*'], mustChangePassword: false } : null;
  }
  const staff = rows_('StaffAccounts').find((row) => row.staff_id === session.account_id && row.status === 'Active');
  return staff ? { id: staff.staff_id, fullName: staff.full_name, username: staff.username, role: 'staff', branchId: staff.branch_id, permissions: parsePermissions_(staff.permissions), mustChangePassword: String(staff.must_change_password) === 'TRUE' } : null;
}

function authorize_(data, action) {
  require_(data.token, 'Sign in is required.');
  const session = rows_('Sessions').find((row) => row.session_token === data.token && row.status === 'Active' && new Date(row.expires_at) > new Date());
  if (!session) throw new Error('Your session has expired.');
  const account = sessionAccount_(session);
  if (!account) throw new Error('Account is unavailable.');
  data._account = account;
  if (account.mustChangePassword && action !== 'changeOwnPassword') throw new Error('Change your temporary password before continuing.');
  if (account.role === 'admin') return account;
  const permissionMap = {
    createProduct: 'products', updateProduct: 'products', deleteProduct: 'products', addProductToBranch: 'products',
    stockIn: 'inventory', createTransfer: 'transfers', dispatchTransfer: 'transfers', receiveTransfer: 'transfers', cancelTransfer: 'transfers',
    createCustomer: 'customers', updateCustomer: 'customers', recordCreditPayment: 'credits', deleteCreditPayment: 'credits', recordSale: 'pos',
  };
  const requiredPermission = permissionMap[action];
  if (requiredPermission && !account.permissions.includes(requiredPermission)) throw new Error('Your account does not have access to this action.');
  ['getBranches', 'createBranch', 'updateBranch', 'deleteProduct', 'getStaffAccounts', 'createStaffAccount', 'updateStaffAccount', 'setStaffAccountStatus', 'resetStaffPassword', 'getAdminAccount', 'getAdminAccounts', 'createAdminAccount', 'setAdminAccountStatus', 'updateAdminAccount'].forEach((adminAction) => {
    if (action === adminAction) throw new Error('Administrator access is required.');
  });
  const branchIds = [data.branchId, data.sourceBranchId, data.destinationBranchId].filter(Boolean);
  if (branchIds.some((branchId) => branchId !== account.branchId)) throw new Error('Your account is limited to its assigned branch.');
  if (['dispatchTransfer', 'receiveTransfer', 'cancelTransfer'].includes(action)) {
    const transfer = getTransferRecord_(data.transferId);
    const allowedBranch = action === 'receiveTransfer' ? transfer.destination_branch_id : transfer.source_branch_id;
    if (allowedBranch !== account.branchId) throw new Error('Your account is limited to its assigned branch.');
  }
  return account;
}

function getStaffAccounts_(data) {
  return rows_('StaffAccounts').map((row) => ({
    id: row.staff_id, fullName: row.full_name, username: row.username, branchId: row.branch_id,
    permissions: parsePermissions_(row.permissions), status: row.status || 'Active',
    mustChangePassword: String(row.must_change_password) === 'TRUE', lastLogin: row.last_login || '', passwordResetAt: row.password_reset_at || '',
  }));
}

function createStaffAccount_(data) {
  require_(data.fullName, 'Full name is required.');
  require_(data.username, 'Username is required.');
  require_(data.password, 'Temporary password is required.');
  require_(data.branchId, 'Assigned branch is required.');
  if (String(data.password).length < 8) throw new Error('Password must have at least 8 characters.');
  requireBranch_(data.branchId);
  const username = data.username.trim().toLowerCase();
  if (rows_('Admins').some((row) => row.username === username) || rows_('StaffAccounts').some((row) => row.username === username)) throw new Error('That username is already in use.');
  const permissions = normalizePermissions_(data.permissions);
  if (!permissions.length) throw new Error('Select at least one allowed sidebar menu.');
  const staff = { id: id_('STF'), fullName: data.fullName.trim(), username, branchId: data.branchId, permissions, status: 'Active' };
  getSpreadsheet_().getSheetByName('StaffAccounts').appendRow([staff.id, staff.fullName, staff.username, hash_(data.password), staff.branchId, staff.permissions.join(','), staff.status, true, '', new Date()]);
  auditAccount_(data._account.id, 'Created staff account', staff.id, staff.fullName);
  return { ...staff, mustChangePassword: true };
}

function updateStaffAccount_(data) {
  require_(data.staffId, 'Staff account is required.');
  require_(data.fullName, 'Full name is required.');
  require_(data.branchId, 'Assigned branch is required.');
  requireBranch_(data.branchId);
  const staff = rows_('StaffAccounts').find((row) => row.staff_id === data.staffId);
  if (!staff) throw new Error('Staff account not found.');
  const permissions = normalizePermissions_(data.permissions);
  if (!permissions.length) throw new Error('Select at least one allowed sidebar menu.');
  updateSheetRow_('StaffAccounts', 'staff_id', data.staffId, { full_name: data.fullName.trim(), branch_id: data.branchId, permissions: permissions.join(',') });
  auditAccount_(data._account.id, 'Updated staff account', data.staffId, data.fullName.trim());
  return { id: data.staffId, fullName: data.fullName.trim(), username: staff.username, branchId: data.branchId, permissions, status: staff.status };
}

function setStaffAccountStatus_(data) {
  require_(data.staffId, 'Staff account is required.');
  const status = data.status === 'Inactive' ? 'Inactive' : 'Active';
  const staff = rows_('StaffAccounts').find((row) => row.staff_id === data.staffId);
  if (!staff) throw new Error('Staff account not found.');
  updateSheetRow_('StaffAccounts', 'staff_id', data.staffId, { status });
  if (status === 'Inactive') deactivateSessions_(data.staffId);
  auditAccount_(data._account.id, status === 'Active' ? 'Reactivated staff account' : 'Deactivated staff account', data.staffId, staff.full_name);
  return { id: data.staffId, status };
}

function resetStaffPassword_(data) {
  require_(data.staffId, 'Staff account is required.');
  require_(data.temporaryPassword, 'Temporary password is required.');
  if (String(data.temporaryPassword).length < 8) throw new Error('Password must have at least 8 characters.');
  const staff = rows_('StaffAccounts').find((row) => row.staff_id === data.staffId);
  if (!staff) throw new Error('Staff account not found.');
  updateSheetRow_('StaffAccounts', 'staff_id', data.staffId, { password_hash: hash_(data.temporaryPassword), must_change_password: true, password_reset_at: new Date() });
  deactivateSessions_(data.staffId);
  auditAccount_(data._account.id, 'Reset staff password', data.staffId, staff.full_name);
  return { reset: true };
}

function getAdminAccount_(data) {
  const admin = rows_('Admins').find((row) => row.admin_id === data._account.id);
  return { id: admin.admin_id, fullName: admin.full_name, username: admin.username };
}

function getAdminAccounts_() {
  return rows_('Admins').map((row) => ({ id: row.admin_id, fullName: row.full_name, username: row.username, status: row.status || 'Active' }));
}

function createAdminAccount_(data) {
  require_(data.fullName, 'Full name is required.');
  require_(data.username, 'Username is required.');
  require_(data.password, 'Password is required.');
  if (String(data.password).length < 8) throw new Error('Password must have at least 8 characters.');
  const username = data.username.trim().toLowerCase();
  if (rows_('Admins').some((row) => row.username === username) || rows_('StaffAccounts').some((row) => row.username === username)) throw new Error('That username is already in use.');
  const admin = { id: id_('ADM'), fullName: data.fullName.trim(), username, status: 'Active' };
  getSpreadsheet_().getSheetByName('Admins').appendRow([admin.id, admin.fullName, admin.username, hash_(data.password), admin.status]);
  auditAccount_(data._account.id, 'Created administrator account', admin.id, admin.fullName);
  return admin;
}

function setAdminAccountStatus_(data) {
  require_(data.adminId, 'Administrator account is required.');
  const admin = rows_('Admins').find((row) => row.admin_id === data.adminId);
  if (!admin) throw new Error('Administrator account not found.');
  if (admin.admin_id === data._account.id) throw new Error('You cannot deactivate your own account.');
  const status = data.status === 'Inactive' ? 'Inactive' : 'Active';
  if (status === 'Inactive' && rows_('Admins').filter((row) => row.status === 'Active').length <= 1) throw new Error('At least one administrator must remain active.');
  updateSheetRow_('Admins', 'admin_id', data.adminId, { status });
  if (status === 'Inactive') deactivateSessions_(data.adminId);
  auditAccount_(data._account.id, status === 'Active' ? 'Reactivated administrator account' : 'Deactivated administrator account', data.adminId, admin.full_name);
  return { id: data.adminId, status };
}

function updateAdminAccount_(data) {
  require_(data.fullName, 'Full name is required.');
  require_(data.username, 'Username is required.');
  const adminId = data.adminId || data._account.id;
  const target = rows_('Admins').find((row) => row.admin_id === adminId);
  if (!target) throw new Error('Administrator account not found.');
  const username = data.username.trim().toLowerCase();
  const duplicate = rows_('Admins').some((row) => row.admin_id !== adminId && row.username === username) || rows_('StaffAccounts').some((row) => row.username === username);
  if (duplicate) throw new Error('That username is already in use.');
  if (data.newPassword && String(data.newPassword).length < 8) throw new Error('Password must have at least 8 characters.');
  const updates = { full_name: data.fullName.trim(), username };
  if (data.newPassword) {
    updates.password_hash = hash_(data.newPassword);
    if (adminId !== data._account.id) deactivateSessions_(adminId);
  }
  updateSheetRow_('Admins', 'admin_id', adminId, updates);
  auditAccount_(data._account.id, 'Updated administrator account', adminId, data.fullName.trim());
  return { id: adminId, fullName: data.fullName.trim(), username };
}

function changeOwnPassword_(data) {
  require_(data.currentPassword, 'Current password is required.');
  require_(data.newPassword, 'New password is required.');
  if (String(data.newPassword).length < 8) throw new Error('Password must have at least 8 characters.');
  const account = data._account;
  const sheetName = account.role === 'admin' ? 'Admins' : 'StaffAccounts';
  const idHeader = account.role === 'admin' ? 'admin_id' : 'staff_id';
  const row = rows_(sheetName).find((record) => record[idHeader] === account.id);
  if (!row || row.password_hash !== hash_(data.currentPassword)) throw new Error('Current password is incorrect.');
  updateSheetRow_(sheetName, idHeader, account.id, { password_hash: hash_(data.newPassword), must_change_password: false });
  auditAccount_(account.id, 'Changed own password', account.id, account.fullName);
  return { changed: true };
}

function parsePermissions_(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
function normalizePermissions_(value) { return (Array.isArray(value) ? value : parsePermissions_(value)).filter((item) => ['pos', 'products', 'inventory', 'transfers', 'customers', 'credits', 'sales', 'inventoryReports'].includes(item)); }
function updateSheetRow_(sheetName, idHeader, id, updates) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName); const values = sheet.getDataRange().getValues(); const headers = values[0];
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf(idHeader)] === id);
  if (row === -1) throw new Error('Account not found.');
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
}
function deactivateSessions_(accountId) {
  const sheet = getSpreadsheet_().getSheetByName('Sessions'); const values = sheet.getDataRange().getValues();
  values.forEach((record, index) => { if (index > 0 && record[1] === accountId && record[4] === 'Active') sheet.getRange(index + 1, 5).setValue('Revoked'); });
}
function auditAccount_(actorId, action, targetId, details) { getSpreadsheet_().getSheetByName('AccountAudit').appendRow([id_('AUD'), actorId, action, targetId, details, new Date()]); }

function getProducts_() {
  return rows_('Products').map((row) => ({
    id: row.product_id, sku: row.sku || row.product_id, name: row.name, unit: row.unit, price: Number(row.price), category: row.category,
    lowStockLevel: Number(row.low_stock_level || 5), status: row.status || 'Active',
  }));
}

function getAppData_(branchId) {
  const version = PropertiesService.getScriptProperties().getProperty(APP_DATA_VERSION_KEY) || '1';
  const cache = CacheService.getScriptCache();
  const cacheKey = `app-data:${version}:${branchId}`;

  // Chunked cache read — reassemble pieces stored as cacheKey:chunk:0, :1, etc.
  const countStr = cache.get(`${cacheKey}:count`);
  if (countStr) {
    const count = Number(countStr);
    const pieces = [];
    let allHit = true;
    for (let i = 0; i < count; i++) {
      const piece = cache.get(`${cacheKey}:chunk:${i}`);
      if (!piece) { allHit = false; break; }
      pieces.push(piece);
    }
    if (allHit) return JSON.parse(pieces.join(''));
  }

  // Pre-load shared data once to avoid redundant sheet reads
  const allCustomers = getCustomers_(branchId);
  const allProductsList = getProducts_();
  const customerMap = Object.fromEntries(allCustomers.map((c) => [c.id, c]));
  const productMap = Object.fromEntries(allProductsList.map((p) => [p.id, p]));

  const creditData = getCreditData_(branchId, customerMap);
  const data = {
    branches: getBranches_(),
    inventory: getInventory_(branchId),
    customers: allCustomers,
    transfers: getTransfers_(branchId),
    products: allProductsList,
    creditAccounts: creditData.accounts,
    creditPayments: creditData.payments,
    salesHistory: getSalesHistory_(branchId, customerMap, productMap),
    inventoryReport: getInventoryReportData_(branchId),
  };

  // Chunked cache write — split into <=85 KB pieces (safe under 100 KB limit)
  const serialized = JSON.stringify(data);
  const CHUNK_SIZE = 85000;
  const chunks = [];
  for (let i = 0; i < serialized.length; i += CHUNK_SIZE) {
    chunks.push(serialized.slice(i, i + CHUNK_SIZE));
  }
  // Only cache if reasonable number of chunks (Apps Script cache allows up to ~20 keys per put)
  if (chunks.length <= 15) {
    const entries = { [`${cacheKey}:count`]: String(chunks.length) };
    chunks.forEach((chunk, i) => { entries[`${cacheKey}:chunk:${i}`] = chunk; });
    cache.putAll(entries, 30);
  }
  return data;
}

function getBranches_() {
  return rows_('Branches').map((row) => ({
    id: row.branch_id,
    name: row.name,
    type: normalizeBranchType_(row.type || (row.branch_id === 'MAIN' ? 'Main' : 'Satellite')),
    address: row.address || '',
    status: row.status || 'Active',
  }));
}

function createBranch_(data) {
  require_(data.name, 'Branch name is required.');
  const type = normalizeBranchType_(data.type);
  if (type === 'Main' && getBranches_().some((branch) => branch.type === 'Main')) {
    throw new Error('Only one main branch is allowed.');
  }
  const branch = { id: id_('BRN'), name: data.name.trim(), type, address: String(data.address || '').trim(), status: 'Active' };
  getSpreadsheet_().getSheetByName('Branches').appendRow([branch.id, branch.name, branch.type, branch.address, branch.status]);
  invalidateAppData_();
  return branch;
}

function updateBranch_(data) {
  require_(data.branchId, 'Branch is required.');
  require_(data.name, 'Branch name is required.');
  const type = normalizeBranchType_(data.type);
  const status = data.status || 'Active';
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid branch status.');
  const branches = getBranches_();
  const current = branches.find((branch) => branch.id === data.branchId);
  if (!current) throw new Error('Branch not found.');
  if (current.id === 'MAIN' && (type !== 'Main' || status !== 'Active')) throw new Error('Main Branch must remain active and primary.');
  if (type === 'Main' && branches.some((branch) => branch.id !== current.id && branch.type === 'Main')) throw new Error('Only one main branch is allowed.');

  const sheet = getSpreadsheet_().getSheetByName('Branches');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('branch_id')] === data.branchId);
  const updates = { name: data.name.trim(), type, address: String(data.address || '').trim(), status };
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
  invalidateAppData_();
  return { id: data.branchId, ...updates };
}

function getCustomers_(branchId) {
  requireBranch_(branchId);
  return rows_('Customers').filter((row) => row.branch_id === branchId).map((row) => ({
    id: row.customer_id, branchId: row.branch_id, name: row.name, phone: row.phone || '', address: row.address || '', status: row.status || 'Active',
  }));
}

function createCustomer_(data) {
  require_(data.name, 'Customer name is required.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const status = data.status || 'Active';
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid customer status.');
  const customer = { id: id_('CUS'), branchId, name: data.name.trim(), phone: String(data.phone || '').trim(), address: String(data.address || '').trim(), status };
  getSpreadsheet_().getSheetByName('Customers').appendRow([customer.id, customer.branchId, customer.name, customer.phone, customer.address, customer.status]);
  invalidateAppData_();
  return customer;
}

function updateCustomer_(data) {
  require_(data.customerId, 'Customer is required.');
  require_(data.name, 'Customer name is required.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const status = data.status || 'Active';
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid customer status.');
  const sheet = getSpreadsheet_().getSheetByName('Customers');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('customer_id')] === data.customerId && record[headers.indexOf('branch_id')] === branchId);
  if (row === -1) throw new Error('Customer not found in the selected branch.');
  const updates = { name: data.name.trim(), phone: String(data.phone || '').trim(), address: String(data.address || '').trim(), status };
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
  invalidateAppData_();
  return { id: data.customerId, branchId, ...updates };
}

function getCreditData_(branchId, customerMap) {
  requireBranch_(branchId);
  // Accept pre-loaded customer map from getAppData_ to avoid redundant sheet reads
  const customers = customerMap || Object.fromEntries(getCustomers_(branchId).map((customer) => [customer.id, customer]));
  const payments = rows_('CreditPayments').filter((payment) => payment.branch_id === branchId);
  const paidBySale = creditPaidBySale_(payments);
  const accounts = rows_('Sales')
    .filter((sale) => sale.branch_id === branchId && String(sale.payment_type).toLowerCase() === 'credit')
    .map((sale) => {
      const total = Number(sale.total || 0);
      const paid = paidBySale[sale.sale_id] || 0;
      return {
        saleId: sale.sale_id, customerId: sale.customer_id, customerName: customers[sale.customer_id]?.name || 'Unknown customer',
        date: sale.date, total, paid, balance: Math.max(total - paid, 0),
      };
    })
    .filter((account) => account.balance > 0.00001)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return {
    accounts,
    payments: payments.map((payment) => ({
      id: payment.payment_id, saleId: payment.sale_id, customerId: payment.customer_id, customerName: customers[payment.customer_id]?.name || 'Unknown customer',
      amount: Number(payment.amount || 0), date: payment.date, notes: payment.notes || '',
    })).sort((a, b) => new Date(b.date) - new Date(a.date)),
  };
}

function creditPaidBySale_(payments) {
  return payments.reduce((totals, payment) => {
    totals[payment.sale_id] = (totals[payment.sale_id] || 0) + Number(payment.amount || 0);
    return totals;
  }, {});
}

function recordCreditPayment_(data) {
  require_(data.saleId, 'Credit sale is required.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a payment amount greater than zero.');
  const sale = rows_('Sales').find((item) => item.sale_id === data.saleId && item.branch_id === branchId);
  if (!sale || String(sale.payment_type).toLowerCase() !== 'credit') throw new Error('Credit sale not found in the selected branch.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const paid = rows_('CreditPayments').filter((payment) => payment.sale_id === sale.sale_id).reduce((total, payment) => total + Number(payment.amount || 0), 0);
    const balance = Number(sale.total || 0) - paid;
    if (amount > balance + 0.00001) throw new Error('Payment cannot exceed the outstanding balance.');
    const payment = { id: id_('CPY'), branchId, saleId: sale.sale_id, customerId: sale.customer_id, amount, date: new Date(), notes: String(data.notes || '').trim() };
    getSpreadsheet_().getSheetByName('CreditPayments').appendRow([payment.id, payment.branchId, payment.saleId, payment.customerId, payment.amount, payment.date, payment.notes]);
    invalidateAppData_();
    return { ...payment, balance: Math.max(balance - amount, 0) };
  } finally {
    lock.releaseLock();
  }
}

function deleteCreditPayment_(data) {
  require_(data.paymentId, 'Credit payment is required.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSpreadsheet_().getSheetByName('CreditPayments');
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('payment_id')] === data.paymentId && record[headers.indexOf('branch_id')] === branchId);
    if (row === -1) throw new Error('Credit payment not found in the selected branch.');
    sheet.deleteRow(row + 1);
    invalidateAppData_();
    return { paymentId: data.paymentId };
  } finally {
    lock.releaseLock();
  }
}

function getSalesHistory_(branchId, customerMap, productMap) {
  requireBranch_(branchId);
  // Accept pre-loaded maps from getAppData_ to avoid redundant sheet reads
  const customers = customerMap || Object.fromEntries(getCustomers_(branchId).map((customer) => [customer.id, customer]));
  const products = productMap || Object.fromEntries(getProducts_().map((product) => [product.id, product]));
  const saleItems = rows_('SaleItems');
  const paidBySale = creditPaidBySale_(rows_('CreditPayments').filter((payment) => payment.branch_id === branchId));
  return rows_('Sales').filter((sale) => sale.branch_id === branchId).map((sale) => {
    const paymentType = String(sale.payment_type || 'cash').toLowerCase();
    const total = Number(sale.total || 0);
    const paid = paidBySale[sale.sale_id] || 0;
    return {
      saleId: sale.sale_id, branchId: sale.branch_id, date: sale.date, customerId: sale.customer_id || '', customerName: customers[sale.customer_id]?.name || 'Walk-in customer',
      subtotal: total + Number(sale.discount || 0), total, discount: Number(sale.discount || 0), paymentType, status: sale.status || 'completed', cashTendered: Number(sale.cash_tendered || 0), change: Number(sale.change || 0),
      creditPaid: paymentType === 'credit' ? paid : total, creditBalance: paymentType === 'credit' ? Math.max(total - paid, 0) : 0,
      items: saleItems.filter((item) => item.sale_id === sale.sale_id).map((item) => ({
        productId: item.product_id, name: products[item.product_id]?.name || 'Unknown product', unit: products[item.product_id]?.unit || 'unit', qty: Number(item.qty || 0), price: Number(item.price || 0),
      })),
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getTransfers_(branchId) {
  requireBranch_(branchId);
  const branches = Object.fromEntries(getBranches_().map((branch) => [branch.id, branch]));
  const products = Object.fromEntries(getProducts_().map((product) => [product.id, product]));
  return rows_('StockTransfers').filter((row) => row.source_branch_id === branchId || row.destination_branch_id === branchId).map((row) => ({
    id: row.transfer_id,
    sourceBranchId: row.source_branch_id,
    destinationBranchId: row.destination_branch_id,
    sourceBranchName: branches[row.source_branch_id]?.name || row.source_branch_id,
    destinationBranchName: branches[row.destination_branch_id]?.name || row.destination_branch_id,
    productId: row.product_id,
    productName: products[row.product_id]?.name || row.product_id,
    unit: products[row.product_id]?.unit || '',
    qty: Number(row.qty), status: row.status, createdAt: row.created_at, dispatchedAt: row.dispatched_at, receivedAt: row.received_at, notes: row.notes || '',
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createTransfer_(data) {
  require_(data.productId, 'Product is required.');
  require_(data.destinationBranchId, 'Destination branch is required.');
  const sourceBranchId = data.sourceBranchId || 'MAIN';
  requireBranch_(sourceBranchId);
  requireBranch_(data.destinationBranchId);
  if (sourceBranchId === data.destinationBranchId) throw new Error('Choose a different destination branch.');
  if (!hasBranchProduct_(sourceBranchId, data.productId) || !hasBranchProduct_(data.destinationBranchId, data.productId)) {
    throw new Error('Choose a product available in both source and destination branches.');
  }
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Transfer quantity must be greater than zero.');
  const transfer = { id: id_('TRF'), sourceBranchId, destinationBranchId: data.destinationBranchId, productId: data.productId, qty, status: 'Draft', createdAt: new Date(), notes: String(data.notes || '').trim() };
  getSpreadsheet_().getSheetByName('StockTransfers').appendRow([transfer.id, transfer.sourceBranchId, transfer.destinationBranchId, transfer.productId, transfer.qty, transfer.status, transfer.createdAt, '', '', '', transfer.notes]);
  invalidateAppData_();
  return transfer;
}

function getInventoryReportData_(branchId) {
  requireBranch_(branchId);
  const totals = {};
  const getTotal = (productId) => totals[productId] || (totals[productId] = { qtySold: 0, qtyStockIn: 0, qtyTransferIn: 0, qtyTransferOut: 0 });

  const completedSaleIds = new Set(rows_('Sales')
    .filter((row) => row.branch_id === branchId && String(row.status || '').toLowerCase() === 'completed')
    .map((row) => row.sale_id));
  rows_('SaleItems').forEach((row) => {
    if (completedSaleIds.has(row.sale_id)) getTotal(row.product_id).qtySold += Number(row.qty) || 0;
  });

  rows_('StockIns').forEach((row) => {
    if (row.branch_id === branchId && String(row.status || '').toLowerCase() === 'completed') {
      getTotal(row.product_id).qtyStockIn += Number(row.qty) || 0;
    }
  });

  rows_('StockTransfers').forEach((row) => {
    const qty = Number(row.qty) || 0;
    if (row.source_branch_id === branchId && ['In Transit', 'Received'].includes(row.status)) {
      getTotal(row.product_id).qtyTransferOut += qty;
    }
    if (row.destination_branch_id === branchId && row.status === 'Received') {
      getTotal(row.product_id).qtyTransferIn += qty;
    }
  });

  return totals;
}

function getTransferProducts_(sourceBranchId, destinationBranchId) {
  require_(sourceBranchId, 'Source branch is required.');
  require_(destinationBranchId, 'Destination branch is required.');
  requireBranch_(sourceBranchId);
  requireBranch_(destinationBranchId);
  if (sourceBranchId === destinationBranchId) throw new Error('Choose a different destination branch.');

  const destinationProductIds = new Set(rows_('BranchProducts')
    .filter((row) => row.branch_id === destinationBranchId)
    .map((row) => row.product_id));

  return getInventory_(sourceBranchId)
    .filter((product) => product.status === 'Active' && destinationProductIds.has(product.id));
}

function dispatchTransfer_(data) {
  const transfer = getTransferRecord_(data.transferId);
  if (transfer.status !== 'Draft') throw new Error('Only draft transfers can be dispatched.');
  if (data.branchId !== transfer.source_branch_id) throw new Error('Dispatch this transfer from its source branch.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sourceStock = getInventory_(transfer.source_branch_id).find((item) => item.id === transfer.product_id);
    if (!sourceStock || sourceStock.qty < Number(transfer.qty)) throw new Error('Insufficient source branch stock for this transfer.');
    adjustInventory_(transfer.source_branch_id, transfer.product_id, -Number(transfer.qty));
    updateTransfer_(transfer.transfer_id, { status: 'In Transit', dispatched_at: new Date() });
    invalidateAppData_();
    return { id: transfer.transfer_id, status: 'In Transit' };
  } finally {
    lock.releaseLock();
  }
}

function receiveTransfer_(data) {
  const transfer = getTransferRecord_(data.transferId);
  if (transfer.status !== 'In Transit') throw new Error('Only in-transit transfers can be received.');
  if (data.branchId !== transfer.destination_branch_id) throw new Error('Receive this transfer from its destination branch.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!hasBranchProduct_(transfer.destination_branch_id, transfer.product_id)) {
      addBranchProduct_(transfer.destination_branch_id, transfer.product_id, { status: 'Inactive' });
    }
    adjustInventory_(transfer.destination_branch_id, transfer.product_id, Number(transfer.qty));
    updateTransfer_(transfer.transfer_id, { status: 'Received', received_at: new Date() });
    invalidateAppData_();
    return { id: transfer.transfer_id, status: 'Received' };
  } finally {
    lock.releaseLock();
  }
}

function cancelTransfer_(data) {
  const transfer = getTransferRecord_(data.transferId);
  if (!['Draft', 'In Transit'].includes(transfer.status)) throw new Error('Only draft or in-transit transfers can be cancelled.');
  if (data.branchId !== transfer.source_branch_id) throw new Error('Cancel this transfer from its source branch.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (transfer.status === 'In Transit') adjustInventory_(transfer.source_branch_id, transfer.product_id, Number(transfer.qty));
    updateTransfer_(transfer.transfer_id, { status: 'Cancelled', cancelled_at: new Date() });
    invalidateAppData_();
    return { id: transfer.transfer_id, status: 'Cancelled' };
  } finally {
    lock.releaseLock();
  }
}

function getInventory_(branchId) {
  requireBranch_(branchId);
  const branchProducts = Object.fromEntries(rows_('BranchProducts').filter((row) => row.branch_id === branchId).map((row) => [row.product_id, row]));
  const products = getProducts_().filter((product) => branchProducts[product.id]).map((product) => {
    const branchProduct = branchProducts[product.id];
    return {
      ...product,
      price: branchProduct.price_override === '' || branchProduct.price_override === undefined ? product.price : Number(branchProduct.price_override),
      lowStockLevel: branchProduct.low_stock_level === '' || branchProduct.low_stock_level === undefined ? product.lowStockLevel : Number(branchProduct.low_stock_level),
      status: branchProduct.status || product.status || 'Active',
    };
  });
  const quantities = {};
  rows_('Inventory').filter((row) => row.branch_id === branchId).forEach((row) => {
    quantities[row.product_id] = Number(row.qty);
  });
  return products.map((product) => ({ ...product, qty: quantities[product.id] || 0 }));
}

function createProduct_(data) {
  require_(data.name, 'Product name is required.');
  require_(data.category, 'Category is required.');
  require_(data.unit, 'Unit of measure is required.');
  const price = Number(data.price);
  const beginningStock = Number(data.beginningStock || 0);
  const lowStockLevel = Number(data.lowStockLevel);
  const status = data.status || 'Active';
  if (!Number.isFinite(price) || price < 0) throw new Error('Enter a valid selling price.');
  if (!Number.isFinite(lowStockLevel) || lowStockLevel < 0) throw new Error('Enter valid low-stock level.');
  if (!Number.isFinite(beginningStock) || beginningStock < 0) throw new Error('Enter valid beginning stock.');
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid product status.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const product = { id: id_('PRD'), sku: sku_(), name: data.name.trim(), unit: data.unit, price, category: data.category, lowStockLevel, status };
  getSpreadsheet_().getSheetByName('Products').appendRow([product.id, product.name, product.unit, product.price, product.category, product.sku, product.lowStockLevel, product.status]);
  addBranchProduct_(branchId, product.id, { priceOverride: price, lowStockLevel, status });
  if (beginningStock > 0) adjustInventory_(branchId, product.id, beginningStock);
  invalidateAppData_();
  return product;
}

function addProductToBranch_(data) {
  require_(data.productId, 'Product is required.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  if (hasBranchProduct_(branchId, data.productId)) throw new Error('This product is already available in the selected branch.');
  const product = getProducts_().find((item) => item.id === data.productId);
  if (!product) throw new Error('Product not found.');
  const price = data.price === '' || data.price === undefined ? product.price : Number(data.price);
  const lowStockLevel = data.lowStockLevel === '' || data.lowStockLevel === undefined ? product.lowStockLevel : Number(data.lowStockLevel);
  const status = data.status || 'Active';
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(lowStockLevel) || lowStockLevel < 0) throw new Error('Enter valid branch product values.');
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid product status.');
  addBranchProduct_(branchId, product.id, { priceOverride: price, lowStockLevel, status });
  invalidateAppData_();
  return { ...product, price, lowStockLevel, status };
}

function stockIn_(data) {
  require_(data.productId, 'Product is required.');
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  if (!hasBranchProduct_(branchId, data.productId)) throw new Error('Register this product in the selected branch before stocking it.');
  adjustInventory_(branchId, data.productId, qty);
  getSpreadsheet_().getSheetByName('StockIns').appendRow([id_('STK'), branchId, data.productId, qty, new Date(), 'Completed']);
  invalidateAppData_();
  return { productId: data.productId, qty };
}

function updateProduct_(data) {
  require_(data.productId, 'Product is required.');
  require_(data.name, 'Product name is required.');
  require_(data.category, 'Category is required.');
  require_(data.unit, 'Unit of measure is required.');
  const price = Number(data.price);
  const lowStockLevel = Number(data.lowStockLevel);
  const status = data.status || 'Active';
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(lowStockLevel) || lowStockLevel < 0) throw new Error('Enter valid product values.');
  if (!['Active', 'Inactive'].includes(status)) throw new Error('Choose a valid product status.');

  const sheet = getSpreadsheet_().getSheetByName('Products');
  const values = sheet.getDataRange().getValues();
  const [headers] = values;
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('product_id')] === data.productId);
  if (row === -1) throw new Error('Product not found.');
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  if (!hasBranchProduct_(branchId, data.productId)) throw new Error('Product is unavailable in the selected branch.');
  const updates = { name: data.name.trim(), category: data.category, unit: data.unit };
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
  updateBranchProduct_(branchId, data.productId, { priceOverride: price, lowStockLevel, status });
  invalidateAppData_();
  return { id: data.productId, ...updates, price, lowStockLevel, status };
}

function deleteProduct_(data) {
  require_(data.productId, 'Product is required.');
  if (rows_('SaleItems').some((item) => item.product_id === data.productId)) throw new Error('Products with recorded sales cannot be deleted.');
  const spreadsheet = getSpreadsheet_();
  const products = spreadsheet.getSheetByName('Products');
  const productValues = products.getDataRange().getValues();
  const productRow = productValues.findIndex((record, index) => index > 0 && record[0] === data.productId);
  if (productRow === -1) throw new Error('Product not found.');

  const inventory = spreadsheet.getSheetByName('Inventory');
  const inventoryValues = inventory.getDataRange().getValues();
  for (let row = inventoryValues.length - 1; row > 0; row -= 1) {
    if (inventoryValues[row][1] === data.productId) inventory.deleteRow(row + 1);
  }
  const branchProducts = spreadsheet.getSheetByName('BranchProducts');
  const branchProductValues = branchProducts.getDataRange().getValues();
  for (let row = branchProductValues.length - 1; row > 0; row -= 1) {
    if (branchProductValues[row][1] === data.productId) branchProducts.deleteRow(row + 1);
  }
  products.deleteRow(productRow + 1);
  invalidateAppData_();
  return { productId: data.productId };
}

function recordSale_(data) {
  const branchId = data.branchId || 'MAIN';
  requireBranch_(branchId);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw new Error('The sale has no items.');
  const paymentType = String(data.paymentType || 'cash').toLowerCase();
  if (!['cash', 'credit'].includes(paymentType)) throw new Error('Choose Cash or Credit payment.');
  const customerId = String(data.customerId || '').trim();
  if (customerId && !rows_('Customers').some((customer) => customer.customer_id === customerId && customer.branch_id === branchId && customer.status === 'Active')) {
    throw new Error('Choose an active customer from the selected branch.');
  }
  if (paymentType === 'credit' && !customerId) throw new Error('Select a customer for a credit sale.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const inventory = getInventory_(branchId);
    const byId = Object.fromEntries(inventory.map((item) => [item.id, item]));
    items.forEach((item) => {
      const qty = Number(item.qty);
      if (!byId[item.productId] || byId[item.productId].status !== 'Active' || !Number.isFinite(qty) || qty <= 0 || byId[item.productId].qty < qty) {
        throw new Error('Insufficient stock for one or more items.');
      }
    });

    const saleId = id_('SAL');
    const saleItems = items.map((item) => {
      const price = item.price === undefined ? byId[item.productId].price : Number(item.price);
      if (!Number.isFinite(price) || price < 0) throw new Error('Enter a valid selling price for every item.');
      return { ...byId[item.productId], qty: Number(item.qty), price };
    });
    const subtotal = saleItems.reduce((sum, item) => sum + item.qty * item.price, 0);
    const discount = Number(data.discount || 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) throw new Error('Enter a valid discount.');
    const total = subtotal - discount;
    const cashTendered = paymentType === 'cash' ? Number(data.cashTendered) : 0;
    if (paymentType === 'cash' && (!Number.isFinite(cashTendered) || cashTendered < total)) throw new Error('Cash tendered must cover the sale total.');
    const change = paymentType === 'cash' ? cashTendered - total : 0;
    const now = new Date();
    getSpreadsheet_().getSheetByName('Sales').appendRow([saleId, branchId, now, customerId, total, paymentType, 'completed', discount, cashTendered, change]);
    const itemRows = saleItems.map((item) => [saleId, item.id, item.qty, item.price]);
    getSpreadsheet_().getSheetByName('SaleItems').getRange(getSpreadsheet_().getSheetByName('SaleItems').getLastRow() + 1, 1, itemRows.length, 4).setValues(itemRows);
    saleItems.forEach((item) => adjustInventory_(branchId, item.id, -item.qty));
    invalidateAppData_();
    return { saleId, subtotal, total, discount, cashTendered, change, paymentType, date: now };
  } finally {
    lock.releaseLock();
  }
}

function adjustInventory_(branchId, productId, change) {
  const sheet = getSpreadsheet_().getSheetByName('Inventory');
  const values = sheet.getDataRange().getValues();
  const row = values.findIndex((entry, index) => index > 0 && entry[0] === branchId && entry[1] === productId);
  if (row === -1) sheet.appendRow([branchId, productId, change]);
  else sheet.getRange(row + 1, 3).setValue(Number(values[row][2]) + change);
}

function seedBranchProducts_() {
  const branchProducts = rows_('BranchProducts');
  const existing = new Set(branchProducts.map((row) => `${row.branch_id}:${row.product_id}`));
  const mappedProducts = new Set(branchProducts.map((row) => row.product_id));
  rows_('Inventory').forEach((row) => {
    const key = `${row.branch_id}:${row.product_id}`;
    mappedProducts.add(row.product_id);
    if (!existing.has(key)) addBranchProduct_(row.branch_id, row.product_id, undefined, existing);
  });
  getProducts_().forEach((product) => {
    if (!mappedProducts.has(product.id)) addBranchProduct_('MAIN', product.id, undefined, existing);
  });
}

function hasBranchProduct_(branchId, productId) {
  return rows_('BranchProducts').some((row) => row.branch_id === branchId && row.product_id === productId);
}

function addBranchProduct_(branchId, productId, settings, knownKeys) {
  const key = `${branchId}:${productId}`;
  if (knownKeys ? knownKeys.has(key) : hasBranchProduct_(branchId, productId)) return;
  const product = getProducts_().find((item) => item.id === productId);
  const values = [branchId, productId, settings?.priceOverride ?? product?.price ?? '', settings?.lowStockLevel ?? product?.lowStockLevel ?? '', settings?.status ?? product?.status ?? 'Active'];
  getSpreadsheet_().getSheetByName('BranchProducts').appendRow(values);
  if (knownKeys) knownKeys.add(key);
}

function updateBranchProduct_(branchId, productId, settings) {
  const sheet = getSpreadsheet_().getSheetByName('BranchProducts');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('branch_id')] === branchId && record[headers.indexOf('product_id')] === productId);
  if (row === -1) throw new Error('Branch product not found.');
  const updates = { price_override: settings.priceOverride, low_stock_level: settings.lowStockLevel, status: settings.status };
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
}

function getTransferRecord_(transferId) {
  require_(transferId, 'Transfer is required.');
  const transfer = rows_('StockTransfers').find((row) => row.transfer_id === transferId);
  if (!transfer) throw new Error('Stock transfer not found.');
  return transfer;
}

function updateTransfer_(transferId, updates) {
  const sheet = getSpreadsheet_().getSheetByName('StockTransfers');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const row = values.findIndex((record, index) => index > 0 && record[headers.indexOf('transfer_id')] === transferId);
  if (row === -1) throw new Error('Stock transfer not found.');
  Object.keys(updates).forEach((header) => sheet.getRange(row + 1, headers.indexOf(header) + 1).setValue(updates[header]));
}

function invalidateAppData_() {
  PropertiesService.getScriptProperties().setProperty(APP_DATA_VERSION_KEY, String(Date.now()));
}

function requireBranch_(branchId) {
  const branch = getBranches_().find((record) => record.id === branchId);
  if (!branch || branch.status !== 'Active') throw new Error('The selected branch is unavailable.');
  return branch;
}

function normalizeBranchType_(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'main') return 'Main';
  if (type === 'satellite') return 'Satellite';
  throw new Error('Choose Main or Satellite branch type.');
}

function rows_(sheetName) {
  const values = getSpreadsheet_().getSheetByName(sheetName).getDataRange().getValues();
  const [headers, ...records] = values;
  return records.filter((record) => record[0] !== '').map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index]])));
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    return;
  }
  const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missing = headers.filter((header) => !currentHeaders.includes(header));
  if (missing.length) sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
}

function removeColumnByHeader_(sheet, header) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const column = headers.indexOf(header);
  if (column !== -1) sheet.deleteColumn(column + 1);
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function id_(prefix) { return `${prefix}-${Utilities.getUuid().slice(0, 8).toUpperCase()}`; }
function sku_() { return `SKU-${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd')}-${Utilities.getUuid().slice(0, 5).toUpperCase()}`; }
function hash_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)).map((byte) => (byte + 256).toString(16).slice(-2)).join(''); }
function require_(value, message) { if (!value) throw new Error(message); }
function respond_(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }
