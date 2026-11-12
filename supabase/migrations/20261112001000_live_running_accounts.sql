begin;

create table if not exists public.running_accounts (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	account_name text not null check (length(btrim(account_name)) between 1 and 120),
	starting_volume_inr numeric(20,2) not null check (starting_volume_inr >= 0),
	current_volume_inr numeric(20,2) not null check (current_volume_inr >= 0),
	success_rate numeric(5,2) not null default 50 check (success_rate between 50 and 100),
	otp_status text not null default 'online' check (otp_status in ('online', 'dropped')),
	commission_percentage numeric(7,4) not null check (commission_percentage between 0 and 100),
	usdt_conversion_rate numeric(20,8) not null check (usdt_conversion_rate > 0),
	status text not null default 'active' check (status in ('active', 'paused')),
	next_update_at timestamptz not null default (
		clock_timestamp() + (floor(random() * 3) + 1) * interval '1 second'
	),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists running_accounts_user_created_idx
	on public.running_accounts(user_id, created_at, id);
create index if not exists running_accounts_due_idx
	on public.running_accounts(next_update_at)
	where status = 'active';

create table if not exists public.running_account_commissions (
	id uuid primary key default gen_random_uuid(),
	account_id uuid not null references public.running_accounts(id) on delete cascade,
	commission_inr numeric(24,2) not null check (commission_inr >= 0),
	commission_usdt numeric(38,8) not null check (commission_usdt >= 0),
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	reviewed_by uuid references public.profiles(id) on delete restrict,
	reviewed_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint running_account_commissions_review_check check (
		(status = 'pending' and reviewed_by is null and reviewed_at is null)
		or (status in ('approved', 'rejected') and reviewed_by is not null and reviewed_at is not null)
	)
);
create unique index if not exists running_account_commissions_one_pending_idx
	on public.running_account_commissions(account_id)
	where status = 'pending';
create index if not exists running_account_commissions_account_created_idx
	on public.running_account_commissions(account_id, created_at desc);

create or replace view public.running_account_current_commissions
with (security_invoker = true)
as
	select distinct on (account_id)
		id,
		account_id,
		commission_inr,
		commission_usdt,
		status,
		reviewed_by,
		reviewed_at,
		created_at
	from public.running_account_commissions
	order by account_id, created_at desc, id desc;

alter table public.running_accounts enable row level security;
alter table public.running_account_commissions enable row level security;
revoke all privileges on table public.running_accounts from public, anon, authenticated;
revoke all privileges on table public.running_account_commissions from public, anon, authenticated;
grant select, insert, update, delete on table public.running_accounts to authenticated;
grant select on table public.running_account_commissions to authenticated;
revoke all on public.running_account_current_commissions from public, anon, authenticated;
grant select on public.running_account_current_commissions to authenticated;

drop policy if exists "users read own running accounts and admins read all" on public.running_accounts;
create policy "users read own running accounts and admins read all"
	on public.running_accounts
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_regular_user())
		or public.is_super_admin()
	);

drop policy if exists "super admins manage running accounts" on public.running_accounts;
create policy "super admins manage running accounts"
	on public.running_accounts
	for all
	to authenticated
	using (public.is_super_admin())
	with check (
		public.is_super_admin()
		and exists (
			select 1
			from public.profiles
			where id = user_id and role = 'user'
		)
	);

drop policy if exists "users read own running account commissions and admins read all"
	on public.running_account_commissions;
create policy "users read own running account commissions and admins read all"
	on public.running_account_commissions
	for select
	to authenticated
	using (
		public.is_super_admin()
		or (
			public.is_active_regular_user()
			and exists (
				select 1
				from public.running_accounts
				where id = account_id and user_id = auth.uid()
			)
		)
	);

