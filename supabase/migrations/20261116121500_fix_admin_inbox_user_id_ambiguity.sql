begin;

create or replace function public.list_company_conversations()
returns table (
	conversation_id uuid,
	user_id uuid,
	user_name text,
	last_message text,
	last_message_at timestamptz,
	unread_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or not exists (
		select 1 from public.profiles
		where id = v_actor_id and role = 'super_admin' and approval_status = 'active'
	) then
		raise exception 'Only active Super Admins can view all conversations.';
	end if;

	insert into public.company_conversations(user_id)
	select p.id
	from public.profiles p
	where p.role = 'user' and p.approval_status = 'active'
	on conflict (user_id) do nothing;

	return query
	select c.id, c.user_id, coalesce(p.full_name, 'User'),
		latest.body, latest.created_at,
		count(m.id) filter (where m.read_at is null and m.sender_id <> v_actor_id)
	from public.company_conversations c
	join public.profiles p on p.id = c.user_id
	left join lateral (
		select cm.body, cm.created_at
		from public.company_messages cm
		where cm.conversation_id = c.id
		order by cm.created_at desc, cm.id desc
		limit 1
	) latest on true
	left join public.company_messages m on m.conversation_id = c.id
	group by c.id, c.user_id, p.full_name, latest.body, latest.created_at
	order by latest.created_at desc nulls last, c.created_at desc;
end;
$$;

revoke all on function public.list_company_conversations() from public, anon;
grant execute on function public.list_company_conversations() to authenticated;

commit;
