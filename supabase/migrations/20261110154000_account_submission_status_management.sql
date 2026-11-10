-- Add the staff-managed suspended state without changing existing submission rows.
alter type public.account_state add value if not exists 'suspended';

-- Replace UPDATE policies only, preserving SELECT and INSERT behavior while
-- ensuring active staff are the only authenticated users who can update rows.
do $$
declare
	update_policy record;
begin
	for update_policy in
		select policyname
		from pg_catalog.pg_policies
		where schemaname = 'public'
		  and tablename = 'account_submissions'
		  and cmd = 'UPDATE'
	loop
		execute format('drop policy %I on public.account_submissions', update_policy.policyname);
	end loop;
end;
$$;

create policy "staff update submissions"
	on public.account_submissions
	for update
	to authenticated
	using (public.is_staff())
	with check (public.is_staff());

grant update on table public.account_submissions to authenticated;
