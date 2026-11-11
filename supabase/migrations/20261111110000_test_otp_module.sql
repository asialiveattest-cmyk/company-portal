begin;

create table if not exists public.test_otp_assets (
	asset_type text primary key check (asset_type in ('apk', 'video')),
	storage_path text not null unique,
	file_name text not null,
	uploaded_by uuid not null references public.profiles(id),
	uploaded_at timestamptz not null default now(),
	constraint test_otp_assets_storage_path_check check (
		(asset_type = 'apk' and storage_path like 'test-otp/apk/%')
		or (asset_type = 'video' and storage_path like 'test-otp/video/%')
	)
);

create table if not exists public.test_otp_completions (
	user_id uuid not null references public.profiles(id) on delete cascade,
	account_submission_id uuid not null references public.account_submissions(id) on delete cascade,
	completed_at timestamptz not null default now(),
	primary key (user_id, account_submission_id)
);

alter table public.test_otp_assets enable row level security;
alter table public.test_otp_completions enable row level security;
revoke all privileges on table public.test_otp_assets from public, anon, authenticated;
revoke all privileges on table public.test_otp_completions from public, anon, authenticated;
grant select on table public.test_otp_assets, public.test_otp_completions to authenticated;

drop policy if exists "active users read current test otp assets" on public.test_otp_assets;
create policy "active users read current test otp assets"
	on public.test_otp_assets
	for select
	to authenticated
	using (public.is_active_user());

drop policy if exists "users and super admins read test otp completions" on public.test_otp_completions;
create policy "users and super admins read test otp completions"
	on public.test_otp_completions
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_regular_user())
		or public.is_super_admin()
	);

create or replace function public.set_test_otp_asset(
	p_asset_type text,
	p_storage_path text,
	p_file_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or not public.is_super_admin() then
		raise exception 'Only an active Super Admin can manage Test OTP files.';
	end if;
	if p_asset_type is null
		or p_asset_type not in ('apk', 'video')
		or p_storage_path is null
		or (p_asset_type = 'apk' and p_storage_path !~ '^test-otp/apk/[A-Za-z0-9._-]+$')
		or (p_asset_type = 'video' and p_storage_path !~ '^test-otp/video/[A-Za-z0-9._-]+$')
		or p_file_name is null
		or length(btrim(p_file_name)) not between 1 and 255 then
		raise exception 'The Test OTP file details are invalid.';
	end if;
	if not exists (
		select 1
		from storage.objects
		where bucket_id = 'account-documents'
			and name = p_storage_path
	) then
		raise exception 'The Test OTP file was not uploaded.';
	end if;

	insert into public.test_otp_assets(asset_type, storage_path, file_name, uploaded_by, uploaded_at)
	values (p_asset_type, p_storage_path, p_file_name, v_actor_id, clock_timestamp())
	on conflict (asset_type) do update
	set storage_path = excluded.storage_path,
		file_name = excluded.file_name,
		uploaded_by = excluded.uploaded_by,
		uploaded_at = excluded.uploaded_at;
end;
$$;
revoke all on function public.set_test_otp_asset(text, text, text) from public, anon;
grant execute on function public.set_test_otp_asset(text, text, text) to authenticated;

create or replace function public.complete_test_otp_installation(p_account_submission_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_completed_at timestamptz := clock_timestamp();
begin
	if v_user_id is null or not public.is_active_regular_user() then
		raise exception 'Only active regular users can record Test OTP installation.';
	end if;
	if p_account_submission_id is null or not exists (
		select 1
		from public.account_submissions
		where id = p_account_submission_id
			and user_id = v_user_id
	) then
		raise exception 'Select one of your submitted accounts.';
	end if;

	insert into public.test_otp_completions(user_id, account_submission_id, completed_at)
	values (v_user_id, p_account_submission_id, v_completed_at)
	on conflict (user_id, account_submission_id) do update
	set completed_at = excluded.completed_at;

	return v_completed_at;
end;
$$;
revoke all on function public.complete_test_otp_installation(uuid) from public, anon;
grant execute on function public.complete_test_otp_installation(uuid) to authenticated;

drop policy if exists "super admins upload test otp assets" on storage.objects;
create policy "super admins upload test otp assets"
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'account-documents'
		and (
			name like 'test-otp/apk/%'
			or name like 'test-otp/video/%'
		)
		and public.is_super_admin()
	);

drop policy if exists "active users download current test otp assets" on storage.objects;
create policy "active users download current test otp assets"
	on storage.objects
	for select
	to authenticated
	using (
		bucket_id = 'account-documents'
		and public.is_active_user()
		and exists (
			select 1
			from public.test_otp_assets
			where storage_path = storage.objects.name
		)
	);

do $$
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'test_otp_assets'
		) then
			alter publication supabase_realtime add table public.test_otp_assets;
		end if;
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'test_otp_completions'
		) then
			alter publication supabase_realtime add table public.test_otp_completions;
		end if;
	end if;
end;
$$;

commit;
