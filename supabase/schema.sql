-- Company Portal schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create type public.app_role as enum ('user','employee','super_admin');
create type public.approval_state as enum ('pending','active','suspended','rejected');
create type public.account_state as enum ('waiting_for_approval','under_review','approved','rejected','running','suspended','completed');

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text,
 role public.app_role not null default 'user',
 approval_status public.approval_state not null default 'pending',
 created_at timestamptz not null default now()
);
create table public.user_employee_notes (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 note text not null default '',
 updated_by uuid references public.profiles(id) on delete set null,
 updated_at timestamptz not null default now()
);
-- Balances are separate from profiles so Employees cannot read other users'
-- balances through the broader staff profile policy.
create table public.user_balances (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 balance_usdt numeric(18,6) not null check (balance_usdt >= 0 and balance_usdt < 1000000000000),
 balance_inr numeric(18,2) not null check (balance_inr >= 0 and balance_inr < 10000000000000000),
 updated_at timestamptz not null default now()
);
create table public.account_submissions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 bank_name text, account_type text, ifsc_code text, customer_id text, user_id_text text,
 login_id text, account_number text, mobile_number text, mqr_path text,
 status public.account_state not null default 'waiting_for_approval',
 employee_notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.test_otp_assets (
 asset_type text primary key check(asset_type in ('apk','video')),
 storage_path text not null unique,
 file_name text not null,
 uploaded_by uuid not null references public.profiles(id),
 uploaded_at timestamptz not null default now(),
 constraint test_otp_assets_storage_path_check check (
  (asset_type='apk' and storage_path like 'test-otp/apk/%')
  or (asset_type='video' and storage_path like 'test-otp/video/%')
 )
);
create table public.test_otp_completions (
 user_id uuid not null references public.profiles(id) on delete cascade,
 account_submission_id uuid not null references public.account_submissions(id) on delete cascade,
 completed_at timestamptz not null default now(),
 primary key(user_id,account_submission_id)
);
create table public.payment_methods (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 method_type text not null check (method_type in ('bank_account', 'usdt_wallet')),
 account_holder_name text,
 bank_name text,
 account_number text,
 ifsc_code text,
 wallet_address text,
 network text,
 is_default boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint payment_methods_details_check check (
  (
   method_type = 'bank_account'
   and account_holder_name is not null
   and length(btrim(account_holder_name)) between 2 and 120
   and bank_name is not null
   and length(btrim(bank_name)) between 2 and 120
   and account_number is not null
   and account_number ~ '^[A-Za-z0-9/-]{4,34}$'
   and ifsc_code is not null
   and ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
   and wallet_address is null
   and network is null
  )
  or
  (
   method_type = 'usdt_wallet'
   and account_holder_name is null
   and bank_name is null
   and account_number is null
   and ifsc_code is null
   and wallet_address is not null
   and network is not null
   and network in ('TRC20', 'ERC20', 'BEP20')
   and (
    (network = 'TRC20' and wallet_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
    or (network in ('ERC20', 'BEP20') and wallet_address ~ '^0x[0-9A-Fa-f]{40}$')
   )
  )
 )
);
create unique index payment_methods_one_default_per_user on public.payment_methods(user_id) where is_default;
create table public.company_settings (
 id integer primary key default 1 check(id=1),
 company_volume_inr numeric(18,2) not null default 0 check(company_volume_inr>=0),
 running_account_count integer not null default 0 check(running_account_count>=0),
 volume_last_decreased_at timestamptz not null default now(),
 deposit_usdt_address text,
 deposit_qr_path text,
 deposit_qr_updated_at timestamptz not null default now(),
 contact_url text,
 updated_at timestamptz not null default now()
);
insert into public.company_settings(id) values(1) on conflict do nothing;

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
 body text not null check(length(btrim(body)) between 1 and 5000),
 created_at timestamptz not null default now(),
 read_at timestamptz
);
create index company_messages_conversation_created_idx on public.company_messages(conversation_id,created_at);
create index company_messages_unread_idx on public.company_messages(conversation_id,sender_id) where read_at is null;

-- Profile is created automatically. User metadata is never trusted for role assignment.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into public.profiles(id,full_name,role,approval_status)
 values(new.id, coalesce(new.raw_user_meta_data->>'full_name',''), 'user','pending');
 return new;
