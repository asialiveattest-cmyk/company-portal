import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowUpFromLine, RefreshCw } from 'lucide-react';
import { supabase } from './supabase';
import './withdrawal-requests.css';

type Currency = 'INR' | 'USDT';
type RequestStatus = 'pending' | 'processing' | 'paid' | 'rejected';
type PaymentMethod = {
  id: string;
  method_type: 'bank_account' | 'usdt_wallet';
  account_holder_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  ifsc_code: string | null;
  wallet_address: string | null;
  network: string | null;
  is_default: boolean;
};
type WithdrawalRequest = {
  id: string;
  user_id: string;
  currency: Currency;
  amount: string;
  payment_method_id: string | null;
  payment_method_snapshot: Record<string, string | null>;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
};
type Owner = { full_name: string | null; role: string };
const statuses: RequestStatus[] = ['pending', 'processing', 'paid', 'rejected'];
const currencyDecimals: Record<Currency, number> = { INR: 2, USDT: 6 };

function displayAmount(amount: string, currency: Currency) {
  return `${amount} ${currency}`;
}

function displayMethod(method: Record<string, string | null>) {
  if (method.method_type === 'bank_account') {
    return [
      method.account_holder_name && `Account holder: ${method.account_holder_name}`,
      method.bank_name && `Bank: ${method.bank_name}`,
      method.account_number && `Account number: ${method.account_number}`,
      method.ifsc_code && `IFSC: ${method.ifsc_code}`,
    ].filter(Boolean);
  }
  return [
    method.network && `Network: ${method.network}`,
    method.wallet_address && `Wallet: ${method.wallet_address}`,
  ].filter(Boolean);
}

