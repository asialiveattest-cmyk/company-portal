import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CreditCard, Plus, RefreshCw, Star, Trash2, Wallet, X } from 'lucide-react';
import { supabase } from './supabase';
import './payment-methods.css';

type MethodType = 'bank_account' | 'usdt_wallet';
type Network = 'TRC20' | 'ERC20' | 'BEP20';
type PaymentMethod = {
  id: string;
  user_id: string;
  method_type: MethodType;
  account_holder_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  ifsc_code: string | null;
  wallet_address: string | null;
  network: Network | null;
  is_default: boolean;
  created_at: string;
};
type OwnerProfile = { id: string; full_name: string | null };
type MethodForm = {
  method_type: MethodType;
  account_holder_name: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
  wallet_address: string;
  network: Network;
  make_default: boolean;
};

const blankForm = (): MethodForm => ({
  method_type: 'bank_account',
  account_holder_name: '',
  bank_name: '',
  account_number: '',
  ifsc_code: '',
  wallet_address: '',
  network: 'TRC20',
  make_default: false,
});

export default function PaymentMethods({ userId, isStaff }: { userId: string; isStaff: boolean }) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [form, setForm] = useState<MethodForm>(blankForm);
  const [confirmDelete, setConfirmDelete] = useState<PaymentMethod | null>(null);

  const loadMethods = useCallback(async () => {
    setLoading(true);
    setError('');
    let query = supabase.from('payment_methods').select('*').order('created_at', { ascending: false });
    if (!isStaff) query = query.eq('user_id', userId);
    const { data, error: loadError } = await query;
    if (loadError) {
      setError(loadError.message);
      setLoading(false);
      return;
    }

    const records = (data || []) as PaymentMethod[];
    setMethods(records);
    if (isStaff && records.length) {
      const ownerIds = [...new Set(records.map((method) => method.user_id))];
      const { data: profiles, error: profileError } = await supabase.from('profiles')
        .select('id,full_name')
        .in('id', ownerIds);
      if (profileError) setError(profileError.message);
      else {
        setOwners(Object.fromEntries(((profiles || []) as OwnerProfile[]).map((profile) => [
          profile.id,
          profile.full_name?.trim() || 'Unnamed user',
        ])));
      }
    } else {
      setOwners({});
    }
    setLoading(false);
  }, [isStaff, userId]);

  useEffect(() => {
    void loadMethods();
  }, [loadMethods]);

  function startCreate(type: MethodType) {
    setEditing(null);
    setForm({ ...blankForm(), method_type: type });
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  function startEdit(method: PaymentMethod) {
    setEditing(method);
    setShowForm(true);
    setForm({
      method_type: method.method_type,
      account_holder_name: method.account_holder_name || '',
      bank_name: method.bank_name || '',
      account_number: method.account_number || '',
      ifsc_code: method.ifsc_code || '',
      wallet_address: method.wallet_address || '',
      network: method.network || 'TRC20',
      make_default: method.is_default,
    });
    setError('');
    setSuccess('');
  }

  function closeForm() {
    if (busy) return;
    setShowForm(false);
    setEditing(null);
    setForm(blankForm());
  }

  async function saveMethod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isStaff) return;
    setBusy(true);
    setError('');
    setSuccess('');

    const methodFields = form.method_type === 'bank_account'
      ? {
          method_type: form.method_type,
          account_holder_name: form.account_holder_name.trim(),
          bank_name: form.bank_name.trim(),
          account_number: form.account_number.trim(),
          ifsc_code: form.ifsc_code.trim().toUpperCase(),
          wallet_address: null,
          network: null,
        }
      : {
          method_type: form.method_type,
          account_holder_name: null,
          bank_name: null,
          account_number: null,
          ifsc_code: null,
          wallet_address: form.wallet_address.trim(),
          network: form.network,
        };

    const result = editing
      ? await supabase.from('payment_methods').update({ ...methodFields, updated_at: new Date().toISOString() })
          .eq('id', editing.id).eq('user_id', userId).select('id').single()
      : await supabase.from('payment_methods').insert({ ...methodFields, user_id: userId, is_default: false }).select('id').single();

    if (result.error || !result.data) {
      setBusy(false);
      setError(result.error?.message || 'Could not save this payment method.');
      return;
    }

    if (form.make_default) {
      const { error: defaultError } = await supabase.rpc('set_default_payment_method', { method_id: result.data.id });
      if (defaultError) {
        setBusy(false);
        setError(`Payment method saved, but could not set it as default: ${defaultError.message}`);
        setShowForm(false);
        setEditing(null);
        setForm(blankForm());
        await loadMethods();
        return;
      }
    } else if (editing?.is_default) {
      const { error: clearError } = await supabase.from('payment_methods')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('id', result.data.id)
        .eq('user_id', userId);
      if (clearError) {
        setBusy(false);
        setError(`Payment method saved, but could not clear its default setting: ${clearError.message}`);
        await loadMethods();
        return;
      }
    }

    setBusy(false);
    setShowForm(false);
    setEditing(null);
    setForm(blankForm());
    setSuccess(editing ? 'Payment method updated.' : 'Payment method added.');
    await loadMethods();
  }

  async function makeDefault(method: PaymentMethod) {
    if (isStaff) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { error: defaultError } = await supabase.rpc('set_default_payment_method', { method_id: method.id });
    setBusy(false);
    if (defaultError) {
      setError(defaultError.message);
      return;
    }
    setSuccess('Default payment method updated.');
    await loadMethods();
  }

  async function deleteMethod() {
    if (!confirmDelete || isStaff) return;
    setBusy(true);
    setError('');
    const { error: deleteError } = await supabase.from('payment_methods')
      .delete()
      .eq('id', confirmDelete.id)
      .eq('user_id', userId);
    setBusy(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setConfirmDelete(null);
    setSuccess('Payment method deleted.');
    await loadMethods();
  }

  return (
    <section className="payment-methods" aria-labelledby="payment-methods-heading">
      <div className="payment-methods-heading">
        <div>
          <div className="eyebrow">{isStaff ? 'WITHDRAWAL PROCESSING' : 'YOUR ACCOUNT'}</div>
          <h1 id="payment-methods-heading">{isStaff ? 'User payment methods' : 'Payment methods'}</h1>
          <p>{isStaff ? 'View saved bank accounts and USDT wallets. Staff cannot edit or delete them.' : 'Manage the bank accounts and USDT wallets you use for payments.'}</p>
        </div>
        <button className="secondary" onClick={() => void loadMethods()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
      </div>

      {error && <div className="payment-notice error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {success && <div className="payment-notice success" role="status"><span>{success}</span><button aria-label="Dismiss message" onClick={() => setSuccess('')}><X size={15} /></button></div>}

      {!isStaff && <div className="payment-create-actions">
        <button className="primary" onClick={() => startCreate('bank_account')}><Plus size={16} /><CreditCard size={16} /> Add bank account</button>
        <button className="secondary" onClick={() => startCreate('usdt_wallet')}><Plus size={16} /><Wallet size={16} /> Add USDT wallet</button>
      </div>}

      {loading ? <div className="payment-empty">Loading payment methods…</div> : methods.length === 0 ? (
        <div className="payment-empty">{isStaff ? 'No users have saved payment methods yet.' : 'You have not saved any payment methods yet.'}</div>
      ) : (
        <div className="payment-method-list">
          {methods.map((method) => (
            <article className="payment-method-card" key={method.id}>
              <div className="payment-method-card-heading">
                <span className="payment-method-icon">{method.method_type === 'bank_account' ? <CreditCard size={19} /> : <Wallet size={19} />}</span>
                <div>
                  <h2>{method.method_type === 'bank_account' ? method.bank_name : `${method.network} wallet`}</h2>
                  <p>{isStaff ? owners[method.user_id] || 'Registered user' : method.method_type === 'bank_account' ? method.account_holder_name : 'USDT wallet'}</p>
                </div>
                {method.is_default && <span className="default-method"><Star size={13} fill="currentColor" /> Default</span>}
              </div>
              <dl className="payment-method-details">
                {method.method_type === 'bank_account' ? <>
                  <div><dt>Account holder</dt><dd>{method.account_holder_name}</dd></div>
                  <div><dt>Bank</dt><dd>{method.bank_name}</dd></div>
                  <div><dt>Account number</dt><dd>{method.account_number}</dd></div>
                  <div><dt>IFSC code</dt><dd>{method.ifsc_code}</dd></div>
                </> : <>
                  <div><dt>Network</dt><dd>{method.network}</dd></div>
                  <div className="wallet-detail"><dt>Wallet address</dt><dd>{method.wallet_address}</dd></div>
                </>}
              </dl>
              {isStaff && <p className="payment-owner-id">User ID: {method.user_id}</p>}
              {!isStaff && <div className="payment-method-actions">
                {!method.is_default && <button className="table-action" disabled={busy} onClick={() => void makeDefault(method)}><Star size={15} /> Set as default</button>}
                <button className="table-action" disabled={busy} onClick={() => startEdit(method)}>Edit</button>
                <button className="table-action danger" disabled={busy} onClick={() => setConfirmDelete(method)}><Trash2 size={15} /> Delete</button>
              </div>}
            </article>
          ))}
        </div>
      )}

      {!isStaff && showForm && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm(); }}>
          <section className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-form-heading">
            <h2 id="payment-form-heading">{editing ? 'Edit payment method' : form.method_type === 'bank_account' ? 'Add bank account' : 'Add USDT wallet'}</h2>
            <form onSubmit={(event) => void saveMethod(event)}>
              {!editing && <label>Payment method type<select value={form.method_type} onChange={(event) => setForm({ ...blankForm(), method_type: event.target.value as MethodType })}><option value="bank_account">INR bank account</option><option value="usdt_wallet">USDT wallet</option></select></label>}
              {form.method_type === 'bank_account' ? <>
                <label>Account holder name<input required minLength={2} maxLength={120} value={form.account_holder_name} onChange={(event) => setForm({ ...form, account_holder_name: event.target.value })} autoComplete="name" /></label>
                <label>Bank name<input required minLength={2} maxLength={120} value={form.bank_name} onChange={(event) => setForm({ ...form, bank_name: event.target.value })} autoComplete="off" /></label>
                <label>Account number<input required minLength={4} maxLength={34} pattern="[A-Za-z0-9/-]{4,34}" value={form.account_number} onChange={(event) => setForm({ ...form, account_number: event.target.value })} autoComplete="off" /></label>
                <label>IFSC code<input required minLength={11} maxLength={11} pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" value={form.ifsc_code} onChange={(event) => setForm({ ...form, ifsc_code: event.target.value.toUpperCase() })} autoComplete="off" /></label>
              </> : <>
                <label>Wallet address<input required maxLength={42} pattern={form.network === 'TRC20' ? 'T[1-9A-HJ-NP-Za-km-z]{33}' : '0x[0-9A-Fa-f]{40}'} title={form.network === 'TRC20' ? 'Enter a valid TRON address.' : 'Enter a valid EVM wallet address.'} value={form.wallet_address} onChange={(event) => setForm({ ...form, wallet_address: event.target.value })} autoComplete="off" /></label>
                <label>Network<select value={form.network} onChange={(event) => setForm({ ...form, network: event.target.value as Network })}><option value="TRC20">TRC20</option><option value="ERC20">ERC20</option><option value="BEP20">BEP20</option></select></label>
              </>}
              <label className="default-checkbox"><input type="checkbox" checked={form.make_default} onChange={(event) => setForm({ ...form, make_default: event.target.checked })} /> Set as default payment method</label>
              <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={closeForm}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add payment method'}</button></div>
            </form>
          </section>
        </div>
      )}

      {confirmDelete && <div className="dialog-backdrop" role="presentation">
        <section className="management-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-payment-heading">
          <h2 id="delete-payment-heading">Delete payment method?</h2>
          <p>This action permanently removes this saved payment method.</p>
          <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button><button className="danger-button" disabled={busy} onClick={() => void deleteMethod()}>{busy ? 'Deleting…' : 'Delete'}</button></div>
        </section>
      </div>}
    </section>
  );
}
