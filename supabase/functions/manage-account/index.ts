import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const allowedPermissions = new Set(['pos', 'products', 'inventory', 'transfers', 'customers', 'credits', 'sales', 'inventoryReports', 'dailySpotCash', 'dailyExpenses']);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return fail('Method not allowed.', 405);

  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) return fail('Sign in is required.', 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return fail('Your session has expired.', 401);
  const actorId = userData.user.id;
  const { data: actor } = await admin.from('profiles').select('*').eq('user_id', actorId).maybeSingle();
  if (!actor || actor.role !== 'admin' || actor.status !== 'Active') return fail('Administrator access is required.', 403);

  const body = await request.json().catch(() => null);
  if (!body?.action) return fail('Account action is required.');
  const action = body.action as string;
  const fullName = String(body.fullName || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || body.temporaryPassword || body.newPassword || '');

  const audit = async (name: string, targetId: string, details = '') => {
    await admin.from('account_audit').insert({ actor_id: actorId, action: name, target_id: targetId, details });
  };
  const duplicateUsername = async (value: string, exceptUserId = '') => {
    const query = admin.from('profiles').select('user_id').eq('username', value);
    const { data } = exceptUserId ? await query.neq('user_id', exceptUserId) : await query;
    return Boolean(data?.length);
  };
  const activeBranchExists = async (branchId: string | null) => {
    if (!branchId) return false;
    const { data } = await admin.from('branches').select('branch_id').eq('branch_id', branchId).eq('status', 'Active').maybeSingle();
    return Boolean(data);
  };

  if (action === 'createStaffAccount' || action === 'createAdminAccount') {
    if (!fullName || !username || !email || password.length < 8) return fail('Full name, username, email, and a password of at least 8 characters are required.');
    if (await duplicateUsername(username)) return fail('That username is already in use.');
    const role = action === 'createAdminAccount' ? 'admin' : 'staff';
    const branchId = role === 'staff' ? String(body.branchId || '') : null;
    const permissions = role === 'admin' ? [...allowedPermissions] : (Array.isArray(body.permissions) ? body.permissions.filter((item: unknown): item is string => typeof item === 'string' && allowedPermissions.has(item)) : []);
    if (role === 'staff' && (!branchId || !permissions.length)) return fail('Select an assigned branch and at least one allowed sidebar menu.');
    if (role === 'staff' && !await activeBranchExists(branchId)) return fail('Select an active assigned branch.');
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) return fail(createError?.message || 'Unable to create the sign-in account.');
    const { error: profileError } = await admin.from('profiles').insert({
      user_id: created.user.id, full_name: fullName, username, role, branch_id: branchId, permissions,
      status: 'Active', must_change_password: role === 'staff', password_reset_at: role === 'staff' ? new Date().toISOString() : null,
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return fail(profileError.message);
    }
    await audit(role === 'staff' ? 'Created staff account' : 'Created administrator account', created.user.id, fullName);
    return json({ id: created.user.id, fullName, username, branchId: branchId || '', permissions, status: 'Active', mustChangePassword: role === 'staff' });
  }

  if (action === 'createOperationalBackup') {
    const results = await Promise.all([
      admin.from('branches').select('*').order('branch_id'),
      admin.from('products').select('*').order('product_id'),
      admin.from('branch_products').select('*').order('branch_id').order('product_id'),
      admin.from('customers').select('*').order('customer_id'),
      admin.from('inventory').select('*').order('branch_id').order('product_id'),
      admin.from('stock_ins').select('*').order('stock_in_id'),
      admin.from('stock_transfers').select('*').order('transfer_id'),
      admin.from('sales').select('*').order('sale_id'),
      admin.from('sale_items').select('*').order('sale_item_id'),
      admin.from('customer_credit_accounts').select('*').order('credit_account_id'),
      admin.from('credit_payments').select('*').order('payment_id'),
      admin.from('inventory_cost_batches').select('*').order('branch_id').order('product_id').order('received_at'),
      admin.from('sale_item_cost_allocations').select('*').order('sale_item_id'),
      admin.from('sale_item_price_allocations').select('*').order('sale_item_id'),
      admin.from('transfer_batch_allocations').select('*').order('transfer_id'),
      admin.from('product_bundle_components').select('*').order('bundle_product_id').order('component_product_id'),
      admin.from('sale_bundle_component_allocations').select('*').order('sale_item_id'),
      admin.from('sale_returns').select('*').order('return_id'),
      admin.from('sale_return_items').select('*').order('return_item_id'),
      admin.from('inventory_return_lots').select('*').order('created_at'),
      admin.from('daily_spot_cash').select('*').order('branch_id').order('business_date'),
      admin.from('daily_expenses').select('*').order('branch_id').order('business_date'),
    ]);
    const error = results.find((result) => result.error)?.error;
    if (error) return fail(error.message);
    const rows = results.map((result) => result.data || []);
    await audit('Created operational backup', actorId, '');
    return json({
      schemaVersion: '1',
      createdAt: new Date().toISOString(),
      tables: {
        branches: rows[0], products: rows[1], branchProducts: rows[2], customers: rows[3], inventory: rows[4],
        stockIns: rows[5], stockTransfers: rows[6], sales: rows[7], saleItems: rows[8], customerCreditAccounts: rows[9], creditPayments: rows[10],
        inventoryCostBatches: rows[11], saleItemCostAllocations: rows[12], saleItemPriceAllocations: rows[13], transferBatchAllocations: rows[14],
        bundleComponents: rows[15], saleBundleComponentAllocations: rows[16], saleReturns: rows[17], saleReturnItems: rows[18], inventoryReturnLots: rows[19],
        dailySpotCash: rows[20], dailyExpenses: rows[21],
      },
    });
  }

  if (action === 'restoreOperationalBackup') {
    if (body.confirmation !== 'RESTORE') return fail('Restore confirmation is required.');
    const backup = body.backup;
    if (!backup || backup.schemaVersion !== '1' || typeof backup.tables !== 'object') return fail('Choose a valid FR Merchandise POS backup file.');
    const { data, error } = await admin.rpc('restore_pos_backup_daily_operations', { backup });
    if (error) return fail(error.message);
    await audit('Restored operational backup', actorId, String(backup.createdAt || ''));
    return json(data);
  }

  if (action === 'clearOperationalData') {
    if (body.confirmation !== 'CLEAR_OPERATIONAL_DATA') return fail('Clear-data confirmation is required.');
    const { data, error } = await admin.rpc('clear_operational_data');
    if (error) return fail(error.message);
    return json(data);
  }

  const targetId = String(body.staffId || body.adminId || '');
  if (!targetId) return fail('Account is required.');
  const { data: target, error: targetError } = await admin.from('profiles').select('*').eq('user_id', targetId).maybeSingle();
  if (targetError || !target) return fail('Account not found.', 404);

  if (action === 'updateStaffAccount') {
    const permissions = Array.isArray(body.permissions) ? body.permissions.filter((item: unknown): item is string => typeof item === 'string' && allowedPermissions.has(item)) : [];
    if (target.role !== 'staff' || !fullName || !permissions.length) return fail('Enter valid staff account details.');
    const { error } = await admin.from('profiles').update({ full_name: fullName, permissions }).eq('user_id', targetId);
    if (error) return fail(error.message);
    await audit('Updated staff account', targetId, `${fullName}; branch remains ${target.branch_id}`);
    return json({ id: targetId, fullName, username: target.username, branchId: target.branch_id, permissions, status: target.status });
  }

  if (action === 'updateAdminAccount') {
    if (target.role !== 'admin' || !fullName || !username) return fail('Enter valid administrator account details.');
    if (await duplicateUsername(username, targetId)) return fail('That username is already in use.');
    if (password && password.length < 8) return fail('Enter a password of at least 8 characters.');
    const { error: profileError } = await admin.from('profiles').update({ full_name: fullName, username }).eq('user_id', targetId);
    if (profileError) return fail(profileError.message);
    if (password) {
      const { error: passwordError } = await admin.auth.admin.updateUserById(targetId, { password });
      if (passwordError) return fail(passwordError.message);
      const requiresPasswordChange = targetId !== actorId;
      const { error: resetError } = await admin.from('profiles').update({
        must_change_password: requiresPasswordChange,
        password_reset_at: requiresPasswordChange ? new Date().toISOString() : null,
      }).eq('user_id', targetId);
      if (resetError) return fail(resetError.message);
      await audit(requiresPasswordChange ? 'Reset administrator password' : 'Changed own password', targetId, fullName);
    } else {
      await audit('Updated administrator account', targetId, fullName);
    }
    return json({ id: targetId, fullName, username, mustChangePassword: Boolean(password && targetId !== actorId) });
  }

  if (action === 'resetStaffPassword') {
    if (target.role !== 'staff' || password.length < 8) return fail('Enter a temporary password of at least 8 characters.');
    const { error } = await admin.auth.admin.updateUserById(targetId, { password });
    if (error) return fail(error.message);
    await admin.from('profiles').update({ must_change_password: true, password_reset_at: new Date().toISOString() }).eq('user_id', targetId);
    await audit('Reset staff password', targetId, target.full_name);
    return json({ reset: true });
  }

  if (action === 'setStaffAccountStatus' || action === 'setAdminAccountStatus') {
    if ((action === 'setStaffAccountStatus' && target.role !== 'staff') || (action === 'setAdminAccountStatus' && target.role !== 'admin')) return fail('Account role does not match this action.');
    if (targetId === actorId && body.status === 'Inactive') return fail('You cannot deactivate your own account.');
    if (target.role === 'admin' && body.status === 'Inactive') {
      const { count } = await admin.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'admin').eq('status', 'Active');
      if ((count || 0) <= 1) return fail('At least one administrator must remain active.');
    }
    const status = body.status === 'Inactive' ? 'Inactive' : 'Active';
    const { error } = await admin.from('profiles').update({ status }).eq('user_id', targetId);
    if (error) return fail(error.message);
    const { error: authError } = await admin.auth.admin.updateUserById(targetId, {
      ban_duration: status === 'Inactive' ? '876000h' : 'none',
    });
    if (authError) {
      await admin.from('profiles').update({ status: target.status }).eq('user_id', targetId);
      return fail(authError.message);
    }
    await audit(status === 'Active' ? 'Reactivated account' : 'Deactivated account', targetId, target.full_name);
    return json({ id: targetId, status });
  }

  return fail('Unknown account action.');
});