end; $$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role in ('employee','super_admin') and approval_status='active');
$$;
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approval_status='active');
$$;
create or replace function public.tick_company_volume()
returns void language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
 v_now timestamptz:=clock_timestamp();
begin
 if v_actor_id is null or not exists(
  select 1 from public.profiles where id=v_actor_id and approval_status='active'
 ) then raise exception 'Only active users can update the shared company volume.'; end if;
 update public.company_settings
 set company_volume_inr=greatest(0::numeric,company_volume_inr-(floor(random()*99001)+1000)::numeric),
  volume_last_decreased_at=v_now,updated_at=v_now
 where id=1 and company_volume_inr>0
  and volume_last_decreased_at<=v_now-interval '2 seconds';
end; $$;
revoke all on function public.tick_company_volume() from public,anon;
grant execute on function public.tick_company_volume() to authenticated;

-- Withdrawal requests reserve funds while pending/processing and snapshot the
-- selected payout method so later edits or deletion do not alter the request.
create table public.withdrawal_requests (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 currency text not null check (currency in ('INR','USDT')),
 amount numeric(24,6) not null check (amount > 0),
 payment_method_id uuid references public.payment_methods(id) on delete set null,
 payment_method_snapshot jsonb not null,
 status text not null default 'pending' check (status in ('pending','processing','paid','rejected')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint withdrawal_requests_currency_amount_check check (
  (currency='INR' and amount<10000000000000000 and amount=trunc(amount,2))
  or (currency='USDT' and amount<1000000000000 and amount=trunc(amount,6))
 )
);
create index withdrawal_requests_user_created_idx on public.withdrawal_requests(user_id,created_at desc);
create index withdrawal_requests_open_currency_idx on public.withdrawal_requests(user_id,currency)
 where status in ('pending','processing');
create table public.deposit_payment_proofs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 storage_path text not null unique,
 status text not null default 'pending' check(status in ('pending','verified','rejected')),
 created_at timestamptz not null default now(),
 reviewed_by uuid references public.profiles(id) on delete set null,
 reviewed_at timestamptz,
 constraint deposit_payment_proofs_path_check check (
  storage_path ~* ('^' || user_id::text || '/deposit-proofs/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$')
 ),
 constraint deposit_payment_proofs_review_check check (
  (status='pending' and reviewed_at is null)
  or (status in ('verified','rejected') and reviewed_at is not null)
 )
);
create index deposit_payment_proofs_user_created_idx on public.deposit_payment_proofs(user_id,created_at desc);
create index deposit_payment_proofs_pending_created_idx on public.deposit_payment_proofs(created_at desc)
 where status='pending';
alter table public.withdrawal_requests enable row level security;
revoke all privileges on table public.withdrawal_requests from public,anon,authenticated;
grant select on table public.withdrawal_requests to authenticated;
create policy "users and staff read withdrawal requests" on public.withdrawal_requests
 for select to authenticated
 using ((user_id=auth.uid() and public.is_active_user()) or public.is_staff());

