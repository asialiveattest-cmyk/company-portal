begin;

create table if not exists public.withdrawal_requests (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	currency text not null check (currency in ('INR', 'USDT')),
	amount numeric(24,6) not null check (amount > 0),
	payment_method_id uuid references public.payment_methods(id) on delete set null,
	payment_method_snapshot jsonb not null,
	status text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'rejected')),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint withdrawal_requests_currency_amount_check check (
		(currency = 'INR' and amount < 10000000000000000 and amount = trunc(amount, 2))
		or (currency = 'USDT' and amount < 1000000000000 and amount = trunc(amount, 6))
	)
);

create index if not exists withdrawal_requests_user_created_idx
	on public.withdrawal_requests(user_id, created_at desc);
create index if not exists withdrawal_requests_open_currency_idx
	on public.withdrawal_requests(user_id, currency)
	where status in ('pending', 'processing');

alter table public.withdrawal_requests enable row level security;
revoke all privileges on table public.withdrawal_requests from public, anon, authenticated;
grant select on table public.withdrawal_requests to authenticated;

drop policy if exists "users and staff read withdrawal requests" on public.withdrawal_requests;
create policy "users and staff read withdrawal requests"
	on public.withdrawal_requests
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_user())
		or public.is_staff()
	);

create or replace function public.create_withdrawal_request(
	p_currency text,
	p_amount numeric,
	p_payment_method_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_balance_usdt numeric(18,6);
	v_balance_inr numeric(18,2);
	v_balance numeric;
	v_reserved numeric;
	v_method public.payment_methods%rowtype;
	v_snapshot jsonb;
	v_request_id uuid;
begin
	if v_user_id is null or not exists (
		select 1
		from public.profiles
		where id = v_user_id and role = 'user' and approval_status = 'active'
	) then
		raise exception 'Only active regular users can submit withdrawal requests.';
	end if;

	if p_currency is null or p_currency not in ('INR', 'USDT')
		or p_amount is null or p_amount <= 0
		or (p_currency = 'INR' and (p_amount >= 10000000000000000 or p_amount <> trunc(p_amount, 2)))
		or (p_currency = 'USDT' and (p_amount >= 1000000000000 or p_amount <> trunc(p_amount, 6))) then
		raise exception 'Enter a positive amount with a valid currency precision.';
	end if;

	select balance_usdt, balance_inr
	into v_balance_usdt, v_balance_inr
	from public.user_balances
	where user_id = v_user_id
	for update;
	if not found then
		raise exception 'No available balance is set for your account.';
	end if;
	v_balance := case when p_currency = 'INR' then v_balance_inr else v_balance_usdt end;

	select *
	into v_method
	from public.payment_methods
	where id = p_payment_method_id and user_id = v_user_id
	for key share;
	if not found or
		(p_currency = 'INR' and v_method.method_type <> 'bank_account') or
		(p_currency = 'USDT' and v_method.method_type <> 'usdt_wallet') then
		raise exception 'Select a saved payment method matching the withdrawal currency.';
	end if;

	v_reserved := coalesce((
		select sum(amount)
		from public.withdrawal_requests
		where user_id = v_user_id
			and currency = p_currency
			and status in ('pending', 'processing')
	), 0);
	if p_amount > v_balance - v_reserved then
		raise exception 'The withdrawal amount exceeds your available balance.';
	end if;

	if p_currency = 'INR' then
		v_snapshot := jsonb_build_object(
			'method_type', v_method.method_type,
			'account_holder_name', v_method.account_holder_name,
			'bank_name', v_method.bank_name,
			'account_number', v_method.account_number,
			'ifsc_code', v_method.ifsc_code
		);
	else
		v_snapshot := jsonb_build_object(
			'method_type', v_method.method_type,
			'wallet_address', v_method.wallet_address,
			'network', v_method.network
		);
	end if;

	insert into public.withdrawal_requests (
		user_id, currency, amount, payment_method_id, payment_method_snapshot
	)
	values (v_user_id, p_currency, p_amount, v_method.id, v_snapshot)
	returning id into v_request_id;

	return v_request_id;
end;
$$;
revoke all on function public.create_withdrawal_request(text, numeric, uuid) from public, anon;
grant execute on function public.create_withdrawal_request(text, numeric, uuid) to authenticated;

create or replace function public.set_withdrawal_request_status(
	p_request_id uuid,
	p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role text;
	v_user_id uuid;
	v_target_role text;
	v_balance_usdt numeric(18,6);
	v_balance_inr numeric(18,2);
	v_balance numeric;
	v_reserved numeric;
	v_request public.withdrawal_requests%rowtype;
begin
	select role::text into v_actor_role
	from public.profiles
	where id = v_actor_id and approval_status = 'active';
	if v_actor_role is null or v_actor_role not in ('employee', 'super_admin') then
		raise exception 'Only active staff can manage withdrawal requests.';
	end if;
	if p_status is null or p_status not in ('pending', 'processing', 'paid', 'rejected') then
		raise exception 'Select a valid withdrawal status.';
	end if;

	select user_id into v_user_id
	from public.withdrawal_requests
	where id = p_request_id;
	if not found then
		raise exception 'Withdrawal request not found.';
	end if;

	select role::text into v_target_role
	from public.profiles
	where id = v_user_id;
	if v_actor_role = 'employee' and v_target_role <> 'user' then
		raise exception 'Employees can manage regular users’ withdrawal requests only.';
	end if;

	select balance_usdt, balance_inr
	into v_balance_usdt, v_balance_inr
	from public.user_balances
	where user_id = v_user_id
	for update;
	if not found then
		raise exception 'The request owner has no balance record.';
	end if;

	select * into v_request
	from public.withdrawal_requests
	where id = p_request_id
	for update;
	if not found or v_request.user_id <> v_user_id then
		raise exception 'Withdrawal request not found.';
	end if;
	if v_request.status = p_status then
		return;
	end if;
	if v_request.status = 'paid' then
		raise exception 'A paid withdrawal request cannot be changed.';
	end if;

	v_balance := case when v_request.currency = 'INR' then v_balance_inr else v_balance_usdt end;
	if p_status in ('pending', 'processing', 'paid') then
		v_reserved := coalesce((
			select sum(amount)
			from public.withdrawal_requests
			where user_id = v_user_id
				and currency = v_request.currency
				and status in ('pending', 'processing')
				and id <> p_request_id
		), 0);
		if v_request.amount > v_balance - v_reserved then
			raise exception 'The request cannot be activated or paid because funds are no longer available.';
		end if;
	end if;

	update public.withdrawal_requests
	set status = p_status, updated_at = now()
	where id = p_request_id;

	if p_status = 'paid' then
		if v_request.currency = 'INR' then
			update public.user_balances
			set balance_inr = balance_inr - v_request.amount, updated_at = now()
			where user_id = v_user_id;
		else
			update public.user_balances
			set balance_usdt = balance_usdt - v_request.amount, updated_at = now()
			where user_id = v_user_id;
		end if;
	end if;
end;
$$;
revoke all on function public.set_withdrawal_request_status(uuid, text) from public, anon;
grant execute on function public.set_withdrawal_request_status(uuid, text) to authenticated;

create or replace function public.guard_withdrawal_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_reserved_inr numeric;
	v_reserved_usdt numeric;
begin
	select
		coalesce(sum(amount) filter (where currency = 'INR'), 0),
		coalesce(sum(amount) filter (where currency = 'USDT'), 0)
	into v_reserved_inr, v_reserved_usdt
	from public.withdrawal_requests
	where user_id = new.user_id and status in ('pending', 'processing');

	if new.balance_inr < v_reserved_inr or new.balance_usdt < v_reserved_usdt then
		raise exception 'Balances cannot be reduced below amounts reserved by open withdrawal requests.';
	end if;
	return new;
end;
$$;
revoke all on function public.guard_withdrawal_reservations() from public, anon, authenticated;

drop trigger if exists guard_withdrawal_reservations_insert on public.user_balances;
drop trigger if exists guard_withdrawal_reservations_update on public.user_balances;
create trigger guard_withdrawal_reservations_insert
	before insert on public.user_balances
	for each row execute function public.guard_withdrawal_reservations();
create trigger guard_withdrawal_reservations_update
	before update of balance_inr, balance_usdt on public.user_balances
	for each row execute function public.guard_withdrawal_reservations();

commit;
