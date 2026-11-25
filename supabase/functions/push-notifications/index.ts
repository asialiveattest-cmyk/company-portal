import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type PushPayload = {
  action?: string;
  title?: string;
  message?: string;
  recipientMode?: 'all' | 'selected';
  recipientIds?: string[];
  destination?: string;
  subscription?: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
};

type ProfileRow = { id: string; full_name: string | null };
type SubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const userDestinations = new Set([
  'Overview',
  'Submit Account',
  'Submitted Accounts',
  'Running Accounts',
  'Payment Methods',
  'Deposits',
  'Withdrawals',
  'TEST OTP',
  'Inbox',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{16,200}$/;

function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost =
      host === 'fcm.googleapis.com' ||
      host === 'web.push.apple.com' ||
      host === 'push.services.mozilla.com' ||
      host.endsWith('.push.services.mozilla.com') ||
      host.endsWith('.notify.windows.com');
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') && allowedHost;
  } catch {
    return false;
  }
}

async function loadActiveUsers(admin: SupabaseClient): Promise<ProfileRow[]> {
  const users: ProfileRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('profiles')
      .select('id,full_name')
      .eq('role', 'user')
      .eq('approval_status', 'active')
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error('Could not load active users.');
    users.push(...(data || []));
    if (!data || data.length < 1000) return users;
  }
}

