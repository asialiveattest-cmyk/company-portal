begin;

alter table public.company_settings
	add column if not exists volume_last_decreased_at timestamptz not null default now();

update public.company_settings
set company_volume_inr = 0
where company_volume_inr < 0;

update public.company_settings
set running_account_count = 0
where running_account_count < 0;

alter table public.company_settings
	add constraint company_settings_company_volume_nonnegative
	check (company_volume_inr >= 0);

alter table public.company_settings
	add constraint company_settings_running_account_count_nonnegative
	check (running_account_count >= 0);

create or replace function public.tick_company_volume()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_now timestamptz := clock_timestamp();
begin
	if v_actor_id is null or not exists (
		select 1
		from public.profiles
		where id = v_actor_id
			and approval_status = 'active'
	) then
		raise exception 'Only active users can update the shared company volume.';
	end if;

	update public.company_settings
	set company_volume_inr = greatest(
			0::numeric,
			company_volume_inr - (floor(random() * 99001) + 1000)::numeric
		),
		volume_last_decreased_at = v_now,
		updated_at = v_now
	where id = 1
		and company_volume_inr > 0
		and volume_last_decreased_at <= v_now - interval '2 seconds';
end;
$$;

revoke all on function public.tick_company_volume() from public, anon;
grant execute on function public.tick_company_volume() to authenticated;

commit;
