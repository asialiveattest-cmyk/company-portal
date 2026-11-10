-- Secure existing profile rows without changing registration data or triggers.
-- All profile role/status writes are performed by the authenticated user-management
-- Edge Function with its server-side service-role client.
begin;

alter table public.profiles enable row level security;

create table if not exists public.user_employee_notes (
	user_id uuid primary key references public.profiles(id) on delete cascade,
	note text not null default '',
	updated_by uuid references public.profiles(id) on delete set null,
	updated_at timestamptz not null default now()
);
alter table public.user_employee_notes enable row level security;
revoke all privileges on table public.user_employee_notes from public, anon, authenticated;

-- RLS policies are permissive by default. Replace every existing profile policy
-- so no legacy INSERT/UPDATE/DELETE policy can grant clients profile writes.
do $$
declare
	profile_policy record;
begin
	for profile_policy in
		select policyname
		from pg_catalog.pg_policies
		where schemaname = 'public'
		  and tablename = 'profiles'
	loop
		execute format('drop policy %I on public.profiles', profile_policy.policyname);
	end loop;
end;
$$;

create policy "profiles_select_own_or_active_staff"
	on public.profiles
	for select
	to authenticated
	using (id = auth.uid() or public.is_staff());

-- Enforce the RLS boundary at the SQL privilege layer too. The auth trigger is
-- SECURITY DEFINER, and the Edge Function uses the server-side service role.
revoke all privileges on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant execute on function public.is_staff() to authenticated;

commit;