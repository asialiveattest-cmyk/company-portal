-- Keep the bank-provided User ID separate from account_submissions.user_id,
-- which is the authenticated portal user's UUID foreign key.
alter table public.account_submissions
	add column if not exists user_id_text text;
