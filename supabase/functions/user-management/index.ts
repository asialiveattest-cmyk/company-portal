import { createClient, type User } from 'https://esm.sh/@supabase/supabase-js@2';

type ManagedProfile = {
  id: string;
  full_name: string | null;
  role: 'user' | 'employee' | 'super_admin';
  approval_status: 'pending' | 'active' | 'suspended' | 'rejected';
  created_at: string;
};

type ManagementPayload = {
  action?: string;
  userId?: string;
  status?: string;
  fullName?: string;
  email?: string;
  password?: string;
  role?: string;
  note?: string;
  balanceUserId?: string;
  balanceUsdt?: string;
  balanceInr?: string;
  depositAddress?: string;
  depositQrPath?: string | null;
  companyVolume?: string;
  runningAccountCount?: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const isValidAmount = (value: unknown, integerDigits: number, decimalDigits: number): value is string =>
  typeof value === 'string' &&
  new RegExp(`^\\d{1,${integerDigits}}(?:\\.\\d{1,${decimalDigits}})?$`).test(value);

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'User management is not configured.' }, 500);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication is required.' }, 401);

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Your session is invalid or expired.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: actor, error: actorError } = await admin.from('profiles')
    .select('id,role,approval_status')
    .eq('id', caller.id)
    .single();
  if (actorError || !actor || actor.approval_status !== 'active' || !['employee', 'super_admin'].includes(actor.role)) {
    return json({ error: 'You are not authorized to manage users.' }, 403);
  }

  let payload: ManagementPayload;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request body.' }, 400);
    payload = body as ManagementPayload;
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  if (payload.action === 'list') {
    const profiles: ManagedProfile[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('profiles')
        .select('id,full_name,role,approval_status,created_at')
        .order('created_at', { ascending: false })
        .range(from, from + 999);
      if (error) return json({ error: 'Could not load user profiles.' }, 500);
      profiles.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const authUsers: User[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return json({ error: 'Could not load registered user emails.' }, 500);
      authUsers.push(...data.users);
      if (data.users.length < 1000) break;
    }

    const emailById = new Map<string, string>(authUsers.map((user): [string, string] => [user.id, user.email || '']));
    const noteById = new Map<string, string>();
    for (let from = 0; from < profiles.length; from += 1000) {
      const ids = profiles.slice(from, from + 1000).map((profile) => profile.id);
      if (!ids.length) continue;
      const { data, error } = await admin.from('user_employee_notes')
        .select('user_id,note')
        .in('user_id', ids);
      if (error) return json({ error: 'Could not load employee notes.' }, 500);
      for (const note of data || []) noteById.set(note.user_id, note.note);
    }

    return json({
      users: profiles.map((profile) => ({
        ...profile,
        email: emailById.get(profile.id) || '',
        employee_note: noteById.get(profile.id) || '',
      })),
    });
  }

  if (payload.action === 'set_status') {
    const { userId, status } = payload;
    if (!userId || !['active', 'suspended', 'rejected'].includes(status || '')) {
      return json({ error: 'Invalid user or status.' }, 400);
    }
    if (userId === caller.id) return json({ error: 'You cannot change your own account status.' }, 403);
    const { data: target, error: targetError } = await admin.from('profiles')
      .select('id,role,approval_status')
      .eq('id', userId)
      .maybeSingle();
    if (targetError || !target) return json({ error: 'User not found.' }, 404);
    if (target.role === 'super_admin' || (actor.role !== 'super_admin' && target.role === 'employee')) {
      return json({ error: 'You are not authorized to change this account.' }, 403);
    }
    const allowed =
      (target.approval_status === 'pending' && (status === 'active' || status === 'rejected')) ||
      (target.approval_status === 'active' && (status === 'suspended' || status === 'rejected')) ||
      (target.approval_status === 'suspended' && (status === 'active' || status === 'rejected'));
    if (!allowed) return json({ error: 'This status change is not allowed.' }, 409);

    const { error: updateError } = await admin.from('profiles').update({ approval_status: status }).eq('id', userId);
    if (updateError) return json({ error: 'Could not update this user.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'create_user') {
    const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const password = payload.password;
    const role = payload.role || 'user';
    if (!fullName || fullName.length > 120 || !email || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Enter a valid name and email address.' }, 400);
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return json({ error: 'Password must be between 8 and 128 characters.' }, 400);
    }
    if (!['user', 'employee'].includes(role)) return json({ error: 'Invalid account role.' }, 400);
    if (role === 'employee' && actor.role !== 'super_admin') {
      return json({ error: 'Only a super admin can create employee accounts.' }, 403);
    }

    const { data, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError || !data.user) return json({ error: createError?.message || 'Could not create this user.' }, 400);

    if (role === 'employee') {
      const { error: updateError } = await admin.from('profiles')
        .update({ role: 'employee', approval_status: 'active', full_name: fullName })
        .eq('id', data.user.id);
      if (updateError) {
        const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
        if (deleteError) {
          return json({ error: 'The account was created, but employee access could not be assigned or rolled back. Contact a super admin.' }, 500);
        }
        return json({ error: 'Employee access could not be assigned. The account creation was rolled back.' }, 500);
      }
    }
    return json({ success: true });
  }

  if (payload.action === 'update_note') {
    const { userId, note } = payload;
    if (!userId || typeof note !== 'string' || note.length > 5000) {
      return json({ error: 'Employee notes must be 5,000 characters or fewer.' }, 400);
    }
    const { data: target, error: targetError } = await admin.from('profiles')
      .select('id,role')
      .eq('id', userId)
      .maybeSingle();
    if (targetError || !target) return json({ error: 'User not found.' }, 404);
    if (target.role !== 'user' && actor.role !== 'super_admin') {
      return json({ error: 'You are not authorized to update notes for this account.' }, 403);
    }
    const { error: noteError } = await admin.from('user_employee_notes').upsert({
      user_id: userId,
      note: note.trim(),
      updated_by: caller.id,
      updated_at: new Date().toISOString(),
    });
    if (noteError) return json({ error: 'Could not save this employee note.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'get_balance') {
    if (actor.role !== 'super_admin') return json({ error: 'Only a super admin can view other users’ balances.' }, 403);
    const userId = payload.balanceUserId;
    if (!userId) return json({ error: 'Select a user.' }, 400);
    const { data, error } = await admin.from('user_balances')
      .select('balance_usdt,balance_inr')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return json({ error: 'Could not load this user’s balances.' }, 500);
    return json({
      balance: data
        ? { balanceUsdt: String(data.balance_usdt), balanceInr: String(data.balance_inr) }
        : null,
    });
  }

  if (payload.action === 'update_balance') {
    if (actor.role !== 'super_admin') return json({ error: 'Only a super admin can update user balances.' }, 403);
    const { balanceUserId, balanceUsdt, balanceInr } = payload;
    if (!balanceUserId || !isValidAmount(balanceUsdt, 12, 6) || !isValidAmount(balanceInr, 16, 2)) {
      return json({ error: 'Enter non-negative balances with up to 6 USDT and 2 INR decimal places.' }, 400);
    }
    const { data: target, error: targetError } = await admin.from('profiles')
      .select('id')
      .eq('id', balanceUserId)
      .maybeSingle();
    if (targetError || !target) return json({ error: 'User not found.' }, 404);
    const { error: updateError } = await admin.from('user_balances').upsert({
      user_id: balanceUserId,
      balance_usdt: balanceUsdt,
      balance_inr: balanceInr,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (updateError) return json({ error: 'Could not save this user’s balances.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'update_deposit_settings') {
    if (actor.role !== 'super_admin') return json({ error: 'Only a super admin can update deposit settings.' }, 403);
    const depositAddress = typeof payload.depositAddress === 'string' ? payload.depositAddress.trim() : '';
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(depositAddress)) {
      return json({ error: 'Enter a valid USDT TRC20 address.' }, 400);
    }
    const settings: { deposit_usdt_address: string; updated_at: string; deposit_qr_path?: string | null } = {
      deposit_usdt_address: depositAddress,
      updated_at: new Date().toISOString(),
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'depositQrPath')) {
      if (payload.depositQrPath !== null && payload.depositQrPath !== 'company/deposit-qr.png') {
        return json({ error: 'Invalid deposit QR path.' }, 400);
      }
      settings.deposit_qr_path = payload.depositQrPath;
    }
    const { data, error: updateError } = await admin.from('company_settings')
      .update(settings)
      .eq('id', 1)
      .select('id')
      .maybeSingle();
    if (updateError || !data) return json({ error: 'Could not save deposit settings.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'update_company_settings') {
    if (actor.role !== 'super_admin') return json({ error: 'Only a super admin can update company settings.' }, 403);
    const hasVolume = Object.prototype.hasOwnProperty.call(payload, 'companyVolume');
    const hasRunningCount = Object.prototype.hasOwnProperty.call(payload, 'runningAccountCount');
    if (!hasVolume && !hasRunningCount) return json({ error: 'Enter a company setting to save.' }, 400);

    const settings: {
      company_volume_inr?: string;
      running_account_count?: number;
      volume_last_decreased_at?: string;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };

    if (hasVolume) {
      if (!isValidAmount(payload.companyVolume, 16, 2)) {
        return json({ error: 'Enter a non-negative company volume with up to 2 decimal places.' }, 400);
      }
      settings.company_volume_inr = payload.companyVolume;
      settings.volume_last_decreased_at = new Date().toISOString();
    }

    if (hasRunningCount) {
      const count = payload.runningAccountCount;
      if (typeof count !== 'string' || !/^\d{1,10}$/.test(count) || Number(count) > 2147483647) {
        return json({ error: 'Enter a non-negative whole number up to 2,147,483,647.' }, 400);
      }
      settings.running_account_count = Number(count);
    }

    const { data, error: updateError } = await admin.from('company_settings')
      .update(settings)
      .eq('id', 1)
      .select('id')
      .maybeSingle();
    if (updateError || !data) return json({ error: 'Could not save company settings.' }, 500);
    return json({ success: true });
  }

  return json({ error: 'Unknown action.' }, 400);
});
