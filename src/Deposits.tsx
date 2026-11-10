import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, Save, Wallet } from 'lucide-react';
import { supabase } from './supabase';
import './deposits.css';

type DepositSettings = {
  deposit_usdt_address: string | null;
  deposit_qr_path: string | null;
};

type UserBalance = {
  balance_usdt: string;
  balance_inr: string;
};

export default function Deposits({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  const [settings, setSettings] = useState<DepositSettings | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [addressDraft, setAddressDraft] = useState('');
  const [addressDirty, setAddressDirty] = useState(false);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [clearQr, setClearQr] = useState(false);
  const [balance, setBalance] = useState<UserBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadSettings = useCallback(async () => {
    const { data, error: settingsError } = await supabase.from('company_settings')
      .select('deposit_usdt_address,deposit_qr_path')
      .eq('id', 1)
      .maybeSingle();
    if (settingsError) {
      setError(settingsError.message);
      return;
    }

    const latest: DepositSettings = data || { deposit_usdt_address: null, deposit_qr_path: null };
    setSettings(latest);
    if (!addressDirty) setAddressDraft(latest.deposit_usdt_address || '');
    if (latest.deposit_qr_path) {
      const { data: signed, error: signedError } = await supabase.storage
        .from('account-documents')
        .createSignedUrl(latest.deposit_qr_path, 300);
      if (signedError) {
        setQrUrl('');
        setError(signedError.message);
      } else {
        setQrUrl(signed.signedUrl);
      }
    } else {
      setQrUrl('');
    }
  }, [addressDirty]);

  const loadBalance = useCallback(async () => {
    const { data, error: balanceError } = await supabase.from('user_balances')
      .select('balance_usdt,balance_inr')
      .eq('user_id', userId)
      .maybeSingle();
    if (balanceError) {
      setError(balanceError.message);
      return;
    }
    setBalance(data ? {
      balance_usdt: String(data.balance_usdt),
      balance_inr: String(data.balance_inr),
    } : null);
  }, [userId]);

  const refresh = useCallback(async () => {
    setError('');
    await Promise.all([loadSettings(), loadBalance()]);
    setLoading(false);
  }, [loadBalance, loadSettings]);

  useEffect(() => {
    void refresh();
    const channel = supabase.channel(`deposit-balances-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'company_settings', filter: 'id=eq.1' }, () => {
        void loadSettings();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_balances', filter: `user_id=eq.${userId}` }, () => {
        void loadBalance();
      })
      .subscribe();
    const refreshInterval = window.setInterval(() => void refresh(), 30000);
    return () => {
      window.clearInterval(refreshInterval);
      void supabase.removeChannel(channel);
    };
  }, [loadBalance, loadSettings, refresh, userId]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addressDraft.trim())) {
      setError('Enter a valid USDT TRC20 address.');
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');

    let uploadedQrPath: string | undefined;
    if (qrFile) {
      const { error: uploadError } = await supabase.storage.from('account-documents').upload(
        'company/deposit-qr.png',
        qrFile,
        { upsert: true, contentType: 'image/png' },
      );
      if (uploadError) {
        setBusy(false);
        setError(uploadError.message);
        return;
      }
      uploadedQrPath = 'company/deposit-qr.png';
    }

    const payload: { action: string; depositAddress: string; depositQrPath?: string | null } = {
      action: 'update_deposit_settings',
      depositAddress: addressDraft.trim(),
    };
    if (uploadedQrPath) payload.depositQrPath = uploadedQrPath;
    else if (clearQr) payload.depositQrPath = null;

    const { data, error: invokeError } = await supabase.functions.invoke('user-management', { body: payload });
    setBusy(false);
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not save deposit settings.');
      return;
    }
    setQrFile(null);
    setClearQr(false);
    setAddressDirty(false);
    setSuccess('Deposit settings saved.');
    setAddressDraft(addressDraft.trim());
    await refresh();
  }

  function chooseQr(file: File | null) {
    setError('');
    if (file && (file.type !== 'image/png' || file.size > 5 * 1024 * 1024)) {
      setQrFile(null);
      setError('Choose a PNG QR code no larger than 5 MB.');
      return;
    }
    setQrFile(file);
    if (file) setClearQr(false);
  }

  return (
    <section className="deposit-management" aria-labelledby="deposit-heading">
      <div className="deposit-heading">
        <div>
          <div className="eyebrow">PAYMENT INFORMATION</div>
          <h1 id="deposit-heading">Deposit address & balances</h1>
          <p>Use the shared company USDT address. Your balances are managed by the company.</p>
        </div>
        <button className="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <div className="deposit-message error" role="alert">{error}</div>}
      {success && <div className="deposit-message success" role="status">{success}</div>}
      {loading ? <div className="management-empty">Loading deposit details…</div> : (
        <div className="deposit-grid">
          <article className="deposit-card">
            <h2>Company USDT deposit address</h2>
            <p className="muted">Network: TRON (TRC20). Confirm the network before sending funds.</p>
            {isSuperAdmin ? (
              <form className="deposit-form" onSubmit={(event) => void saveSettings(event)}>
                <label>USDT TRC20 address
                  <input required value={addressDraft} onChange={(event) => { setAddressDraft(event.target.value); setAddressDirty(true); }} placeholder="T..." autoComplete="off" />
                </label>
                <label>Deposit QR code (PNG, up to 5 MB)
                  <input type="file" accept="image/png" onChange={(event) => chooseQr(event.target.files?.[0] || null)} />
                </label>
                {qrFile && <p className="deposit-file">Selected: {qrFile.name}</p>}
                {settings?.deposit_qr_path && <button type="button" className="text-btn" onClick={() => { setClearQr(true); setQrFile(null); }}>Remove current QR code</button>}
                {clearQr && <p className="deposit-file">QR code will be removed when saved.</p>}
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : <><Save size={16} /> Save deposit settings</>}
                </button>
              </form>
            ) : (
              <div className="deposit-address">{settings?.deposit_usdt_address || 'Deposit address not set yet.'}</div>
            )}
            {qrUrl && <figure className="deposit-qr"><img src={qrUrl} alt="Company USDT TRC20 deposit QR code" /><figcaption>Scan to view the shared company deposit address.</figcaption></figure>}
            {!qrUrl && !isSuperAdmin && <p className="deposit-file">A deposit QR code has not been added yet.</p>}
          </article>

          <article className="deposit-card balance-card">
            <span className="balance-icon"><Wallet size={19} /></span>
            <h2>Your current balances</h2>
            <p className="muted">Only you can view your balances.</p>
            <dl className="balance-list">
              <div><dt>USDT</dt><dd>{balance ? `${balance.balance_usdt} USDT` : 'Not set'}</dd></div>
              <div><dt>INR</dt><dd>{balance ? `₹${balance.balance_inr}` : 'Not set'}</dd></div>
            </dl>
          </article>
        </div>
      )}
    </section>
  );
}
