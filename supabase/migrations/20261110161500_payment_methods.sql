begin;

create table if not exists public.payment_methods (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	method_type text not null check (method_type in ('bank_account', 'usdt_wallet')),
	account_holder_name text,
	bank_name text,
	account_number text,
	ifsc_code text,
	wallet_address text,
	network text,
	is_default boolean not null default false,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint payment_methods_details_check check (
		(
			method_type = 'bank_account'
			and account_holder_name is not null
			and length(btrim(account_holder_name)) between 2 and 120
			and bank_name is not null
			and length(btrim(bank_name)) between 2 and 120
			and account_number is not null
			and account_number ~ '^[A-Za-z0-9/-]{4,34}$'
			and ifsc_code is not null
			and ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
			and wallet_address is null
			and network is null
		)
		or
		(
			method_type = 'usdt_wallet'
			and account_holder_name is null
			and bank_name is null
			and account_number is null
			and ifsc_code is null
			and wallet_address is not null
			and network is not null
			and network in ('TRC20', 'ERC20', 'BEP20')
			and (
				(network = 'TRC20' and wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
				or (network in ('ERC20', 'BEP20') and wallet_address ~ '^0x[0-9A-Fa-f]{40}$')
			)
		)
	)
);

create unique index if not exists payment_methods_one_default_per_user
	on public.payment_methods (user_id)
	where is_default;

create or replace function public.is_active_regular_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select exists (
		select 1
		from public.profiles
		where id = auth.uid()
			and role = 'user'
			and approval_status = 'active'
	);
$$;
revoke all on function public.is_active_regular_user() from public, anon;
grant execute on function public.is_active_regular_user() to authenticated;

alter table public.payment_methods enable row level security;
revoke all privileges on table public.payment_methods from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_methods to authenticated;

drop policy if exists "users and active staff view payment methods" on public.payment_methods;
create policy "users and active staff view payment methods"
	on public.payment_methods
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_user())
		or public.is_staff()
	);

drop policy if exists "active users create own payment methods" on public.payment_methods;
create policy "active users create own payment methods"
	on public.payment_methods
	for insert
	to authenticated
	with check (
		user_id = auth.uid()
		and public.is_active_regular_user()
	);

drop policy if exists "active users update own payment methods" on public.payment_methods;
create policy "active users update own payment methods"
	on public.payment_methods
	for update
	to authenticated
	using (
		user_id = auth.uid()
		and public.is_active_regular_user()
	)
	with check (
		user_id = auth.uid()
		and public.is_active_regular_user()
	);

drop policy if exists "active users delete own payment methods" on public.payment_methods;
create policy "active users delete own payment methods"
	on public.payment_methods
	for delete
	to authenticated
	using (
		user_id = auth.uid()
		and public.is_active_regular_user()
	);

create or replace function public.set_default_payment_method(method_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
	if auth.uid() is null or not public.is_active_regular_user() then
		raise exception 'Only active regular users can set a default payment method.';
	end if;

	update public.payment_methods
	set is_default = false, updated_at = now()
	where user_id = auth.uid() and is_default;

	update public.payment_methods
	set is_default = true, updated_at = now()
	where id = method_id and user_id = auth.uid();

	if not found then
		raise exception 'Payment method not found.';
	end if;
end;
$$;
revoke all on function public.set_default_payment_method(uuid) from public, anon;
grant execute on function public.set_default_payment_method(uuid) to authenticated;

commit;