export default function WithdrawalRequests({ userId, isStaff, isSuperAdmin }: {
  userId: string;
  isStaff: boolean;
  isSuperAdmin: boolean;
}) {
  const [requests, setRequests] = useState<WithdrawalRequest[]>([]);
  const [owners, setOwners] = useState<Record<string, Owner>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [balance, setBalance] = useState<{ INR: string; USDT: string } | null>(null);
  const [currency, setCurrency] = useState<Currency>('INR');
  const [amount, setAmount] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    const requestQuery = (async () => {
      const allRequests: WithdrawalRequest[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: pageError } = await supabase.from('withdrawal_requests')
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, from + 999);
        if (pageError) return { data: null, error: pageError };
        allRequests.push(...((data || []) as WithdrawalRequest[]));
        if (!data || data.length < 1000) break;
      }
      return { data: allRequests, error: null };
    })();
    const [requestResult, methodResult, balanceResult] = await Promise.all([
      requestQuery,
      isStaff
        ? Promise.resolve({ data: [], error: null })
        : supabase.from('payment_methods').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      isStaff
        ? Promise.resolve({ data: null, error: null })
        : supabase.from('user_balances').select('balance_usdt,balance_inr').eq('user_id', userId).maybeSingle(),
    ]);

    if (requestResult.error || methodResult.error || balanceResult.error) {
      setError(requestResult.error?.message || methodResult.error?.message || balanceResult.error?.message || 'Could not load withdrawal details.');
      setLoading(false);
      return;
    }

    const rows = (requestResult.data || []) as WithdrawalRequest[];
    setRequests(rows);
    setMethods((methodResult.data || []) as PaymentMethod[]);
    setBalance(balanceResult.data ? {
      INR: String(balanceResult.data.balance_inr),
      USDT: String(balanceResult.data.balance_usdt),
    } : null);

    if (isStaff && rows.length) {
      const ownerIds = [...new Set(rows.map((request) => request.user_id))];
      const profiles = [];
      for (let from = 0; from < ownerIds.length; from += 1000) {
        const { data, error: profileError } = await supabase.from('profiles')
          .select('id,full_name,role')
          .in('id', ownerIds.slice(from, from + 1000));
        if (profileError) {
          setError(profileError.message);
          break;
        }
        profiles.push(...(data || []));
      }
      setOwners(Object.fromEntries(profiles.map((profile) => [
        profile.id,
        { full_name: profile.full_name, role: profile.role },
      ])));
    } else {
      setOwners({});
    }
    setLoading(false);
  }, [isStaff, userId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const compatibleMethods = useMemo(() => methods.filter((method) =>
    currency === 'INR' ? method.method_type === 'bank_account' : method.method_type === 'usdt_wallet',
  ), [currency, methods]);
  const reserved = useMemo(() => requests
    .filter((request) => request.currency === currency && ['pending', 'processing'].includes(request.status))
    .reduce((total, request) => total + Number(request.amount), 0), [currency, requests]);
  const displayedAvailable = balance
    ? Math.max(0, Number(balance[currency]) - reserved).toFixed(currencyDecimals[currency])
    : null;

  useEffect(() => {
    setPaymentMethodId(compatibleMethods.find((method) => method.is_default)?.id || compatibleMethods[0]?.id || '');
  }, [compatibleMethods]);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isStaff) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { data, error: submitError } = await supabase.rpc('create_withdrawal_request', {
      p_currency: currency,
      p_amount: amount,
      p_payment_method_id: paymentMethodId,
    });
    setBusy(false);
    if (submitError) {
      setError(submitError.message);
      return;
    }
    if (!data) {
      setError('The withdrawal request could not be confirmed.');
      return;
    }
    setAmount('');
    setSuccess('Withdrawal request submitted.');
    await loadData();
  }

  async function updateStatus(request: WithdrawalRequest, status: RequestStatus) {
    setBusyRequestId(request.id);
    setError('');
    setSuccess('');
    const { error: updateError } = await supabase.rpc('set_withdrawal_request_status', {
      p_request_id: request.id,
      p_status: status,
    });
    setBusyRequestId('');
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSuccess(`Request status updated to ${status}.`);
    await loadData();
  }

  return (
    <section className="withdrawals" aria-labelledby="withdrawals-heading">
      <div className="withdrawals-heading">
        <div>
          <div className="eyebrow">{isStaff ? 'REQUEST MANAGEMENT' : 'YOUR ACCOUNT'}</div>
          <h1 id="withdrawals-heading">{isStaff ? 'Withdrawal requests' : 'Withdrawals'}</h1>
          <p>{isStaff ? 'Review requests and update their processing status.' : 'Request a payout to one of your saved payment methods.'}</p>
        </div>
        <button className="secondary" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <div className="withdrawal-message error" role="alert">{error}</div>}
      {success && <div className="withdrawal-message success" role="status">{success}</div>}

      {!isStaff && (
        <div className="withdrawal-grid">
          <article className="withdrawal-card withdrawal-form-card">
            <h2>Submit a withdrawal request</h2>
            <p className="muted">Pending and processing requests are reserved from your available balance.</p>
            <form onSubmit={(event) => void submitRequest(event)}>
              <label>Currency
                <select value={currency} onChange={(event) => { setCurrency(event.target.value as Currency); setPaymentMethodId(''); }}>
                  <option value="INR">INR</option>
                  <option value="USDT">USDT</option>
                </select>
              </label>
              <label>Withdrawal amount
                <input
                  required
                  type="number"
                  min={currency === 'INR' ? '0.01' : '0.000001'}
                  step={currency === 'INR' ? '0.01' : '0.000001'}
                  max={displayedAvailable || undefined}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder={currency === 'INR' ? '0.00' : '0.000000'}
                />
              </label>
              <label>Saved {currency === 'INR' ? 'bank account' : 'USDT wallet'}
                <select required value={paymentMethodId} onChange={(event) => setPaymentMethodId(event.target.value)}>
                  <option value="">Select a saved payment method</option>
                  {compatibleMethods.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.method_type === 'bank_account'
                        ? `${method.bank_name} •••• ${method.account_number?.slice(-4)}${method.is_default ? ' (Default)' : ''}`
                        : `${method.network} • ${method.wallet_address?.slice(0, 8)}…${method.is_default ? ' (Default)' : ''}`}
                    </option>
                  ))}
                </select>
              </label>
              <p className="withdrawal-available">
                Available balance: <strong>{displayedAvailable === null ? 'Not set' : displayAmount(displayedAvailable, currency)}</strong>
              </p>
              {!compatibleMethods.length && <p className="withdrawal-hint">Add a matching payment method before submitting a request.</p>}
              <button className="primary" type="submit" disabled={busy || !paymentMethodId || !amount || !balance}>
                <ArrowUpFromLine size={16} /> {busy ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          </article>
        </div>
      )}

      <div className="withdrawal-list-heading">
        <h2>{isStaff ? 'All user requests' : 'Your requests'}</h2>
        {!isStaff && <span>{reserved.toFixed(currencyDecimals[currency])} {currency} reserved</span>}
      </div>
      {loading ? <div className="withdrawal-empty">Loading withdrawal requests…</div> : requests.length === 0 ? (
        <div className="withdrawal-empty">{isStaff ? 'There are no withdrawal requests yet.' : 'You have not submitted any withdrawal requests.'}</div>
      ) : (
        <div className="withdrawal-list">
          {requests.map((request) => {
            const methodDetails = displayMethod(request.payment_method_snapshot || {});
            const owner = owners[request.user_id];
            const canManage = isStaff && (isSuperAdmin || owner?.role === 'user');
            return (
              <article className="withdrawal-request-card" key={request.id}>
                <div className="withdrawal-request-heading">
                  <div>
                    <strong>{displayAmount(request.amount, request.currency)}</strong>
                    <small>{new Date(request.created_at).toLocaleString()}</small>
                  </div>
                  {canManage ? (
                    <label className="withdrawal-status-control">
                      <span className={`withdrawal-status status-${request.status}`}>{request.status}</span>
                      <select
                        aria-label={`Update status for ${owner?.full_name || 'user'} withdrawal`}
                        value={request.status}
                        disabled={busyRequestId === request.id || request.status === 'paid'}
                        onChange={(event) => void updateStatus(request, event.target.value as RequestStatus)}
                      >
                        {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                      </select>
                    </label>
                  ) : <span className={`withdrawal-status status-${request.status}`}>{request.status}</span>}
                </div>
                {isStaff && <p className="withdrawal-owner">{owner?.full_name?.trim() || 'Unnamed user'} · {owner?.role?.replace('_', ' ') || 'User'} · {request.user_id}</p>}
                <div className="withdrawal-method">
                  <span>{request.currency === 'INR' ? 'Bank account' : 'USDT wallet'}</span>
                  {methodDetails.map((detail) => <small key={detail}>{detail}</small>)}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
