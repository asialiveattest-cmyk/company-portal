begin;

update storage.buckets
set public = false
where id = 'account-documents';

alter table public.company_settings
	add column if not exists deposit_qr_updated_at timestamptz not null default now();

create table if not exists public.deposit_payment_proofs (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	storage_path text not null unique,
	status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
	created_at timestamptz not null default now(),
	reviewed_by uuid references public.profiles(id) on delete set null,
	reviewed_at timestamptz,
	constraint deposit_payment_proofs_path_check check (
		storage_path ~* ('^' || user_id::text || '/deposit-proofs/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$')
	),
	constraint deposit_payment_proofs_review_check check (
		(status = 'pending' and reviewed_at is null)
		or (status in ('verified', 'rejected') and reviewed_at is not null)
	)
);

create index if not exists deposit_payment_proofs_user_created_idx
	on public.deposit_payment_proofs(user_id, created_at desc);
create index if not exists deposit_payment_proofs_pending_created_idx
	on public.deposit_payment_proofs(created_at desc)
	where status = 'pending';

alter table public.deposit_payment_proofs enable row level security;
revoke all privileges on table public.deposit_payment_proofs from public, anon, authenticated;
grant select on table public.deposit_payment_proofs to authenticated;

drop policy if exists "users and staff read deposit payment proofs" on public.deposit_payment_proofs;
create policy "users and staff read deposit payment proofs"
	on public.deposit_payment_proofs
	for select
	to authenticated
	using (
		(user_id = auth.uid() and public.is_active_regular_user())
		or public.is_staff()
	);

create or replace function public.submit_deposit_payment_proof(p_storage_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proof_id uuid;
begin
	if v_user_id is null or not public.is_active_regular_user() then
		raise exception 'Only active regular users can submit deposit payment proof.';
	end if;
	if p_storage_path is null or p_storage_path !~* (
		'^' || v_user_id::text || '/deposit-proofs/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
	) then
		raise exception 'The payment screenshot path is invalid.';
	end if;
	if not exists (
		select 1
		from storage.objects
		where bucket_id = 'account-documents'
			and name = p_storage_path
	) then
		raise exception 'The payment screenshot was not uploaded.';
	end if;

	insert into public.deposit_payment_proofs(user_id, storage_path)
	values (v_user_id, p_storage_path)
	returning id into v_proof_id;
	return v_proof_id;
end;
$$;
revoke all on function public.submit_deposit_payment_proof(text) from public, anon;
grant execute on function public.submit_deposit_payment_proof(text) to authenticated;

create or replace function public.set_deposit_payment_proof_status(
	p_proof_id uuid,
	p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role text;
	v_owner_id uuid;
	v_owner_role text;
	v_status text;
begin
	select role::text into v_actor_role
	from public.profiles
	where id = v_actor_id and approval_status = 'active';
	if v_actor_role is null or v_actor_role not in ('employee', 'super_admin') then
		raise exception 'Only active staff can verify deposit payment proofs.';
	end if;
	if p_status is null or p_status not in ('verified', 'rejected') then
		raise exception 'Select a valid payment proof status.';
	end if;

	select user_id, status into v_owner_id, v_status
	from public.deposit_payment_proofs
	where id = p_proof_id
	for update;
	if not found then
		raise exception 'Deposit payment proof not found.';
	end if;

	select role::text into v_owner_role
	from public.profiles
	where id = v_owner_id;
	if v_actor_role = 'employee' and v_owner_role <> 'user' then
		raise exception 'Employees can verify regular users’ payment proofs only.';
	end if;
	if v_status <> 'pending' then
		raise exception 'Only pending payment proofs can be reviewed.';
	end if;

	update public.deposit_payment_proofs
	set status = p_status,
		reviewed_by = v_actor_id,
		reviewed_at = clock_timestamp()
	where id = p_proof_id;
end;
$$;
revoke all on function public.set_deposit_payment_proof_status(uuid, text) from public, anon;
grant execute on function public.set_deposit_payment_proof_status(uuid, text) to authenticated;

-- Existing private account-documents policies allow users to upload and read
-- files under their own user-id folder, and staff to read those files.
-- Payment proof paths use that same policy-protected folder structure.
do $$
begin
	if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
		and not exists (
			select 1
			from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = 'deposit_payment_proofs'
		) then
		alter publication supabase_realtime add table public.deposit_payment_proofs;
	end if;
end;
$$;

commit;
