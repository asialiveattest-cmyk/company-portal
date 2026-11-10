import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, Search, ShieldCheck, StickyNote, UserRoundCheck, Wallet, X } from 'lucide-react';
import { supabase } from './supabase';
import './user-management.css';

type ApprovalStatus = 'pending' | 'active' | 'suspended' | 'rejected';
type ManagedUser = {
  id: string;
  full_name: string | null;
  email: string;
  role: 'user' | 'employee' | 'super_admin';
  approval_status: ApprovalStatus;
  created_at: string;
  employee_note: string;
};
type UserAction = { user: ManagedUser; status: ApprovalStatus; label: string };
const filters: ('all' | ApprovalStatus)[] = ['all', 'pending', 'active', 'suspended', 'rejected'];

export default function UserManagement({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | ApprovalStatus>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [action, setAction] = useState<UserAction | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createReview, setCreateReview] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<'user' | 'employee'>('user');
  const [noteUser, setNoteUser] = useState<ManagedUser | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [showBalances, setShowBalances] = useState(false);
  const [balanceUserId, setBalanceUserId] = useState('');
  const [balanceUsdt, setBalanceUsdt] = useState('');
  const [balanceInr, setBalanceInr] = useState('');
  const [balanceLoading, setBalanceLoading] = useState(false);

  async function loadUsers() {
    setLoading(true);
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', { body: { action: 'list' } });
    if (invokeError) setError(invokeError.message);
    else if (data?.error) setError(data.error);
    else if (Array.isArray(data?.users)) setUsers(data.users);
    else setError('The user list response was invalid.');
    setLoading(false);
  }

  useEffect(() => {
    void loadUsers();
    void supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id || ''));
  }, []);

  const visibleUsers = useMemo(() => users.filter((user) => {
    const search = `${user.full_name || ''} ${user.email}`.toLowerCase();
    return (filter === 'all' || user.approval_status === filter) && search.includes(query.trim().toLowerCase());
  }), [users, filter, query]);

  async function confirmAction() {
    if (!action) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: { action: 'set_status', userId: action.user.id, status: action.status },
    });
    setBusy(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not update this user.');
      return;
    }
    setSuccess(`${action.user.full_name || action.user.email} is now ${action.status}.`);
    setAction(null);
    await loadUsers();
  }

  function reviewCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateReview(true);
  }

  function closeCreate() {
    if (busy) return;
    setShowCreate(false);
    setCreateReview(false);
    setCreateName('');
    setCreateEmail('');
    setCreatePassword('');
    setCreateRole('user');
  }

  async function createUser() {
    setBusy(true);
    setError('');
    setSuccess('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: {
        action: 'create_user',
        fullName: createName.trim(),
        email: createEmail.trim(),
        password: createPassword,
        role: createRole,
      },
    });
    setBusy(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not create this user.');
      setCreateReview(false);
      return;
    }
    setSuccess(`${createName.trim()} (${createEmail.trim()}) was created.`);
    setCreateReview(false);
    setShowCreate(false);
    setCreateName('');
    setCreateEmail('');
    setCreatePassword('');
    setCreateRole('user');
    await loadUsers();
  }

  function openNotes(user: ManagedUser) {
    setNoteUser(user);
    setNoteDraft(user.employee_note || '');
    setError('');
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!noteUser) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: { action: 'update_note', userId: noteUser.id, note: noteDraft },
    });
    setBusy(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not save this employee note.');
      return;
    }
    setUsers((current) => current.map((user) =>
      user.id === noteUser.id ? { ...user, employee_note: noteDraft.trim() } : user,
    ));
    setSuccess(`Employee note updated for ${noteUser.full_name || noteUser.email}.`);
    setNoteUser(null);
  }

  async function selectBalanceUser(userId: string) {
    setBalanceUserId(userId);
    setBalanceUsdt('');
    setBalanceInr('');
    setError('');
    if (!userId) return;
    setBalanceLoading(true);
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: { action: 'get_balance', balanceUserId: userId },
    });
    setBalanceLoading(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not load this user’s balances.');
      return;
    }
    if (data?.balance) {
      setBalanceUsdt(data.balance.balanceUsdt);
      setBalanceInr(data.balance.balanceInr);
    }
  }

  async function saveBalances(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!balanceUserId) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: {
        action: 'update_balance',
        balanceUserId,
        balanceUsdt: balanceUsdt.trim(),
        balanceInr: balanceInr.trim(),
      },
    });
    setBusy(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not save this user’s balances.');
      return;
    }
    const user = users.find((item) => item.id === balanceUserId);
    setSuccess(`Balances saved for ${user?.full_name || user?.email || 'the selected user'}.`);
    setShowBalances(false);
  }

  function dismissNotice() {
    setError('');
    setSuccess('');
  }

  function nextAction(user: ManagedUser): UserAction | null {
    if (user.role === 'super_admin' || user.id === currentUserId) return null;
    if (user.approval_status === 'pending') return { user, status: 'active', label: 'Approve' };
    if (user.approval_status === 'active') return { user, status: 'suspended', label: 'Suspend' };
    if (user.approval_status === 'suspended') return { user, status: 'active', label: 'Reactivate' };
    return null;
  }

  return (
    <section className="user-management" aria-labelledby="users-heading">
      <div className="management-heading">
        <div>
          <div className="eyebrow">ACCESS CONTROL</div>
          <h1 id="users-heading">User management</h1>
          <p>Review registrations and manage workspace access.</p>
        </div>
        <div className="management-actions">
          <button className="secondary" onClick={() => void loadUsers()} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
          {isSuperAdmin && <button className="secondary" onClick={() => { setShowBalances(true); setError(''); setBalanceUserId(''); setBalanceUsdt(''); setBalanceInr(''); }}>
            <Wallet size={16} /> Manage balances
          </button>}
          <button className="primary" onClick={() => { setShowCreate(true); setError(''); }}>
            <Plus size={16} /> Create user
          </button>
        </div>
      </div>
      {error && <div className="management-notice error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={dismissNotice}><X size={16} /></button></div>}
      {success && <div className="management-notice success" role="status"><span>{success}</span><button aria-label="Dismiss notification" onClick={dismissNotice}><X size={16} /></button></div>}

      <div className="management-toolbar">
        <label className="user-search"><Search size={17} /><input aria-label="Search users" placeholder="Search name or email" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="filter-tabs" role="group" aria-label="Filter users by approval status">
          {filters.map((status) => (
            <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}>
              {status === 'all' ? 'All' : status[0].toUpperCase() + status.slice(1)}
              {status !== 'all' && <span>{users.filter((user) => user.approval_status === status).length}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="user-table-wrap">
        <table className="user-table">
          <thead><tr><th>User</th><th>Registered</th><th>Role</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {visibleUsers.map((user) => {
              const actionOption = nextAction(user);
              return (
                <tr key={user.id}>
                  <td><div className="managed-user"><span className="managed-avatar">{(user.full_name || user.email).slice(0, 1).toUpperCase()}</span><div><strong>{user.full_name || 'Unnamed user'}</strong><small>{user.email}</small></div></div></td>
                  <td data-label="Registered">{new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td data-label="Role"><span className="role-label">{user.role.replace('_', ' ')}</span></td>
                  <td data-label="Status"><span className={`status-badge ${user.approval_status}`}>{user.approval_status}</span></td>
                  <td className="user-actions">
                    {(isSuperAdmin || user.role === 'user') && <button className="table-action" disabled={busy} onClick={() => openNotes(user)} aria-label={`Edit employee notes for ${user.full_name || user.email}`}><StickyNote size={15} /><span>Notes</span></button>}
                    {actionOption && (isSuperAdmin || user.role === 'user') && <button className={`table-action ${actionOption.status === 'suspended' ? 'danger' : ''}`} disabled={busy} onClick={() => setAction(actionOption)}>
                      {actionOption.status === 'active' ? <Check size={15} /> : actionOption.status === 'suspended' ? <X size={15} /> : <UserRoundCheck size={15} />}
                      <span>{actionOption.label}</span>
                    </button>}
                    {user.approval_status !== 'rejected' && user.role !== 'super_admin' && user.id !== currentUserId && <button className="reject-action" disabled={busy} onClick={() => setAction({ user, status: 'rejected', label: 'Reject' })}>Reject</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading ? <div className="management-empty">Loading users…</div> : visibleUsers.length === 0 ? <div className="management-empty">{users.length ? 'No users match these filters.' : 'No registered users found.'}</div> : null}
      </div>
      <p className="table-count">Showing {visibleUsers.length} of {users.length} users</p>

      {showCreate && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
        <section className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="create-heading">
          <div className="dialog-icon"><ShieldCheck size={20} /></div>
          <h2 id="create-heading">Create a user</h2>
          <p>Set an initial password. New regular users stay pending until approved.</p>
          <form onSubmit={reviewCreate}>
            <label>Full name<input required autoFocus maxLength={120} value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Full name" /></label>
            <label>Email address<input required type="email" maxLength={254} autoComplete="email" value={createEmail} onChange={(event) => setCreateEmail(event.target.value)} placeholder="name@company.com" /></label>
            <label>Initial password<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="At least 8 characters" /></label>
            {isSuperAdmin && <label>Account role<select value={createRole} onChange={(event) => setCreateRole(event.target.value as 'user' | 'employee')}><option value="user">Regular user</option><option value="employee">Employee</option></select><ChevronDown className="select-chevron" size={15} /></label>}
            <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={closeCreate}>Cancel</button><button type="submit" className="primary" disabled={busy}>Review account</button></div>
          </form>
        </section>
      </div>}

      {createReview && <div className="dialog-backdrop" role="presentation">
        <section className="management-dialog" role="alertdialog" aria-modal="true" aria-labelledby="create-confirm-heading" aria-describedby="create-confirm-copy">
          <div className="dialog-icon"><ShieldCheck size={20} /></div>
          <h2 id="create-confirm-heading">Create this account?</h2>
          <p id="create-confirm-copy">The account will be created with the password you entered. Passwords are never emailed or stored in the user list.</p>
          <div className="dialog-user">{createName}<small>{createEmail} · {createRole === 'employee' ? 'Employee (active)' : 'Regular user (pending approval)'}</small></div>
          <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setCreateReview(false)}>Back</button><button className="primary" disabled={busy} onClick={() => void createUser()}>{busy ? 'Creating…' : 'Confirm creation'}</button></div>
        </section>
      </div>}

      {noteUser && <div className="dialog-backdrop" role="presentation">
        <section className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="notes-heading">
          <div className="dialog-icon"><StickyNote size={20} /></div>
          <h2 id="notes-heading">Employee notes</h2>
          <p>Only employees and super admins can access these notes.</p>
          <div className="dialog-user">{noteUser.full_name || 'Unnamed user'}<small>{noteUser.email}</small></div>
          <form onSubmit={(event) => void saveNote(event)}>
            <label>Notes<textarea className="management-notes" maxLength={5000} rows={5} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add internal notes about this user" /></label>
            <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setNoteUser(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save notes'}</button></div>
          </form>
        </section>
      </div>}

      {showBalances && isSuperAdmin && <div className="dialog-backdrop" role="presentation">
        <section className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="balances-heading">
          <div className="dialog-icon"><Wallet size={20} /></div>
          <h2 id="balances-heading">Manage user balances</h2>
          <p>Enter the manually verified USDT and INR balances. No transactions or balance history are created.</p>
          <form onSubmit={(event) => void saveBalances(event)}>
            <label>Registered user<select required value={balanceUserId} onChange={(event) => void selectBalanceUser(event.target.value)}><option value="">Select a user</option>{users.map((user) => <option key={user.id} value={user.id}>{user.full_name || 'Unnamed user'} — {user.email}</option>)}</select><ChevronDown className="select-chevron" size={15} /></label>
            {balanceLoading ? <p className="muted">Loading current balances…</p> : <>
              <label>USDT balance<input required type="text" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={balanceUsdt} onChange={(event) => setBalanceUsdt(event.target.value)} placeholder="e.g. 0.000000" /></label>
              <label>INR balance<input required type="text" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={balanceInr} onChange={(event) => setBalanceInr(event.target.value)} placeholder="e.g. 0.00" /></label>
            </>}
            <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setShowBalances(false)}>Cancel</button><button type="submit" className="primary" disabled={busy || balanceLoading || !balanceUserId}>{busy ? 'Saving…' : 'Save balances'}</button></div>
          </form>
        </section>
      </div>}

      {action && <div className="dialog-backdrop" role="presentation">
        <section className="management-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-heading" aria-describedby="confirm-copy">
          <div className="dialog-icon"><ShieldCheck size={20} /></div>
          <h2 id="confirm-heading">{action.label} this account?</h2>
          <p id="confirm-copy">{action.status === 'active' && action.user.approval_status === 'pending' ? 'This user will be able to access the company portal.' : action.status === 'active' ? 'This user will regain access to the company portal.' : action.status === 'suspended' ? 'This user will lose access until reactivated.' : 'This registration will be rejected and portal access will remain blocked.'}</p>
          <div className="dialog-user">{action.user.full_name || action.user.email}<small>{action.user.email}</small></div>
          <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setAction(null)}>Cancel</button><button className={action.status === 'suspended' || action.status === 'rejected' ? 'danger-button' : 'primary'} disabled={busy} onClick={() => void confirmAction()}>{busy ? 'Saving…' : `Confirm ${action.label.toLowerCase()}`}</button></div>
        </section>
      </div>}
    </section>
  );
}
