begin;

create table public.company_conversations (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null unique references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table public.company_messages (
	id uuid primary key default gen_random_uuid(),
	conversation_id uuid not null references public.company_conversations(id) on delete cascade,
	sender_id uuid not null references public.profiles(id) on delete cascade,
	body text not null check (length(btrim(body)) between 1 and 5000),
	created_at timestamptz not null default now(),
	read_at timestamptz
);

create index company_messages_conversation_created_idx
	on public.company_messages(conversation_id, created_at);
create index company_messages_unread_idx
	on public.company_messages(conversation_id, sender_id)
	where read_at is null;

alter table public.company_conversations enable row level security;
alter table public.company_messages enable row level security;
revoke all privileges on table public.company_conversations from public, anon, authenticated;
revoke all privileges on table public.company_messages from public, anon, authenticated;
grant select on table public.company_conversations, public.company_messages to authenticated;

create policy "conversation participants read conversations"
	on public.company_conversations
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_regular_user())
		or public.is_super_admin()
	);

create policy "conversation participants read messages"
	on public.company_messages
	for select
	to authenticated
	using (
		exists (
			select 1
			from public.company_conversations c
			where c.id = company_messages.conversation_id
				and c.user_id = auth.uid()
				and public.is_active_regular_user()
		)
		or public.is_super_admin()
	);

create or replace function public.get_or_create_company_conversation()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_conversation_id uuid;
begin
	if v_user_id is null or not exists (
		select 1 from public.profiles
		where id = v_user_id and role = 'user' and approval_status = 'active'
	) then
		raise exception 'Only active regular users can access their company inbox.';
	end if;

	insert into public.company_conversations(user_id)
	values (v_user_id)
	on conflict (user_id) do nothing;

	select id into v_conversation_id
	from public.company_conversations
	where user_id = v_user_id;

	return v_conversation_id;
end;
$$;

create or replace function public.send_company_message(p_conversation_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role text;
	v_message_id uuid;
	v_body text := btrim(p_body);
begin
	if v_actor_id is null then
		raise exception 'Authentication is required to send a message.';
	end if;
	if v_body is null or length(v_body) not between 1 and 5000 then
		raise exception 'Messages must contain between 1 and 5000 characters.';
	end if;

	select role::text into v_actor_role
	from public.profiles
	where id = v_actor_id and approval_status = 'active';
	if v_actor_role is null or v_actor_role not in ('user', 'super_admin') then
		raise exception 'Only active users and Super Admins can send messages.';
	end if;
	if v_actor_role = 'user' and not exists (
		select 1 from public.company_conversations
		where id = p_conversation_id and user_id = v_actor_id
	) then
		raise exception 'You can only send messages in your own conversation.';
	end if;
	if v_actor_role = 'super_admin' and not exists (
		select 1 from public.company_conversations
		where id = p_conversation_id
	) then
		raise exception 'Conversation not found.';
	end if;

	insert into public.company_messages(conversation_id, sender_id, body)
	values (p_conversation_id, v_actor_id, v_body)
	returning id into v_message_id;

	update public.company_conversations
	set updated_at = clock_timestamp()
	where id = p_conversation_id;

	return v_message_id;
end;
$$;

create or replace function public.mark_company_messages_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role text;
begin
	if v_actor_id is null then
		raise exception 'Authentication is required to read messages.';
	end if;
	select role::text into v_actor_role
	from public.profiles
	where id = v_actor_id and approval_status = 'active';
	if v_actor_role = 'user' then
		if not exists (
			select 1 from public.company_conversations
			where id = p_conversation_id and user_id = v_actor_id
		) then
			raise exception 'You can only read your own conversation.';
		end if;
	elsif v_actor_role = 'super_admin' then
		if not exists (
			select 1 from public.company_conversations
			where id = p_conversation_id
		) then
			raise exception 'Conversation not found.';
		end if;
	else
		raise exception 'Only active users and Super Admins can read messages.';
	end if;

	update public.company_messages
	set read_at = clock_timestamp()
	where conversation_id = p_conversation_id
		and sender_id <> v_actor_id
		and read_at is null;
end;
$$;

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
stable
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or not exists (
		select 1 from public.profiles
		where id = v_actor_id and role = 'super_admin' and approval_status = 'active'
	) then
		raise exception 'Only active Super Admins can view all conversations.';
	end if;

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

revoke all on function public.get_or_create_company_conversation() from public, anon;
revoke all on function public.send_company_message(uuid, text) from public, anon;
revoke all on function public.mark_company_messages_read(uuid) from public, anon;
revoke all on function public.list_company_conversations() from public, anon;
grant execute on function public.get_or_create_company_conversation() to authenticated;
grant execute on function public.send_company_message(uuid, text) to authenticated;
grant execute on function public.mark_company_messages_read(uuid) to authenticated;
grant execute on function public.list_company_conversations() to authenticated;

do $$
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'company_conversations'
		) then
			alter publication supabase_realtime add table public.company_conversations;
		end if;
		if not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'company_messages'
		) then
			alter publication supabase_realtime add table public.company_messages;
		end if;
	end if;
end;
$$;

commit;
