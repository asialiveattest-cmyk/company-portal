begin;

create table public.push_notifications (
	id uuid primary key default gen_random_uuid(),
	created_by uuid references public.profiles(id) on delete set null,
	title text not null check (length(btrim(title)) between 1 and 120),
	message text not null check (length(btrim(message)) between 1 and 2000),
	destination text,
	created_at timestamptz not null default now()
);

create table public.push_notification_recipients (
	id uuid primary key default gen_random_uuid(),
	notification_id uuid not null references public.push_notifications(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	read_at timestamptz,
	push_status text not null default 'pending'
		check (push_status in ('pending', 'sent', 'failed', 'no_subscription', 'not_configured')),
	created_at timestamptz not null default now(),
	unique (notification_id, user_id)
);

create table public.push_subscriptions (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	endpoint text not null unique,
	p256dh text not null,
	auth text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index push_notification_recipients_user_created_idx
	on public.push_notification_recipients(user_id, created_at desc);
create index push_subscriptions_user_idx
	on public.push_subscriptions(user_id);

alter table public.push_notifications enable row level security;
alter table public.push_notification_recipients enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all privileges on table public.push_notifications from public, anon, authenticated;
revoke all privileges on table public.push_notification_recipients from public, anon, authenticated;
revoke all privileges on table public.push_subscriptions from public, anon, authenticated;
grant select on table public.push_notifications, public.push_notification_recipients to authenticated;
grant update (read_at) on table public.push_notification_recipients to authenticated;
grant all privileges on table public.push_notifications, public.push_notification_recipients,
	public.push_subscriptions to service_role;

create policy "users read notifications sent to them"
	on public.push_notifications
	for select
	to authenticated
	using (
		exists (
			select 1
			from public.push_notification_recipients recipient
			join public.profiles profile on profile.id = recipient.user_id
			where recipient.notification_id = push_notifications.id
				and recipient.user_id = auth.uid()
				and profile.role = 'user'
				and profile.approval_status = 'active'
		)
	);

create policy "users read their notification recipients"
	on public.push_notification_recipients
	for select
	to authenticated
	using (
		user_id = auth.uid()
		and exists (
			select 1 from public.profiles
			where id = auth.uid() and role = 'user' and approval_status = 'active'
		)
	);

create policy "users mark their notifications read"
	on public.push_notification_recipients
	for update
	to authenticated
	using (
		user_id = auth.uid()
		and exists (
			select 1 from public.profiles
			where id = auth.uid() and role = 'user' and approval_status = 'active'
		)
	)
	with check (
		user_id = auth.uid()
		and exists (
			select 1 from public.profiles
			where id = auth.uid() and role = 'user' and approval_status = 'active'
		)
	);

do $$
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
		and not exists (
			select 1 from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'push_notification_recipients'
		) then
		alter publication supabase_realtime add table public.push_notification_recipients;
	end if;
end;
$$;

commit;