create or replace function public.create_withdrawal_request(
 p_currency text,p_amount numeric,p_payment_method_id uuid
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_user_id uuid:=auth.uid();
 v_balance_usdt numeric(18,6);
 v_balance_inr numeric(18,2);
 v_balance numeric;
 v_reserved numeric;
 v_method public.payment_methods%rowtype;
 v_snapshot jsonb;
 v_request_id uuid;
begin
 if v_user_id is null or not exists(
  select 1 from public.profiles where id=v_user_id and role='user' and approval_status='active'
 ) then raise exception 'Only active regular users can submit withdrawal requests.'; end if;
 if p_currency is null or p_currency not in ('INR','USDT') or p_amount is null or p_amount<=0
  or (p_currency='INR' and (p_amount>=10000000000000000 or p_amount<>trunc(p_amount,2)))
  or (p_currency='USDT' and (p_amount>=1000000000000 or p_amount<>trunc(p_amount,6)))
 then raise exception 'Enter a positive amount with a valid currency precision.'; end if;

 select balance_usdt,balance_inr into v_balance_usdt,v_balance_inr
 from public.user_balances where user_id=v_user_id for update;
 if not found then raise exception 'No available balance is set for your account.'; end if;
 v_balance:=case when p_currency='INR' then v_balance_inr else v_balance_usdt end;

 select * into v_method from public.payment_methods
 where id=p_payment_method_id and user_id=v_user_id for key share;
 if not found or (p_currency='INR' and v_method.method_type<>'bank_account')
  or (p_currency='USDT' and v_method.method_type<>'usdt_wallet')
 then raise exception 'Select a saved payment method matching the withdrawal currency.'; end if;

 select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
 where user_id=v_user_id and currency=p_currency and status in ('pending','processing');
 if p_amount>v_balance-v_reserved then raise exception 'The withdrawal amount exceeds your available balance.'; end if;

 if p_currency='INR' then
  v_snapshot:=jsonb_build_object('method_type',v_method.method_type,
   'account_holder_name',v_method.account_holder_name,'bank_name',v_method.bank_name,
   'account_number',v_method.account_number,'ifsc_code',v_method.ifsc_code);
 else
  v_snapshot:=jsonb_build_object('method_type',v_method.method_type,
   'wallet_address',v_method.wallet_address,'network',v_method.network);
 end if;
 insert into public.withdrawal_requests(user_id,currency,amount,payment_method_id,payment_method_snapshot)
 values(v_user_id,p_currency,p_amount,v_method.id,v_snapshot) returning id into v_request_id;
 return v_request_id;
end; $$;
revoke all on function public.create_withdrawal_request(text,numeric,uuid) from public,anon;
grant execute on function public.create_withdrawal_request(text,numeric,uuid) to authenticated;

create or replace function public.set_withdrawal_request_status(p_request_id uuid,p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
 v_actor_role text;
 v_user_id uuid;
 v_target_role text;
 v_balance_usdt numeric(18,6);
 v_balance_inr numeric(18,2);
 v_balance numeric;
 v_reserved numeric;
 v_request public.withdrawal_requests%rowtype;
begin
 select role::text into v_actor_role from public.profiles
 where id=v_actor_id and approval_status='active';
 if v_actor_role is null or v_actor_role not in ('employee','super_admin')
 then raise exception 'Only active staff can manage withdrawal requests.'; end if;
 if p_status is null or p_status not in ('pending','processing','paid','rejected')
 then raise exception 'Select a valid withdrawal status.'; end if;
 select user_id into v_user_id from public.withdrawal_requests where id=p_request_id;
 if not found then raise exception 'Withdrawal request not found.'; end if;
 select role::text into v_target_role from public.profiles where id=v_user_id;
 if v_actor_role='employee' and v_target_role<>'user'
 then raise exception 'Employees can manage regular users’ withdrawal requests only.'; end if;

 select balance_usdt,balance_inr into v_balance_usdt,v_balance_inr
 from public.user_balances where user_id=v_user_id for update;
 if not found then raise exception 'The request owner has no balance record.'; end if;
 select * into v_request from public.withdrawal_requests where id=p_request_id for update;
 if not found or v_request.user_id<>v_user_id then raise exception 'Withdrawal request not found.'; end if;
 if v_request.status=p_status then return; end if;
 if v_request.status='paid' then raise exception 'A paid withdrawal request cannot be changed.'; end if;

 v_balance:=case when v_request.currency='INR' then v_balance_inr else v_balance_usdt end;
 if p_status in ('pending','processing','paid') then
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
  where user_id=v_user_id and currency=v_request.currency
   and status in ('pending','processing') and id<>p_request_id;
  if v_request.amount>v_balance-v_reserved
  then raise exception 'The request cannot be activated or paid because funds are no longer available.'; end if;
 end if;

 update public.withdrawal_requests set status=p_status,updated_at=now() where id=p_request_id;
 if p_status='paid' then
  if v_request.currency='INR' then
   update public.user_balances set balance_inr=balance_inr-v_request.amount,updated_at=now() where user_id=v_user_id;
  else
   update public.user_balances set balance_usdt=balance_usdt-v_request.amount,updated_at=now() where user_id=v_user_id;
  end if;
 end if;
end; $$;
revoke all on function public.set_withdrawal_request_status(uuid,text) from public,anon;
grant execute on function public.set_withdrawal_request_status(uuid,text) to authenticated;

create or replace function public.guard_withdrawal_reservations()
returns trigger language plpgsql security definer set search_path='' as $$
declare
 v_reserved_inr numeric;
 v_reserved_usdt numeric;
begin
 select coalesce(sum(amount) filter(where currency='INR'),0),
  coalesce(sum(amount) filter(where currency='USDT'),0)
 into v_reserved_inr,v_reserved_usdt from public.withdrawal_requests
 where user_id=new.user_id and status in ('pending','processing');
 if new.balance_inr<v_reserved_inr or new.balance_usdt<v_reserved_usdt
 then raise exception 'Balances cannot be reduced below amounts reserved by open withdrawal requests.'; end if;
 return new;
end; $$;
revoke all on function public.guard_withdrawal_reservations() from public,anon,authenticated;
drop trigger if exists guard_withdrawal_reservations_insert on public.user_balances;
drop trigger if exists guard_withdrawal_reservations_update on public.user_balances;
create trigger guard_withdrawal_reservations_insert
 before insert on public.user_balances
 for each row execute function public.guard_withdrawal_reservations();
create trigger guard_withdrawal_reservations_update
 before update of balance_inr,balance_usdt on public.user_balances
 for each row execute function public.guard_withdrawal_reservations();
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_employee_notes enable row level security;
alter table public.user_balances enable row level security;
alter table public.account_submissions enable row level security;
alter table public.test_otp_assets enable row level security;
alter table public.test_otp_completions enable row level security;
alter table public.payment_methods enable row level security;
alter table public.deposit_payment_proofs enable row level security;
alter table public.company_settings enable row level security;
alter table public.company_conversations enable row level security;
alter table public.company_messages enable row level security;

-- User-level employee notes are read and written only by the protected Edge Function.
revoke all privileges on table public.user_employee_notes from public, anon, authenticated;
revoke all privileges on table public.user_balances from public, anon, authenticated;
grant select on table public.user_balances to authenticated;
revoke all privileges on table public.deposit_payment_proofs from public, anon, authenticated;
grant select on table public.deposit_payment_proofs to authenticated;
revoke all privileges on table public.test_otp_assets, public.test_otp_completions from public, anon, authenticated;
grant select on table public.test_otp_assets, public.test_otp_completions to authenticated;
revoke all privileges on table public.company_conversations from public,anon,authenticated;
revoke all privileges on table public.company_messages from public,anon,authenticated;
grant select on table public.company_conversations,public.company_messages to authenticated;
revoke insert, update, delete on table public.company_settings from public, anon, authenticated;
revoke update (deposit_usdt_address, deposit_qr_path) on table public.company_settings from public, anon, authenticated;
grant select on table public.company_settings to authenticated;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role in ('employee','super_admin') and approval_status='active');
$$;
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approval_status='active');
$$;
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='super_admin' and approval_status='active');
$$;
grant execute on function public.is_super_admin() to authenticated;
create or replace function public.is_active_regular_user()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='user' and approval_status='active');
$$;
revoke all on function public.is_active_regular_user() from public, anon;
grant execute on function public.is_active_regular_user() to authenticated;

