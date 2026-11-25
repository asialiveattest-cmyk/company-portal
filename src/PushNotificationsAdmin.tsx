import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Search, Send, Users } from 'lucide-react';
import { supabase } from './supabase';
import { getPushFunctionError } from './pushNotifications';
import './push-notifications.css';

type Recipient = { id: string; full_name: string | null };
type SendResult = {
  targetedUserCount: number;
  pushDeliveredUserCount: number;
  pushFailedUserCount: number;
  browserPushConfigured: boolean;
};

const destinations = [
  'Overview',
  'Submit Account',
  'Submitted Accounts',
  'Running Accounts',
  'Payment Methods',
  'Deposits',
  'Withdrawals',
  'TEST OTP',
  'Inbox',
];

export default function PushNotificationsAdmin() {
  const [users, setUsers] = useState<Recipient[]>([]);
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [destination, setDestination] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SendResult | null>(null);

  useEffect(() => {
    let active = true;
    async function loadUsers() {
      const { data, error: invokeError } = await supabase.functions.invoke<{ users: Recipient[] }>(
        'push-notifications',
        { body: { action: 'list_users' } },
      );
      if (!active) return;
      if (invokeError) setError(await getPushFunctionError(invokeError, 'The active user list could not be loaded.'));
      else if (!data) setError('The active user list could not be loaded.');
      else setUsers(data.users);
      setLoadingUsers(false);
    }
    void loadUsers();
    return () => { active = false; };
  }, []);

  const matchingUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) =>
      (user.full_name || '').toLowerCase().includes(query) || user.id.toLowerCase().includes(query),
    );
  }, [search, users]);
  const targetCount = mode === 'all' ? users.length : selectedIds.length;

  function toggleUser(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id],
    );
  }

  async function sendNotification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setResult(null);
    setLoadingUsers(true);
    const { data, error: invokeError } = await supabase.functions.invoke<{ users: Recipient[] }>(
      'push-notifications',
      { body: { action: 'list_users' } },
    );
    setLoadingUsers(false);
    if (invokeError || !data) {
      setError(await getPushFunctionError(invokeError, 'The active user list could not be refreshed.'));
      return;
    }
    setUsers(data.users);
    const activeIds = new Set(data.users.map((user) => user.id));
    const activeSelectedIds = selectedIds.filter((id) => activeIds.has(id));
    setSelectedIds(activeSelectedIds);
    const currentTargetCount = mode === 'all' ? data.users.length : activeSelectedIds.length;
    if (currentTargetCount === 0) {
      setError(mode === 'all' ? 'There are no active users to notify.' : 'Select at least one active user.');
      return;
    }
    setConfirming(true);
  }

  async function confirmSend() {
    setSending(true);
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke<SendResult & { error?: string }>(
      'push-notifications',
      {
        body: {
          action: 'send',
          title,
          message,
          recipientMode: mode,
          recipientIds: mode === 'selected' ? selectedIds : [],
          destination: destination || undefined,
        },
      },
    );
    setSending(false);
    if (invokeError || data?.error) {
      setError(data?.error || await getPushFunctionError(invokeError, 'The notification could not be sent.'));
      return;
    }
    if (!data) {
      setError('The notification service returned no result.');
      return;
    }
    setResult(data);
    setConfirming(false);
    setTitle('');
    setMessage('');
    setDestination('');
    setSelectedIds([]);
  }

  return (
    <section className="push-admin">
      <div className="panel push-panel">
        <div className="push-heading">
          <div className="push-heading-icon"><Send size={19} /></div>
          <div>
            <h3>Compose notification</h3>
            <p>Send an in-app message and, where enabled, a browser push notification.</p>
          </div>
        </div>
        <form className="push-form" onSubmit={sendNotification}>
          <label>
            Notification title
            <input
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="A short, clear title"
            />
            <small>{title.length}/120</small>
          </label>
          <label>
            Message
            <textarea
              required
              maxLength={2000}
              rows={5}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write the notification message"
            />
            <small>{message.length}/2,000</small>
          </label>
          <fieldset className="push-recipient-mode">
            <legend>Recipients</legend>
            <label>
              <input
                type="radio"
                name="recipient-mode"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
              />
              All Active Users <span>{loadingUsers ? 'Loading…' : `(${users.length})`}</span>
            </label>
            <label>
              <input
                type="radio"
                name="recipient-mode"
                checked={mode === 'selected'}
                onChange={() => setMode('selected')}
              />
              Selected Users <span>({selectedIds.length})</span>
            </label>
          </fieldset>

          {mode === 'selected' && (
            <div className="push-user-picker">
              <label className="push-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search active users by name or ID"
                  aria-label="Search active users"
                />
              </label>
              {loadingUsers ? (
                <p className="push-muted">Loading active users…</p>
              ) : (
                <div className="push-user-list" aria-label="Active users">
                  {matchingUsers.map((user) => (
                    <label className="push-user-option" key={user.id}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(user.id)}
                        onChange={() => toggleUser(user.id)}
                      />
                      <span>
                        <b>{user.full_name?.trim() || 'Unnamed user'}</b>
                        <small>{user.id}</small>
                      </span>
                    </label>
                  ))}
                  {!matchingUsers.length && <p className="push-muted">No active users match this search.</p>}
                </div>
              )}
            </div>
          )}

          <label>
            Destination <span className="push-optional">(optional)</span>
            <select value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">Open the portal home</option>
              {destinations.map((page) => <option key={page} value={page}>{page}</option>)}
            </select>
          </label>

          {error && <div className="notice" role="alert">{error}</div>}
          {result && (
            <div className="push-result" role="status">
              <b>Notification saved for {result.targetedUserCount} user{result.targetedUserCount === 1 ? '' : 's'}.</b>
              {result.browserPushConfigured ? (
                <span>
                  Browser push delivered to {result.pushDeliveredUserCount}; failed for {result.pushFailedUserCount}.
                  Users without an active browser subscription still received the in-app notification.
                </span>
              ) : (
                <span>Browser push is not configured; recipients can still read this notification in the portal.</span>
              )}
            </div>
          )}
          <div className="push-submit-row">
            <span><Users size={15} /> {targetCount} targeted user{targetCount === 1 ? '' : 's'}</span>
            <button className="primary" type="submit" disabled={loadingUsers || targetCount === 0 || !title.trim() || !message.trim()}>
              <Send size={15} /> Review and send
            </button>
          </div>
        </form>
      </div>

      {confirming && (
        <div className="push-modal-backdrop" role="presentation">
          <section className="push-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="push-confirm-title">
            <h3 id="push-confirm-title">Confirm notification</h3>
            <p>
              Send <b>{title}</b> to <b>{targetCount}</b> active user{targetCount === 1 ? '' : 's'}?
              {destination && <> The notification will open <b>{destination}</b>.</>}
            </p>
            <div className="push-confirm-actions">
              <button type="button" className="secondary" disabled={sending} onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="primary" disabled={sending} onClick={() => void confirmSend()}>
                <Send size={15} /> {sending ? 'Sending…' : 'Confirm and send'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
