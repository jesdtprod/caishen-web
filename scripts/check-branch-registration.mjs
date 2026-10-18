import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const apiSource = source.slice(source.indexOf('function requireSupabase_()'), source.indexOf('function showToast('));
const main = { branch_id: 'MAIN', name: 'Main Branch', type: 'Main', status: 'Active' };

function setup(rows, account = { role: 'admin' }, insertError = null) {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const query = {
        select() { return this; }, order() { return this; }, is() { return this; }, or() { return this; },
        eq(key, value) { call.filters.push([key, value]); return this; },
        insert(value) { call.insert = value; return this; },
        then(resolve) {
          if (call.insert) {
            if (insertError) return resolve({ error: insertError });
            if (table === 'branches') rows.push(call.insert);
            return resolve({ data: call.insert });
          }
          return resolve({ data: table === 'branches' ? rows : [] });
        },
        maybeSingle() {
          return Promise.resolve({ data: rows.find((row) => call.filters.every(([key, value]) => row[key] === value)) || null });
        },
        single() { return Promise.resolve({ data: call.insert }); },
      };
      return query;
    },
    rpc(name, args) { calls.push({ rpc: name, args }); return Promise.resolve({ data: [] }); },
  };
  const context = vm.createContext({ supabaseClient: client, currentSession: { account }, crypto: webcrypto, allProducts: [] });
  vm.runInContext(apiSource, context);
  return { context, calls };
}

// Fresh admin setup persists the branch before any branch-scoped data loads.
{
  const { context, calls } = setup([]);
  const data = await context.getAppData_('MAIN');
  assert.equal(data.branchId, 'MAIN');
  assert.equal(calls[1].insert.branch_id, 'MAIN');
  assert.equal(calls[2].table, 'branches');
}
// Stale selection resolves before queries, without creating another branch.
{
  const { context, calls } = setup([{ ...main, branch_id: 'BRN-REAL' }]);
  const data = await context.getAppData_('DELETED');
  assert.equal(data.branchId, 'BRN-REAL');
  assert.ok(!calls.some((call) => call.insert));
  assert.ok(calls.filter((call) => call.filters?.some(([key]) => key === 'branch_id')).every((call) => call.filters.some(([key, value]) => key === 'branch_id' && value === 'BRN-REAL')));
}
// Staff remain in their assigned branch; missing assignments never create one.
{
  const { context } = setup([main, { ...main, branch_id: 'STAFF' }], { role: 'staff', branchId: 'STAFF' });
  assert.equal((await context.getAppData_('MAIN')).branchId, 'STAFF');
  const missing = setup([], { role: 'staff', branchId: 'STAFF' });
  await assert.rejects(missing.context.getAppData_('STAFF'), /No active branch/);
  assert.ok(!missing.calls.some((call) => call.insert));
}
// Invalid/inactive branches are rejected before creating a catalog product.
for (const rows of [[], [{ ...main, status: 'Inactive' }]]) {
  for (const action of ['createProduct', 'addProductToBranch']) {
    const { context, calls } = setup(rows);
    await assert.rejects(context.api(action, { branchId: 'MAIN' }), /selected branch is unavailable/);
    assert.ok(!calls.some((call) => call.insert));
  }
}
// Failure to initialize the default cannot continue using a fictional branch.
{
  const { context } = setup([], { role: 'admin' }, { message: 'Branch access denied', code: '42501' });
  await assert.rejects(context.getAppData_('MAIN'), /Branch access denied/);
}
// Valid product registration still links the new product to the chosen branch.
{
  const { context, calls } = setup([main]);
  const product = await context.api('createProduct', { branchId: 'MAIN', name: 'Regression product', unit: 'pc', category: 'Supplies', lowStockLevel: 10 });
  const link = calls.find((call) => call.table === 'branch_products' && call.insert);
  assert.equal(link.insert.branch_id, 'MAIN');
  assert.equal(link.insert.product_id, product.id);
}
console.log('Branch registration checks passed (fresh setup, stale selection, staff scope, invalid branch, initialization failure, successful save).');