create or replace function public.refresh_running_account_commission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.running_account_commissions(
		account_id, commission_inr, commission_usdt, status, reviewed_by, reviewed_at, updated_at
	)
	values (
		new.id,
		round(new.current_volume_inr * new.commission_percentage / 100, 2),
		round((new.current_volume_inr * new.commission_percentage / 100) / new.usdt_conversion_rate, 8),
		'pending',
		null,
		null,
		clock_timestamp()
	)
	on conflict (account_id) where status = 'pending' do update
	set commission_inr = excluded.commission_inr,
		commission_usdt = excluded.commission_usdt,
		updated_at = excluded.updated_at;
	return new;
end;
$$;
revoke all on function public.refresh_running_account_commission() from public, anon, authenticated;

drop trigger if exists refresh_running_account_commission on public.running_accounts;
create trigger refresh_running_account_commission
	after insert or update of current_volume_inr, commission_percentage, usdt_conversion_rate
	on public.running_accounts
	for each row
	execute function public.refresh_running_account_commission();

create or replace function public.touch_running_account_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'UPDATE' then
		if old.status = 'paused' and new.status = 'active' then
			new.next_update_at := clock_timestamp() + (floor(random() * 3) + 1) * interval '1 second';
		end if;
	end if;
	new.updated_at := clock_timestamp();
	return new;
end;
$$;
revoke all on function public.touch_running_account_updated_at() from public, anon, authenticated;

drop trigger if exists touch_running_account_updated_at on public.running_accounts;
create trigger touch_running_account_updated_at
	before update on public.running_accounts
	for each row
	execute function public.touch_running_account_updated_at();

create or replace function public.tick_running_accounts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_now timestamptz := clock_timestamp();
begin
	with due_accounts as (
		select id
		from public.running_accounts
		where status = 'active'
			and next_update_at <= v_now
		order by next_update_at
		for update skip locked
	)
	update public.running_accounts as account
	set current_volume_inr = account.current_volume_inr + (floor(random() * 9901) + 100)::numeric,
		success_rate = (50 + random() * 50)::numeric(5,2),
		otp_status = case
			when random() < 0.15 then case account.otp_status when 'online' then 'dropped' else 'online' end
			else account.otp_status
		end,
		next_update_at = v_now + (floor(random() * 3) + 1) * interval '1 second',
		updated_at = v_now
	from due_accounts
	where account.id = due_accounts.id;
end;
$$;
revoke all on function public.tick_running_accounts() from public, anon, authenticated;

create or replace function public.set_running_account_commission_status(
	p_commission_id uuid,
	p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_account_id uuid;
begin
	if v_actor_id is null or not public.is_super_admin() then
		raise exception 'Only an active Super Admin can review running account commissions.';
	end if;
	if p_commission_id is null or p_status is null or p_status not in ('approved', 'rejected') then
		raise exception 'Select a valid commission status.';
	end if;

	select account_id into v_account_id
	from public.running_account_commissions
	where id = p_commission_id and status = 'pending';
	if not found then
		raise exception 'Pending running account commission not found.';
	end if;

	update public.running_accounts
	set updated_at = clock_timestamp()
	where id = v_account_id;

	update public.running_account_commissions
	set status = p_status,
		reviewed_by = v_actor_id,
		reviewed_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = p_commission_id and status = 'pending';

	if not found then
		raise exception 'Pending running account commission not found.';
	end if;
end;
$$;
revoke all on function public.set_running_account_commission_status(uuid, text) from public, anon;
grant execute on function public.set_running_account_commission_status(uuid, text) to authenticated;

create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
	v_job_id bigint;
begin
	for v_job_id in
		select jobid from cron.job where jobname = 'tick-running-accounts'
	loop
		perform cron.unschedule(v_job_id);
	end loop;

	perform cron.schedule(
		'tick-running-accounts',
		'1 second',
		'select public.tick_running_accounts();'
	);
end;
$$;

do $$
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'running_accounts'
		) then
			alter publication supabase_realtime add table public.running_accounts;
		end if;
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'running_account_commissions'
		) then
			alter publication supabase_realtime add table public.running_account_commissions;
		end if;
	end if;
end;
$$;

commit;