async function loadSubscriptions(admin: SupabaseClient, userIds: string[]): Promise<SubscriptionRow[]> {
  const subscriptions: SubscriptionRow[] = [];
  for (let start = 0; start < userIds.length; start += 100) {
    const ids = userIds.slice(start, start + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('push_subscriptions')
        .select('id,user_id,endpoint,p256dh,auth')
        .in('user_id', ids)
        .range(from, from + 999);
      if (error) throw new Error('Could not load push subscriptions.');
      subscriptions.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  }
  return subscriptions;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'Push notifications are not configured.' }, 500);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Authentication is required.' }, 401);

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Your session is invalid or expired.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: actor, error: actorError } = await admin.from('profiles')
    .select('id,role,approval_status')
    .eq('id', caller.id)
    .maybeSingle();
  if (actorError || !actor || actor.approval_status !== 'active' ||
    (actor.role !== 'super_admin' && actor.role !== 'user')) {
    return json({ error: 'An active portal account is required.' }, 403);
  }

  let payload: PushPayload;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Invalid request body.' }, 400);
    }
    payload = body as PushPayload;
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const superAdminOnlyActions = ['list_users', 'send'];
  if (superAdminOnlyActions.includes(payload.action || '') &&
    actor.role !== 'super_admin') {
    return json({ error: 'Only active Super Admins can manage push notifications.' }, 403);
  }
  const regularUserOnlyActions = ['vapid_public_key', 'save_subscription', 'remove_subscription'];
  if (regularUserOnlyActions.includes(payload.action || '') && actor.role !== 'user') {
    return json({ error: 'Only active regular users can manage browser notifications.' }, 403);
  }

  if (payload.action === 'list_users') {
    try {
      return json({ users: await loadActiveUsers(admin) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not load active users.' }, 500);
    }
  }

  if (payload.action === 'vapid_public_key') {
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    if (!publicKey || !Deno.env.get('VAPID_PRIVATE_KEY') || !Deno.env.get('VAPID_SUBJECT')) {
      return json({ error: 'Browser push is not configured.' }, 500);
    }
    return json({ publicKey });
  }

  if (payload.action === 'save_subscription') {
    const endpoint = payload.subscription?.endpoint;
    const p256dh = payload.subscription?.keys?.p256dh;
    const auth = payload.subscription?.keys?.auth;
    if (!isAllowedPushEndpoint(endpoint) || typeof p256dh !== 'string' ||
      !keyPattern.test(p256dh) || typeof auth !== 'string' || !keyPattern.test(auth)) {
      return json({ error: 'The browser push subscription is invalid.' }, 400);
    }
    const { data: existing, error: existingError } = await admin.from('push_subscriptions')
      .select('user_id')
      .eq('endpoint', endpoint)
      .maybeSingle();
    if (existingError) return json({ error: 'Could not verify this browser subscription.' }, 500);
    if (existing && existing.user_id !== caller.id) {
      return json({ error: 'This browser subscription is already linked to another account.' }, 409);
    }
    const subscriptionDetails = { p256dh, auth, updated_at: new Date().toISOString() };
    const { error } = existing
      ? await admin.from('push_subscriptions')
        .update(subscriptionDetails)
        .eq('user_id', caller.id)
        .eq('endpoint', endpoint)
      : await admin.from('push_subscriptions').insert({
        user_id: caller.id,
        endpoint,
        ...subscriptionDetails,
      });
    if (error) return json({ error: 'Could not save this browser subscription.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'remove_subscription') {
    const endpoint = payload.subscription?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 4096) {
      return json({ error: 'The browser push subscription is invalid.' }, 400);
    }
    const { error } = await admin.from('push_subscriptions')
      .delete()
      .eq('user_id', caller.id)
      .eq('endpoint', endpoint);
    if (error) return json({ error: 'Could not remove this browser subscription.' }, 500);
    return json({ success: true });
  }

  if (payload.action === 'send') {
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (title.length < 1 || title.length > 120 || message.length < 1 || message.length > 2000) {
      return json({ error: 'Enter a title of 1–120 characters and a message of 1–2,000 characters.' }, 400);
    }
    if (payload.recipientMode !== 'all' && payload.recipientMode !== 'selected') {
      return json({ error: 'Choose all active users or selected users.' }, 400);
    }
    if (payload.destination && !userDestinations.has(payload.destination)) {
      return json({ error: 'Choose a valid portal destination.' }, 400);
    }

    let recipients: ProfileRow[];
    if (payload.recipientMode === 'all') {
      try {
        recipients = await loadActiveUsers(admin);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Could not load recipients.' }, 500);
      }
    } else {
      const requestedIds = payload.recipientIds;
      if (!Array.isArray(requestedIds) || requestedIds.length === 0 ||
        requestedIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
        return json({ error: 'Select at least one valid user.' }, 400);
      }
      const uniqueIds = [...new Set(requestedIds)];
      if (uniqueIds.length !== requestedIds.length) return json({ error: 'Recipient selections must be unique.' }, 400);
      recipients = [];
      for (let start = 0; start < uniqueIds.length; start += 500) {
        const ids = uniqueIds.slice(start, start + 500);
        const { data, error } = await admin.from('profiles')
          .select('id,full_name')
          .eq('role', 'user')
          .eq('approval_status', 'active')
          .in('id', ids);
        if (error) return json({ error: 'Could not verify selected recipients.' }, 500);
        recipients.push(...(data || []));
      }
      if (recipients.length !== uniqueIds.length) {
        return json({ error: 'One or more selected users are no longer active. Refresh the list and try again.' }, 409);
      }
    }
    if (recipients.length === 0) return json({ error: 'There are no active users to notify.' }, 400);

    const destination = payload.destination
      ? `/?page=${encodeURIComponent(payload.destination)}`
      : null;
    const { data: notification, error: notificationError } = await admin.from('push_notifications')
      .insert({ created_by: caller.id, title, message, destination })
      .select('id')
      .single();
    if (notificationError || !notification) {
      return json({ error: 'Could not save the notification.' }, 500);
    }

    let recipientInsertFailed = false;
    for (let start = 0; start < recipients.length; start += 500) {
      const rows = recipients.slice(start, start + 500).map((recipient) => ({
        notification_id: notification.id,
        user_id: recipient.id,
        push_status: 'pending',
      }));
      const { error } = await admin.from('push_notification_recipients').insert(rows);
      if (error) {
        recipientInsertFailed = true;
        break;
      }
    }
    if (recipientInsertFailed) {
      const { error: rollbackError } = await admin.from('push_notifications')
        .delete()
        .eq('id', notification.id);
      return json({
        error: rollbackError
          ? 'Recipient records could not be saved, and the notification record could not be rolled back.'
          : 'Recipient records could not be saved. No notification was sent.',
      }, 500);
    }

    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const subject = Deno.env.get('VAPID_SUBJECT');
    if (!publicKey || !privateKey || !subject) {
      const { error } = await admin.from('push_notification_recipients')
        .update({ push_status: 'not_configured' })
        .eq('notification_id', notification.id);
      if (error) return json({ error: 'The notification was saved, but push configuration status could not be recorded.' }, 500);
      return json({
        success: true,
        notificationId: notification.id,
        targetedUserCount: recipients.length,
        pushDeliveredUserCount: 0,
        pushFailedUserCount: 0,
        browserPushConfigured: false,
      });
    }

    let subscriptions: SubscriptionRow[];
    try {
      subscriptions = await loadSubscriptions(admin, recipients.map((recipient) => recipient.id));
    } catch (error) {
      return json({
        error: error instanceof Error
          ? `${error.message} The in-app notification was saved for ${recipients.length} users.`
          : `Subscriptions could not be loaded. The in-app notification was saved for ${recipients.length} users.`,
      }, 500);
    }

    const subscriptionsByUser = new Map<string, SubscriptionRow[]>();
    for (const subscription of subscriptions) {
      const existing = subscriptionsByUser.get(subscription.user_id) || [];
      existing.push(subscription);
      subscriptionsByUser.set(subscription.user_id, existing);
    }
    const successfulUsers = new Set<string>();
    const expiredSubscriptionIds: string[] = [];
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    } catch {
      const { error } = await admin.from('push_notification_recipients')
        .update({ push_status: 'failed' })
        .eq('notification_id', notification.id);
      if (error) return json({ error: 'The notification was saved, but push setup failed and its status could not be recorded.' }, 500);
      return json({
        success: true,
        notificationId: notification.id,
        targetedUserCount: recipients.length,
        pushDeliveredUserCount: 0,
        pushFailedUserCount: 0,
        browserPushConfigured: false,
      });
    }
    const pushBody = JSON.stringify({ title, body: message, destination, notificationId: notification.id });
    for (let start = 0; start < subscriptions.length; start += 25) {
      const batch = subscriptions.slice(start, start + 25);
      await Promise.all(batch.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            pushBody,
            { TTL: 60 * 60 * 24 },
          );
          successfulUsers.add(subscription.user_id);
        } catch (error) {
          const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number(error.statusCode)
            : 0;
          if (statusCode === 404 || statusCode === 410) {
            expiredSubscriptionIds.push(subscription.id);
          }
        }
      }));
    }

    if (expiredSubscriptionIds.length) {
      const { error } = await admin.from('push_subscriptions').delete().in('id', expiredSubscriptionIds);
      if (error) return json({ error: 'Expired subscriptions could not be cleaned up.' }, 500);
    }

    const noSubscriptionIds = recipients
      .filter((recipient) => !subscriptionsByUser.has(recipient.id))
      .map((recipient) => recipient.id);
    const deliveredIds = [...successfulUsers];
    const failedIds = recipients
      .filter((recipient) => subscriptionsByUser.has(recipient.id) && !successfulUsers.has(recipient.id))
      .map((recipient) => recipient.id);
    for (const [ids, pushStatus] of [
      [noSubscriptionIds, 'no_subscription'],
      [deliveredIds, 'sent'],
      [failedIds, 'failed'],
    ] as const) {
      for (let start = 0; start < ids.length; start += 500) {
        const { error } = await admin.from('push_notification_recipients')
          .update({ push_status: pushStatus })
          .eq('notification_id', notification.id)
          .in('user_id', ids.slice(start, start + 500));
        if (error) return json({ error: 'The notification was saved, but push delivery results could not be recorded.' }, 500);
      }
    }

    return json({
      success: true,
      notificationId: notification.id,
      targetedUserCount: recipients.length,
      pushDeliveredUserCount: successfulUsers.size,
      pushFailedUserCount: failedIds.length,
      browserPushConfigured: true,
    });
  }

  return json({ error: 'Unknown action.' }, 400);
});
