import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Pencil, Play, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { supabase } from './supabase';
import './running-accounts.css';

type RunningAccount = {
  id: string;
  user_id: string;
  account_name: string;
  starting_volume_inr: number;
  current_volume_inr: number;
  success_rate: number;
  otp_status: 'online' | 'dropped';
  commission_percentage: number;
  usdt_conversion_rate: number;
  status: 'active' | 'paused';
  updated_at: string;
};

type AccountCommission = {
  id: string;
  account_id: string;
  commission_inr: number;
  commission_usdt: number;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type RegularUser = { id: string; full_name: string | null };
type AccountDraft = {
  account_name: string;
  starting_volume_inr: string;
  current_volume_inr: string;
  success_rate: string;
  otp_status: 'online' | 'dropped';
  commission_percentage: string;
  usdt_conversion_rate: string;
};

const emptyDraft: AccountDraft = {
  account_name: '',
  starting_volume_inr: '0',
  current_volume_inr: '0',
  success_rate: '75',
  otp_status: 'online',
  commission_percentage: '0',
  usdt_conversion_rate: '1',
};
const PAGE_SIZE = 500;
const ACCOUNT_ID_BATCH_SIZE = 100;

function inr(value: number) {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdt(value: number) {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

export default function RunningAccounts({ userId, role }: { userId: string; role: 'user' | 'employee' | 'super_admin' }) {
  const isSuperAdmin = role === 'super_admin';
  const [users, setUsers] = useState<RegularUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [accounts, setAccounts] = useState<RunningAccount[]>([]);
  const [commissions, setCommissions] = useState<AccountCommission[]>([]);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<AccountDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rowBusyId, setRowBusyId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const loadSequence = useRef(0);

  const targetUserId = isSuperAdmin ? selectedUserId : role === 'user' ? userId : '';
  const commissionByAccount = useMemo(() => {
    const latest = new Map<string, AccountCommission>();
    for (const commission of commissions) {
      if (!latest.has(commission.account_id)) latest.set(commission.account_id, commission);
    }
    return latest;
  }, [commissions]);
  const totals = useMemo(() => accounts.reduce((sum, account) => {
    const commission = commissionByAccount.get(account.id);
    return {
      volume: sum.volume + Number(account.current_volume_inr),
      inr: sum.inr + Number(commission?.commission_inr || 0),
      usdt: sum.usdt + Number(commission?.commission_usdt || 0),
    };
  }, { volume: 0, inr: 0, usdt: 0 }), [accounts, commissionByAccount]);

  const loadAccounts = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!targetUserId) {
      setAccounts([]);
      setCommissions([]);
      setLoading(false);
      return;
    }

    try {
      const accountRows: RunningAccount[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const accountResult = await supabase.from('running_accounts').select(
          'id,user_id,account_name,starting_volume_inr,current_volume_inr,success_rate,otp_status,commission_percentage,usdt_conversion_rate,status,updated_at',
        )
          .eq('user_id', targetUserId)
          .order('created_at').order('id')
          .range(offset, offset + PAGE_SIZE - 1);
        if (sequence !== loadSequence.current) return;
        if (accountResult.error) {
          setError(accountResult.error.message);
          return;
        }
        accountRows.push(...(accountResult.data || []) as RunningAccount[]);
        if ((accountResult.data || []).length < PAGE_SIZE) break;
      }

      const commissionRows: AccountCommission[] = [];
      for (let start = 0; start < accountRows.length; start += ACCOUNT_ID_BATCH_SIZE) {
        const accountIds = accountRows.slice(start, start + ACCOUNT_ID_BATCH_SIZE).map((account) => account.id);
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const commissionResult = await supabase.from('running_account_current_commissions').select('*')
            .in('account_id', accountIds)
            .order('account_id')
            .range(offset, offset + PAGE_SIZE - 1);
          if (sequence !== loadSequence.current) return;
          if (commissionResult.error) {
            setError(commissionResult.error.message);
            return;
          }
          commissionRows.push(...(commissionResult.data || []) as AccountCommission[]);
          if ((commissionResult.data || []).length < PAGE_SIZE) break;
        }
      }
      setAccounts(accountRows);
      setCommissions(commissionRows);
      setError('');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [targetUserId]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let active = true;
    void (async () => {
      const allUsers: RegularUser[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error: usersError } = await supabase.from('profiles').select('id,full_name')
          .eq('role', 'user')
          .order('full_name').order('id')
          .range(offset, offset + PAGE_SIZE - 1);
        if (!active) return;
        if (usersError) {
          setError(usersError.message);
          return;
        }
        allUsers.push(...(data || []) as RegularUser[]);
        if ((data || []).length < PAGE_SIZE) break;
      }
      setUsers(allUsers);
      if (allUsers.length) setSelectedUserId((current) => current || allUsers[0].id);
    })();
    return () => { active = false; };
  }, [isSuperAdmin]);

  useEffect(() => {
    void loadAccounts();
    if (!targetUserId) return;
    let refreshTimer: number | undefined;
    let lastRefreshAt = 0;
    const queueRefresh = () => {
      if (refreshTimer !== undefined) return;
      const delay = Math.max(0, 250 - (Date.now() - lastRefreshAt));
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        lastRefreshAt = Date.now();
        void loadAccounts();
      }, delay);
    };
    const channel = supabase.channel(`running-accounts-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'running_accounts', filter: `user_id=eq.${targetUserId}` }, queueRefresh)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          queueRefresh();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setError('Live updates are unavailable. Use Refresh to load the latest accounts.');
        }
      });
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [loadAccounts, targetUserId, userId]);

  function startEditing(account: RunningAccount) {
    setEditingId(account.id);
    setDraft({
      account_name: account.account_name,
      starting_volume_inr: String(account.starting_volume_inr),
      current_volume_inr: String(account.current_volume_inr),
      success_rate: String(account.success_rate),
      otp_status: account.otp_status,
      commission_percentage: String(account.commission_percentage),
      usdt_conversion_rate: String(account.usdt_conversion_rate),
    });
    setSuccess('');
    setError('');
  }

  function cancelEditing() {
    setEditingId('');
    setDraft(emptyDraft);
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isSuperAdmin || !targetUserId) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const payload = {
      user_id: targetUserId,
      account_name: draft.account_name.trim(),
      starting_volume_inr: Number(draft.starting_volume_inr),
      current_volume_inr: Number(draft.current_volume_inr),
      success_rate: Number(draft.success_rate),
      otp_status: draft.otp_status,
      commission_percentage: Number(draft.commission_percentage),
      usdt_conversion_rate: Number(draft.usdt_conversion_rate),
    };
    const result = editingId
      ? await supabase.from('running_accounts').update(payload).eq('id', editingId).eq('user_id', targetUserId)
      : await supabase.from('running_accounts').insert(payload);
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setSuccess(editingId ? 'Account updated.' : 'Account added.');
    cancelEditing();
    await loadAccounts();
  }

  async function changeAccountStatus(account: RunningAccount) {
    setRowBusyId(account.id);
    setError('');
    const { error: updateError } = await supabase.from('running_accounts')
      .update({ status: account.status === 'active' ? 'paused' : 'active' })
      .eq('id', account.id);
    setRowBusyId('');
    if (updateError) setError(updateError.message);
    else await loadAccounts();
  }

  async function deleteAccount(account: RunningAccount) {
    if (!window.confirm(`Delete ${account.account_name}?`)) return;
    setRowBusyId(account.id);
    setError('');
    const { error: deleteError } = await supabase.from('running_accounts').delete().eq('id', account.id);
    setRowBusyId('');
    if (deleteError) setError(deleteError.message);
    else {
      if (editingId === account.id) cancelEditing();
      await loadAccounts();
    }
  }

  async function reviewCommission(commissionId: string, status: 'approved' | 'rejected') {
    setRowBusyId(commissionId);
    setError('');
    setSuccess('');
    const { error: reviewError } = await supabase.rpc('set_running_account_commission_status', {
      p_commission_id: commissionId,
      p_status: status,
    });
    setRowBusyId('');
    if (reviewError) setError(reviewError.message);
    else {
      setSuccess(`Commission ${status}.`);
      await loadAccounts();
    }
  }

  if (role === 'employee') {
    return <section className="running-accounts panel"><h1>Running Accounts</h1><p className="muted">This section is available to regular users and Super Admins.</p></section>;
  }

  return (
    <section className="running-accounts" aria-labelledby="running-accounts-heading">
      <header className="running-accounts-heading">
        <div>
          <div className="eyebrow">ACCOUNT ACTIVITY</div>
          <h1 id="running-accounts-heading">Running Accounts</h1>
          <p>{isSuperAdmin ? 'Manage assigned accounts and review calculated commissions.' : 'Your assigned accounts and current activity.'}</p>
        </div>
        <button className="secondary" type="button" onClick={() => void loadAccounts()}><RefreshCw size={16}/> Refresh</button>
      </header>

      {error && <div className="running-message error" role="alert">{error}</div>}
      {success && <div className="running-message success" role="status">{success}</div>}

      {isSuperAdmin && (
        <section className="running-card running-user-picker">
          <label htmlFor="running-user-select">Select registered user</label>
          <select id="running-user-select" value={selectedUserId} onChange={(event) => {
            setSelectedUserId(event.target.value);
            setAccounts([]);
            setCommissions([]);
            setLoading(true);
            setEditingId('');
            setDraft(emptyDraft);
            setSuccess('');
          }}>
            {!users.length && <option value="">No regular users found</option>}
            {users.map((user) => <option key={user.id} value={user.id}>{user.full_name?.trim() || 'Unnamed user'} · {user.id.slice(0, 8)}</option>)}
          </select>
          {!users.length && <p className="running-picker-empty">No registered regular users found.</p>}
        </section>
      )}

      {targetUserId && (
        <div className="running-total-grid">
          <article className="running-total"><span>Total Volume (INR)</span><strong>{inr(totals.volume)}</strong></article>
          <article className="running-total"><span>Total Commission (INR)</span><strong>{inr(totals.inr)}</strong></article>
          <article className="running-total"><span>Total Commission (USDT)</span><strong>{usdt(totals.usdt)} USDT</strong></article>
        </div>
      )}

      {isSuperAdmin && (
        <form className="running-card running-account-form" onSubmit={(event) => void saveAccount(event)}>
          <div className="running-form-heading">
            <div><h2>{editingId ? 'Edit account' : 'Add account'}</h2><p>Account details and commission settings.</p></div>
          </div>
          <div className="running-form-grid">
            <label>Account name<input required maxLength={120} value={draft.account_name} onChange={(event) => setDraft({ ...draft, account_name: event.target.value })}/></label>
            <label>Starting volume (INR)<input required type="number" min="0" step="0.01" value={draft.starting_volume_inr} onChange={(event) => setDraft({ ...draft, starting_volume_inr: event.target.value })}/></label>
            <label>Current volume (INR)<input required type="number" min="0" step="0.01" value={draft.current_volume_inr} onChange={(event) => setDraft({ ...draft, current_volume_inr: event.target.value })}/></label>
            <label>Success rate (%)<input required type="number" min="50" max="100" step="0.01" value={draft.success_rate} onChange={(event) => setDraft({ ...draft, success_rate: event.target.value })}/></label>
            <label>Commission percentage<input required type="number" min="0" max="100" step="0.0001" value={draft.commission_percentage} onChange={(event) => setDraft({ ...draft, commission_percentage: event.target.value })}/></label>
            <label>INR per USDT<input required type="number" min="0.00000001" step="0.00000001" value={draft.usdt_conversion_rate} onChange={(event) => setDraft({ ...draft, usdt_conversion_rate: event.target.value })}/></label>
            <label>OTP status<select value={draft.otp_status} onChange={(event) => setDraft({ ...draft, otp_status: event.target.value as AccountDraft['otp_status'] })}><option value="online">ONLINE</option><option value="dropped">DROPPED</option></select></label>
          </div>
          <div className="running-form-actions">
            <button className="primary" type="submit" disabled={busy || !selectedUserId}>{busy ? 'Saving…' : editingId ? <><Save size={16}/> Save changes</> : <><Plus size={16}/> Add account</>}</button>
            {editingId && <button className="secondary" type="button" onClick={cancelEditing}><X size={16}/> Cancel</button>}
          </div>
        </form>
      )}

      {!targetUserId && !isSuperAdmin && <div className="running-card running-empty">No live running accounts yet.</div>}
      {targetUserId && loading && <div className="running-card running-empty">Loading accounts…</div>}
      {targetUserId && !loading && !accounts.length && (
        <div className="running-card running-empty">{isSuperAdmin ? 'No accounts are assigned to this user yet.' : 'No live running accounts yet.'}</div>
      )}

      {!!accounts.length && !loading && (
        <div className="running-account-list">
          {accounts.map((account) => {
            const commission = commissionByAccount.get(account.id);
            return (
              <article className="running-card running-account-card" key={account.id}>
                <div className="running-account-title">
                  <div><h2>{account.account_name}</h2><span className={`running-state ${account.status}`}>{account.status}</span></div>
                  <span className={`otp-state ${account.otp_status}`}>{account.otp_status.toUpperCase()}</span>
                </div>
                <div className="running-account-metrics">
                  <div><span>Starting volume</span><strong>{inr(Number(account.starting_volume_inr))}</strong></div>
                  <div><span>Current volume</span><strong>{inr(Number(account.current_volume_inr))}</strong></div>
                  <div><span>Success rate</span><strong>{Number(account.success_rate).toFixed(2)}%</strong></div>
                  <div><span>Commission rate</span><strong>{Number(account.commission_percentage).toLocaleString('en-IN')}%</strong></div>
                  <div><span>Commission (INR)</span><strong>{inr(Number(commission?.commission_inr || 0))}</strong></div>
                  <div><span>Commission (USDT)</span><strong>{usdt(Number(commission?.commission_usdt || 0))} USDT</strong></div>
                  <div><span>INR per USDT</span><strong>{Number(account.usdt_conversion_rate).toLocaleString('en-IN')}</strong></div>
                </div>
                {!isSuperAdmin && <p className="running-update-time">Updated {new Date(account.updated_at).toLocaleTimeString()}</p>}
                {isSuperAdmin && (
                  <>
                    <div className="running-admin-actions">
                      <button className="secondary" type="button" onClick={() => startEditing(account)}><Pencil size={15}/> Edit</button>
                      <button className="secondary" type="button" disabled={rowBusyId === account.id} onClick={() => void changeAccountStatus(account)}>
                        {account.status === 'active' ? <><X size={15}/> Pause</> : <><Play size={15}/> Resume</>}
                      </button>
                      <button className="running-delete" type="button" disabled={rowBusyId === account.id} onClick={() => void deleteAccount(account)}><Trash2 size={15}/> Delete</button>
                    </div>
                    {commission && (
                      <div className="running-review">
                        <div>
                          <span className="running-review-label">Commission review · {inr(Number(commission.commission_inr))} · {usdt(Number(commission.commission_usdt))} USDT</span>
                          <span className={`commission-state ${commission.status}`}>{commission.status}</span>
                          {commission.reviewed_at && <small>Reviewed by {commission.reviewed_by?.slice(0, 8)} · {new Date(commission.reviewed_at).toLocaleString()}</small>}
                        </div>
                        {commission.status === 'pending' && <div className="running-review-actions">
                          <button className="running-approve" type="button" disabled={rowBusyId === commission.id} onClick={() => void reviewCommission(commission.id, 'approved')}><Check size={15}/> Approve</button>
                          <button className="running-reject" type="button" disabled={rowBusyId === commission.id} onClick={() => void reviewCommission(commission.id, 'rejected')}><X size={15}/> Reject</button>
                        </div>}
                      </div>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
