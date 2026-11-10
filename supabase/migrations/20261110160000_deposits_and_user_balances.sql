begin;

-- The existing company_settings row remains the single source for the shared
-- deposit address and QR path.
insert into public.company_settings(id)
values (1)
on conflict (id) do nothing;
-- Deposit settings are read by active users and written only by the protected
-- Edge Function, never directly by an authenticated client.
revoke insert, update, delete on table public.company_settings from public, anon, authenticated;
revoke update (deposit_usdt_address, deposit_qr_path) on table public.company_settings from public, anon, authenticated;
grant select on table public.company_settings to authenticated;

-- Keep balances separate from profiles so the staff profile-read policy cannot
-- expose every user's balance to Employees.
create table if not exists public.user_balances (
	user_id uuid primary key references public.profiles(id) on delete cascade,
	balance_usdt numeric(18,6) not null check (balance_usdt >= 0 and balance_usdt < 1000000000000),
	balance_inr numeric(18,2) not null check (balance_inr >= 0 and balance_inr < 10000000000000000),
	updated_at timestamptz not null default now()
);
alter table public.user_balances enable row level security;
revoke all privileges on table public.user_balances from public, anon, authenticated;
grant select on table public.user_balances to authenticated;

drop policy if exists "users read own balances" on public.user_balances;
create policy "users read own balances"
	on public.user_balances
	for select
	to authenticated
	using (user_id = auth.uid());

create or replace function public.is_super_admin()
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
			and role = 'super_admin'
			and approval_status = 'active'
	);
$$;
grant execute on function public.is_super_admin() to authenticated;

-- The private documents bucket also hosts one fixed shared deposit QR object.
-- Only an active Super Admin may replace it; active users may read it only
-- while that exact object is referenced by the shared company settings row.
drop policy if exists "super admins upload shared deposit qr" on storage.objects;
create policy "super admins upload shared deposit qr"
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'account-documents'
		and name = 'company/deposit-qr.png'
		and public.is_super_admin()
	);

drop policy if exists "super admins replace shared deposit qr" on storage.objects;
create policy "super admins replace shared deposit qr"
	on storage.objects
	for update
	to authenticated
	using (
		bucket_id = 'account-documents'
		and name = 'company/deposit-qr.png'
		and public.is_super_admin()
	)
	with check (
		bucket_id = 'account-documents'
		and name = 'company/deposit-qr.png'
		and public.is_super_admin()
	);

drop policy if exists "active users read current shared deposit qr" on storage.objects;
create policy "active users read current shared deposit qr"
	on storage.objects
	for select
	to authenticated
	using (
		bucket_id = 'account-documents'
		and name = 'company/deposit-qr.png'
		and public.is_active_user()
		and exists (
			select 1
			from public.company_settings
			where id = 1
				and deposit_qr_path = storage.objects.name
		)
	);

-- Enable realtime delivery for the shared settings row and each user's own
-- balance, without changing the existing profile or auth triggers.
do $$
declare
	table_name text;
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
		foreach table_name in array array['company_settings', 'user_balances']
		loop
			if not exists (
				select 1
				from pg_catalog.pg_publication_tables
				where pubname = 'supabase_realtime'
					and schemaname = 'public'
					and tablename = table_name
			) then
				execute format('alter publication supabase_realtime add table public.%I', table_name);
			end if;
		end loop;
	end if;
end;
$$;

commit;
