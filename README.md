# Company Portal starter

## Included
- React + Vite mobile-responsive portal
- Email/password registration and login
- New registrations automatically become `pending`
- Pending/suspended/rejected users are blocked from the dashboard
- User overview and account submission
- Private MQR upload bucket
- Supabase SQL schema with baseline RLS policies
- Searchable staff user management with approval and access controls
- Edge Function-based account creation, private employee notes, and protected profile status updates
- Shared Super Admin-managed USDT TRC20 deposit details and QR code
- Private payment-proof uploads with pending employee/Super Admin verification
- Owner-only USDT/INR balances with Super Admin-only manual updates
- Owner-managed INR bank accounts and USDT wallets, with read-only staff access
- Balance-reserved withdrawal requests with atomic staff payout processing
- Private one-to-one user/Super Admin messaging with unread indicators and realtime updates
- Private Super Admin-managed Test OTP APK/video delivery and per-account installation completion records

## Configure
1. Create `.env` from `.env.example` and fill in the Supabase project URL and publishable key.
2. In Supabase SQL Editor, run `supabase/schema.sql`.
3. In Supabase Authentication settings, configure email confirmation and redirect URLs for your eventual Vercel URL.
4. Create the first super-admin securely: register your own account, then use the Supabase SQL editor to set that profile's `role='super_admin'` and `approval_status='active'`. Never expose service-role keys in frontend code.
5. `npm install` then `npm run dev`.

## Deploy user management
For an existing Supabase project, apply the SQL migrations in `supabase/migrations/` in filename order. `20261110_user_management_security.sql` removes broad authenticated profile-update policies and creates a private table for employee notes; `20261110154000_account_submission_status_management.sql` adds the suspended submission status and restricts submission updates to active staff; `20261110160000_deposits_and_user_balances.sql` adds private per-user balances and Super Admin-only deposit QR policies. Profile roles, balances and deposit settings are changed only by the protected Edge Function. For a new project, run the updated `supabase/schema.sql` instead.

After applying migrations, deploy the updated function from a linked Supabase CLI project with `supabase functions deploy user-management`. The function uses the Supabase-provided `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` Edge Function secrets. If configuring secrets manually, add them only to the Edge Function environment, never to `.env`, `VITE_` variables, or browser code.

The Payment Methods module uses the separate `20261110161500_payment_methods.sql` migration (apply it after the earlier migrations) or the updated `supabase/schema.sql` for a new project. It enforces owner-only create/edit/delete and read-only access for active staff using RLS; it does not require an Edge Function deployment.

The Withdrawal Requests module uses `20261110163000_withdrawal_requests.sql` (apply after the payment-method migration), or the updated `supabase/schema.sql` for a new project. It adds owner/staff read-only RLS, atomic request and status RPCs, payment-method snapshots, and balance reservation safeguards. Apply the migration in the Supabase SQL Editor; the existing `user-management` Edge Function does not need redeployment.

The Company Settings dashboard uses `20261110164000_company_dashboard_settings.sql` after the withdrawal migration, or the updated `supabase/schema.sql` for a new project. Apply the migration in the Supabase SQL Editor to add non-negative setting constraints and the shared two-second volume tick. Then deploy the updated Edge Function with `supabase functions deploy user-management`; only an active Super Admin can save the volume starting value or running-account count.

The private Messages / Inbox uses `20261110170000_private_messaging_inbox.sql` after the company settings migration, or the updated `supabase/schema.sql` for a new project. Run the migration in the Supabase SQL Editor. It creates private one-to-one conversations, message RLS, sender-verified database functions, unread tracking, and Realtime publication membership. No Edge Function deployment is needed.

Deposit payment proofs use `20261111100000_deposit_payment_proofs.sql` after the earlier migrations, or the updated `supabase/schema.sql` for a new project. It keeps the existing `account-documents` bucket private, stores screenshots under each user's own folder, and records submissions as pending. Staff verification changes only the proof status; it does not change balances. The deposit QR is served through the authenticated Storage download API, with access limited by the existing Storage RLS policy to the QR path saved in `company_settings`. A dedicated QR revision timestamp refreshes the image after replacement without exposing the private bucket.

The Test OTP module uses `20261111110000_test_otp_module.sql` after the deposit payment-proof migration, or the updated `supabase/schema.sql` for a new project. It stores versioned APK/video metadata and per-user/account installation completions in Supabase. Test APKs and instruction videos are uploaded to the existing private `account-documents` bucket with resumable uploads and authenticated signed downloads. Only an active Super Admin can upload or replace assets; employee and user access is read-only. The module records installation completion only and must not collect or forward real SMS OTPs; use a test app with safe test-code verification.

Live Running Accounts uses `20261112001000_live_running_accounts.sql` after the existing migrations. Apply it to existing projects and after `supabase/schema.sql` for new projects. The migration creates owner-scoped account and commission tables, protects management and review actions with RLS and a Super Admin-only RPC, and schedules shared volume updates with Supabase `pg_cron` (which requires a Supabase Postgres version that supports sub-minute schedules). Calculated commissions remain separate from withdrawable balances.

Active employees can create regular user accounts with an initial password; the password is sent only to the authenticated Edge Function and is never returned in user lists or stored in the profiles table. Share initial passwords with users through a secure channel. Regular users remain pending until approved. Only an active super admin can create employee accounts; employee accounts are activated on creation. All employee notes are stored separately and are available only through the protected Edge Function.

The first super admin must still be bootstrapped securely: register an account, then set its profile's `role='super_admin'` and `approval_status='active'` in the Supabase SQL Editor. Never expose service-role keys in frontend code.

## Security
This starter intentionally does not collect bank login passwords, transaction passwords, PINs, OTPs, or security answers. Never collect these credentials. Account submissions are restricted to non-secret account metadata. USDT and INR balances are manual values set by a Super Admin through the protected Edge Function, not a transaction or audit-history system; enter only verified balances and do not treat them as transaction records.
