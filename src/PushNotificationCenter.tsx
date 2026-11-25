import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { supabase } from './supabase';
import { getPushFunctionError } from './pushNotifications';
import './push-notifications.css';

type NotificationRow = {
  id: string;
  notification_id: string;
  user_id: string;
  read_at: string | null;
  created_at: string;
  notification: {
    id: string;
    title: string;
    message: string;
    destination: string | null;
    created_at: string;
  } | null;
};

const pageSize = 30;

function decodeApplicationServerKey(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export default function PushNotificationCenter({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const offsetRef = useRef(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const refresh = useCallback(async (reset = true) => {
    const start = reset ? 0 : offsetRef.current;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    setError('');
    const { data, error: queryError } = await supabase
      .from('push_notification_recipients')
      .select('id,notification_id,user_id,read_at,created_at,notification:push_notifications(id,title,message,destination,created_at)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(start, start + pageSize - 1);
    if (queryError) {
      setError(queryError.message);
    } else {
      const rows = (data || []) as unknown as NotificationRow[];
      setItems((current) => reset ? rows : [...current, ...rows]);
      offsetRef.current = start + rows.length;
      setHasMore(rows.length === pageSize);
    }
    const { count, error: countError } = await supabase
      .from('push_notification_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);
    if (countError) setError((current) => current || countError.message);
    else setUnreadCount(count || 0);
    setLoading(false);
    setLoadingMore(false);
  }, [userId]);

  useEffect(() => {
    void refresh();
    const channel = supabase.channel(`push-notifications-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'push_notification_recipients',
        filter: `user_id=eq.${userId}`,
      }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refresh, userId]);

  useEffect(() => {
    let active = true;
    async function inspectBrowserPush() {
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!active) return;
      setPushAvailable(supported);
      if (!supported) return;
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (active) setPushEnabled(Notification.permission === 'granted' && Boolean(subscription));
    }
    void inspectBrowserPush().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not check browser notification settings.');
    });
    return () => { active = false; };
  }, []);

  async function setBrowserPushEnabled(enabled: boolean) {
    setPushBusy(true);
    setError('');
    try {
      if (enabled) {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Browser notification permission was not granted.');
        const registration = await navigator.serviceWorker.register('/sw.js');
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          const { data, error: keyError } = await supabase.functions.invoke<{ publicKey: string }>(
            'push-notifications',
            { body: { action: 'vapid_public_key' } },
          );
          if (keyError || !data?.publicKey) {
            throw new Error(await getPushFunctionError(keyError, 'Browser push is not configured.'));
          }
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeApplicationServerKey(data.publicKey),
          });
        }
        const { data, error: saveError } = await supabase.functions.invoke<{ error?: string }>(
          'push-notifications',
          { body: { action: 'save_subscription', subscription: subscription.toJSON() } },
        );
        if (saveError || data?.error) {
          setPushEnabled(false);
          throw new Error(data?.error || await getPushFunctionError(saveError, 'Could not save this browser subscription.'));
        }
        setPushEnabled(true);
      } else {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const endpoint = subscription.endpoint;
          await subscription.unsubscribe();
          const { data, error: removeError } = await supabase.functions.invoke<{ error?: string }>(
            'push-notifications',
            { body: { action: 'remove_subscription', subscription: { endpoint } } },
          );
          if (removeError || data?.error) {
            setPushEnabled(false);
            throw new Error(data?.error || await getPushFunctionError(removeError, 'The browser subscription could not be removed from the server.'));
          }
        }
        setPushEnabled(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Browser notification settings could not be updated.');
    } finally {
      setPushBusy(false);
    }
  }

  async function markAsRead(item: NotificationRow) {
    if (item.read_at) return;
    const readAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('push_notification_recipients')
      .update({ read_at: readAt })
      .eq('id', item.id)
      .eq('user_id', userId)
      .is('read_at', null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((current) => current.map((row) => row.id === item.id ? { ...row, read_at: readAt } : row));
    setUnreadCount((current) => Math.max(0, current - 1));
  }

  async function openNotification(item: NotificationRow) {
    await markAsRead(item);
    setOpen(false);
    const destination = item.notification?.destination;
    if (!destination) return;
    try {
      const target = new URL(destination, window.location.origin);
      if (target.origin === window.location.origin && target.pathname === '/') {
        window.location.assign(target.href);
      }
    } catch {
      setError('This notification has an invalid portal destination.');
    }
  }

  return (
    <div className="push-center">
      <button
        type="button"
        className="push-bell-button"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        onClick={() => { setOpen((current) => !current); if (!open) void refresh(); }}
      >
        <Bell size={18} />
        {unreadCount > 0 && <span className="push-bell-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <section className="push-center-popover" aria-label="Notification history">
          <div className="push-center-header">
            <div><h3>Notifications</h3><span>{unreadCount} unread</span></div>
            <button type="button" aria-label="Close notifications" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="push-browser-setting">
            <div>
              <b>Browser notifications</b>
              <small>
                {!pushAvailable
                  ? 'Not supported in this browser.'
                  : pushEnabled
                    ? 'Enabled on this device.'
                    : 'Disabled; in-app notifications will still arrive.'}
              </small>
            </div>
            <button
              type="button"
              className={pushEnabled ? 'push-toggle is-enabled' : 'push-toggle'}
              disabled={!pushAvailable || pushBusy}
              aria-pressed={pushEnabled}
              onClick={() => void setBrowserPushEnabled(!pushEnabled)}
            >
              {pushBusy ? <LoaderCircle size={15} className="push-spin" /> : pushEnabled ? <BellOff size={15} /> : <Bell size={15} />}
              {pushEnabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          {error && <div className="push-inline-error" role="alert">{error}</div>}
          <div className="push-history">
            {loading && !items.length ? (
              <p className="push-muted">Loading notifications…</p>
            ) : items.length ? items.map((item) => (
              <button
                type="button"
                className={`push-history-item${item.read_at ? '' : ' is-unread'}`}
                key={item.id}
                onClick={() => void openNotification(item)}
              >
                <span className="push-history-status">{item.read_at ? <Check size={14} /> : <span />}</span>
                <span className="push-history-copy">
                  <b>{item.notification?.title || 'Notification'}</b>
                  <span>{item.notification?.message || 'This notification is no longer available.'}</span>
                  <small>{item.notification?.created_at ? new Date(item.notification.created_at).toLocaleString() : ''}</small>
                </span>
              </button>
            )) : (
              <p className="push-muted">{error ? 'Notification history could not be loaded.' : 'No notifications yet.'}</p>
            )}
            {hasMore && (
              <button type="button" className="push-load-more" disabled={loadingMore} onClick={() => void refresh(false)}>
                {loadingMore ? 'Loading…' : <>Show earlier <ChevronDown size={14} /></>}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