create or replace function public.set_test_otp_asset(p_asset_type text,p_storage_path text,p_file_name text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
begin
 if v_actor_id is null or not public.is_super_admin()
 then raise exception 'Only an active Super Admin can manage Test OTP files.'; end if;
 if p_asset_type is null or p_asset_type not in ('apk','video') or p_storage_path is null
  or (p_asset_type='apk' and p_storage_path !~ '^test-otp/apk/[A-Za-z0-9._-]+$')
  or (p_asset_type='video' and p_storage_path !~ '^test-otp/video/[A-Za-z0-9._-]+$')
  or p_file_name is null or length(btrim(p_file_name)) not between 1 and 255
 then raise exception 'The Test OTP file details are invalid.'; end if;
 if not exists(
  select 1 from storage.objects where bucket_id='account-documents' and name=p_storage_path
 ) then raise exception 'The Test OTP file was not uploaded.'; end if;
 insert into public.test_otp_assets(asset_type,storage_path,file_name,uploaded_by,uploaded_at)
 values(p_asset_type,p_storage_path,p_file_name,v_actor_id,clock_timestamp())
 on conflict(asset_type) do update set storage_path=excluded.storage_path,file_name=excluded.file_name,
  uploaded_by=excluded.uploaded_by,uploaded_at=excluded.uploaded_at;
end; $$;
revoke all on function public.set_test_otp_asset(text,text,text) from public,anon;
grant execute on function public.set_test_otp_asset(text,text,text) to authenticated;

create or replace function public.complete_test_otp_installation(p_account_submission_id uuid)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare
 v_user_id uuid:=auth.uid();
 v_completed_at timestamptz:=clock_timestamp();
begin
 if v_user_id is null or not public.is_active_regular_user()
 then raise exception 'Only active regular users can record Test OTP installation.'; end if;
 if p_account_submission_id is null or not exists(
  select 1 from public.account_submissions where id=p_account_submission_id and user_id=v_user_id
 ) then raise exception 'Select one of your submitted accounts.'; end if;
 insert into public.test_otp_completions(user_id,account_submission_id,completed_at)
 values(v_user_id,p_account_submission_id,v_completed_at)
 on conflict(user_id,account_submission_id) do update set completed_at=excluded.completed_at;
 return v_completed_at;
end; $$;
revoke all on function public.complete_test_otp_installation(uuid) from public,anon;
grant execute on function public.complete_test_otp_installation(uuid) to authenticated;

create or replace function public.submit_deposit_payment_proof(p_storage_path text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_user_id uuid:=auth.uid();
 v_proof_id uuid;
begin
 if v_user_id is null or not public.is_active_regular_user()
 then raise exception 'Only active regular users can submit deposit payment proof.'; end if;
 if p_storage_path is null or p_storage_path !~* (
  '^' || v_user_id::text || '/deposit-proofs/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
 ) then raise exception 'The payment screenshot path is invalid.'; end if;
 if not exists(
  select 1 from storage.objects
  where bucket_id='account-documents' and name=p_storage_path
 ) then raise exception 'The payment screenshot was not uploaded.'; end if;
 insert into public.deposit_payment_proofs(user_id,storage_path)
 values(v_user_id,p_storage_path) returning id into v_proof_id;
 return v_proof_id;
end; $$;
revoke all on function public.submit_deposit_payment_proof(text) from public,anon;
grant execute on function public.submit_deposit_payment_proof(text) to authenticated;

create or replace function public.set_deposit_payment_proof_status(p_proof_id uuid,p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
 v_actor_role text;
 v_owner_id uuid;
 v_owner_role text;
 v_status text;
begin
 select role::text into v_actor_role from public.profiles
 where id=v_actor_id and approval_status='active';
 if v_actor_role is null or v_actor_role not in ('employee','super_admin')
 then raise exception 'Only active staff can verify deposit payment proofs.'; end if;
 if p_status is null or p_status not in ('verified','rejected')
 then raise exception 'Select a valid payment proof status.'; end if;
 select user_id,status into v_owner_id,v_status from public.deposit_payment_proofs
 where id=p_proof_id for update;
 if not found then raise exception 'Deposit payment proof not found.'; end if;
 select role::text into v_owner_role from public.profiles where id=v_owner_id;
 if v_actor_role='employee' and v_owner_role<>'user'
 then raise exception 'Employees can verify regular users’ payment proofs only.'; end if;
 if v_status<>'pending' then raise exception 'Only pending payment proofs can be reviewed.'; end if;
 update public.deposit_payment_proofs
 set status=p_status,reviewed_by=v_actor_id,reviewed_at=clock_timestamp()
 where id=p_proof_id;
end; $$;
revoke all on function public.set_deposit_payment_proof_status(uuid,text) from public,anon;
grant execute on function public.set_deposit_payment_proof_status(uuid,text) to authenticated;

create or replace function public.get_or_create_company_conversation()
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_user_id uuid:=auth.uid();
 v_conversation_id uuid;
begin
 if v_user_id is null or not exists(
  select 1 from public.profiles where id=v_user_id and role='user' and approval_status='active'
 ) then raise exception 'Only active regular users can access their company inbox.'; end if;
 insert into public.company_conversations(user_id) values(v_user_id) on conflict(user_id) do nothing;
 select id into v_conversation_id from public.company_conversations where user_id=v_user_id;
 return v_conversation_id;
end; $$;

create or replace function public.send_company_message(p_conversation_id uuid,p_body text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
 v_actor_role text;
 v_message_id uuid;
 v_body text:=btrim(p_body);
begin
 if v_actor_id is null then raise exception 'Authentication is required to send a message.'; end if;
 if v_body is null or length(v_body) not between 1 and 5000
 then raise exception 'Messages must contain between 1 and 5000 characters.'; end if;
 select role::text into v_actor_role from public.profiles
 where id=v_actor_id and approval_status='active';
 if v_actor_role is null or v_actor_role not in ('user','super_admin')
 then raise exception 'Only active users and Super Admins can send messages.'; end if;
 if v_actor_role='user' and not exists(
  select 1 from public.company_conversations where id=p_conversation_id and user_id=v_actor_id
 ) then raise exception 'You can only send messages in your own conversation.'; end if;
 if v_actor_role='super_admin' and not exists(
  select 1 from public.company_conversations where id=p_conversation_id
 ) then raise exception 'Conversation not found.'; end if;
 insert into public.company_messages(conversation_id,sender_id,body)
 values(p_conversation_id,v_actor_id,v_body) returning id into v_message_id;
 update public.company_conversations set updated_at=clock_timestamp() where id=p_conversation_id;
 return v_message_id;
end; $$;

create or replace function public.mark_company_messages_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
 v_actor_role text;
begin
 if v_actor_id is null then raise exception 'Authentication is required to read messages.'; end if;
 select role::text into v_actor_role from public.profiles
 where id=v_actor_id and approval_status='active';
 if v_actor_role='user' then
  if not exists(select 1 from public.company_conversations where id=p_conversation_id and user_id=v_actor_id)
  then raise exception 'You can only read your own conversation.'; end if;
 elsif v_actor_role='super_admin' then
  if not exists(select 1 from public.company_conversations where id=p_conversation_id)
  then raise exception 'Conversation not found.'; end if;
 else raise exception 'Only active users and Super Admins can read messages.'; end if;
 update public.company_messages set read_at=clock_timestamp()
 where conversation_id=p_conversation_id and sender_id<>v_actor_id and read_at is null;
end; $$;

create or replace function public.list_company_conversations()
returns table(conversation_id uuid,user_id uuid,user_name text,last_message text,last_message_at timestamptz,unread_count bigint)
language plpgsql stable security definer set search_path='' as $$
declare
 v_actor_id uuid:=auth.uid();
begin
 if v_actor_id is null or not exists(
  select 1 from public.profiles where id=v_actor_id and role='super_admin' and approval_status='active'
 ) then raise exception 'Only active Super Admins can view all conversations.'; end if;
 return query
 select c.id,c.user_id,coalesce(p.full_name,'User'),latest.body,latest.created_at,
  count(m.id) filter(where m.read_at is null and m.sender_id<>v_actor_id)
 from public.company_conversations c
 join public.profiles p on p.id=c.user_id
 left join lateral(
  select cm.body,cm.created_at from public.company_messages cm
  where cm.conversation_id=c.id order by cm.created_at desc,cm.id desc limit 1
 ) latest on true
 left join public.company_messages m on m.conversation_id=c.id
 group by c.id,c.user_id,p.full_name,latest.body,latest.created_at
 order by latest.created_at desc nulls last,c.created_at desc;
end; $$;

revoke all on function public.get_or_create_company_conversation() from public,anon;
revoke all on function public.send_company_message(uuid,text) from public,anon;
revoke all on function public.mark_company_messages_read(uuid) from public,anon;
revoke all on function public.list_company_conversations() from public,anon;
grant execute on function public.get_or_create_company_conversation() to authenticated;
grant execute on function public.send_company_message(uuid,text) to authenticated;
grant execute on function public.mark_company_messages_read(uuid) to authenticated;
grant execute on function public.list_company_conversations() to authenticated;

create policy "read own profile or staff" on public.profiles for select to authenticated
using (id=auth.uid() or public.is_staff());
revoke all privileges on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
-- Profile role and approval changes are performed only by the protected user-management Edge Function.
create policy "active users read own submissions" on public.account_submissions for select to authenticated
using ((user_id=auth.uid() and public.is_active_user()) or public.is_staff());
create policy "active users create own submissions" on public.account_submissions for insert to authenticated
with check (user_id=auth.uid() and public.is_active_user());
revoke all privileges on table public.payment_methods from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_methods to authenticated;
create policy "users and active staff view payment methods" on public.payment_methods for select to authenticated
using ((user_id=auth.uid() and public.is_active_user()) or public.is_staff());
create policy "active users create own payment methods" on public.payment_methods for insert to authenticated
with check (user_id=auth.uid() and public.is_active_regular_user());
create policy "active users update own payment methods" on public.payment_methods for update to authenticated
using (user_id=auth.uid() and public.is_active_regular_user())
with check (user_id=auth.uid() and public.is_active_regular_user());
create policy "active users delete own payment methods" on public.payment_methods for delete to authenticated
using (user_id=auth.uid() and public.is_active_regular_user());
create or replace function public.set_default_payment_method(method_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
begin
 if auth.uid() is null or not public.is_active_regular_user() then
  raise exception 'Only active regular users can set a default payment method.';
 end if;
 update public.payment_methods set is_default=false,updated_at=now()
 where user_id=auth.uid() and is_default;
 update public.payment_methods set is_default=true,updated_at=now()
 where id=method_id and user_id=auth.uid();
 if not found then raise exception 'Payment method not found.'; end if;
end; $$;
revoke all on function public.set_default_payment_method(uuid) from public, anon;
grant execute on function public.set_default_payment_method(uuid) to authenticated;
-- Only active employees and super admins can update submissions; ordinary users
-- have no update policy and therefore cannot change their own submission status.
create policy "staff update submissions" on public.account_submissions for update to authenticated
using (public.is_staff()) with check (public.is_staff());
create policy "active users read company settings" on public.company_settings for select to authenticated
using (public.is_active_user());
create policy "active users read current test otp assets" on public.test_otp_assets
for select to authenticated using (public.is_active_user());
create policy "users and super admins read test otp completions" on public.test_otp_completions
for select to authenticated using (
 (user_id=auth.uid() and public.is_active_regular_user()) or public.is_super_admin()
);
create policy "users read own balances" on public.user_balances for select to authenticated
using (user_id=auth.uid());
create policy "users and staff read deposit payment proofs" on public.deposit_payment_proofs
for select to authenticated using (
 (user_id=auth.uid() and public.is_active_regular_user()) or public.is_staff()
);
create policy "conversation participants read conversations" on public.company_conversations
for select to authenticated using (
 (user_id=auth.uid() and public.is_active_regular_user()) or public.is_super_admin()
);
create policy "conversation participants read messages" on public.company_messages
for select to authenticated using (
 exists(select 1 from public.company_conversations c
  where c.id=company_messages.conversation_id and c.user_id=auth.uid() and public.is_active_regular_user())
 or public.is_super_admin()
);

-- Storage bucket: private documents. Set up bucket manually as private, then add policies.
insert into storage.buckets(id,name,public) values('account-documents','account-documents',false)
on conflict(id) do update set public=false;
create policy "users upload own account docs" on storage.objects for insert to authenticated
with check (bucket_id='account-documents' and (storage.foldername(name))[1]=auth.uid()::text and public.is_active_user());
create policy "users read own account docs or staff" on storage.objects for select to authenticated
using (bucket_id='account-documents' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_staff()));
create policy "super admins upload shared deposit qr" on storage.objects for insert to authenticated
with check (bucket_id='account-documents' and name='company/deposit-qr.png' and public.is_super_admin());
create policy "super admins replace shared deposit qr" on storage.objects for update to authenticated
using (bucket_id='account-documents' and name='company/deposit-qr.png' and public.is_super_admin())
with check (bucket_id='account-documents' and name='company/deposit-qr.png' and public.is_super_admin());
create policy "active users read current shared deposit qr" on storage.objects for select to authenticated
using (bucket_id='account-documents' and name='company/deposit-qr.png' and public.is_active_user()
 and exists(select 1 from public.company_settings where id=1 and deposit_qr_path=storage.objects.name));
create policy "super admins upload test otp assets" on storage.objects for insert to authenticated
with check (bucket_id='account-documents' and (name like 'test-otp/apk/%' or name like 'test-otp/video/%')
 and public.is_super_admin());
create policy "active users download current test otp assets" on storage.objects for select to authenticated
using (bucket_id='account-documents' and public.is_active_user()
 and exists(select 1 from public.test_otp_assets where storage_path=storage.objects.name));

do $$
begin
 if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='company_settings') then
   alter publication supabase_realtime add table public.company_settings;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_balances') then
   alter publication supabase_realtime add table public.user_balances;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='deposit_payment_proofs') then
   alter publication supabase_realtime add table public.deposit_payment_proofs;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='test_otp_assets') then
   alter publication supabase_realtime add table public.test_otp_assets;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='test_otp_completions') then
   alter publication supabase_realtime add table public.test_otp_completions;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='company_conversations') then
   alter publication supabase_realtime add table public.company_conversations;
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='company_messages') then
   alter publication supabase_realtime add table public.company_messages;
  end if;
 end if;
end; $$;
