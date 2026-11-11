import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, RefreshCw, Save, ShieldCheck, Upload } from 'lucide-react';
import { supabase } from './supabase';
import './deposits.css';

type DepositSettings = {
  deposit_usdt_address: string | null;
  deposit_qr_path: string | null;
  deposit_qr_updated_at: string;
};

type DepositProof = {
  id: string;
  user_id: string;
  storage_path: string;
  status: 'pending' | 'verified' | 'rejected';
  created_at: string;
  imageUrl: string;
  ownerName?: string;
  ownerRole?: string;
};

type ProfileSummary = { id: string; full_name: string | null; role: string };

const imageContentTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export default function Deposits({ userId, isSuperAdmin, isStaff }: {
  userId: string;
  isSuperAdmin: boolean;
  isStaff: boolean;
}) {
  const [settings, setSettings] = useState<DepositSettings | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [addressDraft, setAddressDraft] = useState('');
  const [addressDirty, setAddressDirty] = useState(false);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [clearQr, setClearQr] = useState(false);
  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [proofs, setProofs] = useState<DepositProof[]>([]);
  const [copied, setCopied] = useState(false);
  const [uploadUnlocked, setUploadUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [submittingProof, setSubmittingProof] = useState(false);
  const [busyProofId, setBusyProofId] = useState('');
  const [proofProgress, setProofProgress] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qrUrlRef = useRef('');
  const qrRevisionRef = useRef('');

  const loadSettings = useCallback(async () => {
    const { data, error: settingsError } = await supabase.from('company_settings')
      .select('deposit_usdt_address,deposit_qr_path,deposit_qr_updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (settingsError) {
      setError(settingsError.message);
      return;
    }

    const latest: DepositSettings | null = data;
    setSettings(latest);
    if (!addressDirty) setAddressDraft(latest?.deposit_usdt_address || '');

    const qrPath = latest?.deposit_qr_path;
    if (!qrPath) {
      if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
      qrUrlRef.current = '';
      qrRevisionRef.current = '';
      setQrUrl('');
      return;
    }
    const revision = `${qrPath}:${latest.deposit_qr_updated_at}`;
    if (revision === qrRevisionRef.current) return;

    qrRevisionRef.current = revision;
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    qrUrlRef.current = '';
    setQrUrl('');
    const { data: image, error: imageError } = await supabase.storage
      .from('account-documents')
      .download(qrPath);
    if (qrRevisionRef.current !== revision) return;
    if (imageError) {
      qrRevisionRef.current = '';
      setError(`Could not load the company deposit QR code: ${imageError.message}`);
      return;
    }

    const nextUrl = URL.createObjectURL(image);
    qrUrlRef.current = nextUrl;
    setQrUrl(nextUrl);
  }, [addressDirty]);

  const loadProofs = useCallback(async () => {
    let query = supabase.from('deposit_payment_proofs')
      .select('id,user_id,storage_path,status,created_at')
      .order('created_at', { ascending: false })
      .range(0, 49);
    if (!isStaff) query = query.eq('user_id', userId);
    const { data, error: proofsError } = await query;
    if (proofsError) {
      setError(proofsError.message);
      return;
    }

    const rows = data || [];
    let owners: Record<string, ProfileSummary> = {};
    if (isStaff && rows.length) {
      const ownerIds = [...new Set(rows.map((proof) => proof.user_id))];
      const { data: profiles, error: profilesError } = await supabase.from('profiles')
        .select('id,full_name,role')
        .in('id', ownerIds);
      if (profilesError) setError(profilesError.message);
      owners = Object.fromEntries((profiles || []).map((profile) => [profile.id, profile]));
    }

    let imageError = '';
    const loadedProofs = await Promise.all(rows.map(async (proof) => {
      const { data: signed, error: signedError } = await supabase.storage
        .from('account-documents')
        .createSignedUrl(proof.storage_path, 600);
      if (signedError) imageError = signedError.message;
      return {
        ...proof,
        imageUrl: signed?.signedUrl || '',
        ownerName: owners[proof.user_id]?.full_name?.trim() || 'Unnamed user',
        ownerRole: owners[proof.user_id]?.role,
      } as DepositProof;
    }));
    setProofs(loadedProofs);
    if (imageError) setError(`Could not load a payment screenshot: ${imageError}`);
  }, [isStaff, userId]);

  const refresh = useCallback(async () => {
    setError('');
    await Promise.all([loadSettings(), loadProofs()]);
    setLoading(false);
  }, [loadProofs, loadSettings]);

  useEffect(() => {
    void refresh();
    const channel = supabase.channel(`deposit-page-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'company_settings',
        filter: 'id=eq.1',
      }, () => { void loadSettings(); })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'deposit_payment_proofs',
        ...(isStaff ? {} : { filter: `user_id=eq.${userId}` }),
      }, () => { void loadProofs(); })
      .subscribe();
    const refreshInterval = window.setInterval(() => void refresh(), 30000);
    return () => {
      window.clearInterval(refreshInterval);
      void supabase.removeChannel(channel);
    };
  }, [isStaff, loadProofs, loadSettings, refresh, userId]);

  useEffect(() => () => {
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
  }, []);

  useEffect(() => {
    if (!paymentFile) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(paymentFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [paymentFile]);

  async function copyAddress() {
    const address = settings?.deposit_usdt_address;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setUploadUnlocked(true);
      setSuccess('Wallet address copied. You can now upload your payment screenshot.');
      setError('');
    } catch (copyError) {
      setCopied(false);
      setError(copyError instanceof Error ? `Could not copy the address: ${copyError.message}` : 'Could not copy the address. Please try again.');
    }
  }

  function choosePaymentScreenshot(file: File | null) {
    setError('');
    setSuccess('');
    if (!file) {
      setPaymentFile(null);
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (!Object.prototype.hasOwnProperty.call(imageContentTypes, extension) || (file.type && !Object.values(imageContentTypes).includes(file.type))) {
      setPaymentFile(null);
      setError('Choose a JPG, JPEG, PNG, or WEBP image.');
      return;
    }
    setPaymentFile(file);
  }

  async function submitPaymentProof(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isStaff || !uploadUnlocked || !paymentFile) return;
    setSubmittingProof(true);
    setError('');
    setSuccess('');
    setProofProgress('Uploading payment screenshot…');

    const extension = paymentFile.name.split('.').pop()?.toLowerCase() || '';
    const path = `${userId}/deposit-proofs/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('account-documents').upload(path, paymentFile, {
      contentType: imageContentTypes[extension],
      upsert: false,
    });
    if (uploadError) {
      setSubmittingProof(false);
      setProofProgress('');
      setError(`Screenshot upload failed: ${uploadError.message}`);
      return;
    }

    setProofProgress('Submitting proof for verification…');
    const { error: submitError } = await supabase.rpc('submit_deposit_payment_proof', {
      p_storage_path: path,
    });
    setSubmittingProof(false);
    setProofProgress('');
    if (submitError) {
      setError(`Payment proof could not be submitted: ${submitError.message}`);
      return;
    }

    setPaymentFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSuccess('Payment proof submitted. Its status is pending until an employee or Super Admin verifies it. Your balance has not been changed.');
    await loadProofs();
  }

  async function updateProofStatus(proof: DepositProof, status: 'verified' | 'rejected') {
    setBusyProofId(proof.id);
    setError('');
    setSuccess('');
    const { error: updateError } = await supabase.rpc('set_deposit_payment_proof_status', {
      p_proof_id: proof.id,
      p_status: status,
    });
    setBusyProofId('');
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSuccess(`Payment proof marked ${status}. User balances are managed separately.`);
    await loadProofs();
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addressDraft.trim())) {
      setError('Enter a valid USDT TRC20 address.');
      return;
    }
    setSavingSettings(true);
    setError('');
    setSuccess('');

    let uploadedQrPath: string | undefined;
    if (qrFile) {
      const { error: uploadError } = await supabase.storage.from('account-documents').upload(
        'company/deposit-qr.png',
        qrFile,
        { upsert: true, contentType: 'image/png', cacheControl: '0' },
      );
      if (uploadError) {
        setSavingSettings(false);
        setError(`QR upload failed: ${uploadError.message}`);
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
    setSavingSettings(false);
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
          <h1 id="deposit-heading">Make a Deposit</h1>
          <p>Pay securely with USDT using the TRON (TRC20) network.</p>
        </div>
        <button className="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <div className="deposit-message error" role="alert">{error}</div>}
      {success && <div className="deposit-message success" role="status">{success}</div>}

      {loading ? <div className="management-empty">Loading deposit details…</div> : (
        <>
          <div className="deposit-grid">
            <article className="deposit-card deposit-payment-card">
              <div className="deposit-section-heading">
                <span className="deposit-method-icon"><ShieldCheck size={20} /></span>
                <div><h2>USDT (TRC20)</h2><p className="muted">Payment method · TRON network only</p></div>
              </div>

              {isSuperAdmin ? (
                <form className="deposit-form" onSubmit={(event) => void saveSettings(event)}>
                  <label>USDT TRC20 address
                    <input required value={addressDraft} onChange={(event) => { setAddressDraft(event.target.value); setAddressDirty(true); }} placeholder="T..." autoComplete="off" />
                  </label>
                  <label>Deposit QR code (PNG, up to 5 MB)
                    <input type="file" accept="image/png,.png" onChange={(event) => chooseQr(event.target.files?.[0] || null)} />
                  </label>
                  {qrFile && <p className="deposit-file">Selected: {qrFile.name}</p>}
                  {settings?.deposit_qr_path && <button type="button" className="text-btn" onClick={() => { setClearQr(true); setQrFile(null); }}>Remove current QR code</button>}
                  {clearQr && <p className="deposit-file">QR code will be removed when saved.</p>}
                  <button className="primary deposit-action" type="submit" disabled={savingSettings}>
                    {savingSettings ? 'Saving…' : <><Save size={16} /> Save deposit settings</>}
                  </button>
                </form>
              ) : (
                <>
                  <p className="deposit-field-label">Company deposit wallet address</p>
                  <div className="deposit-address">{settings?.deposit_usdt_address || 'Deposit address not set yet.'}</div>
                  <button className="primary deposit-action" type="button" onClick={() => void copyAddress()} disabled={!settings?.deposit_usdt_address}>
                    {copied ? <Check size={18} /> : <Copy size={18} />}
                    {copied ? 'ADDRESS COPIED' : 'COPY ADDRESS'}
                  </button>
                </>
              )}

              {qrUrl ? (
                <figure className="deposit-qr">
                  <img src={qrUrl} alt="Company USDT TRC20 deposit QR code" />
                  <figcaption>Scan this code with your wallet to enter the deposit address.</figcaption>
                </figure>
              ) : (
                <div className="deposit-qr-empty">{settings?.deposit_qr_path ? 'The deposit QR code could not be loaded.' : 'A deposit QR code has not been added yet.'}</div>
              )}

              {!isStaff && (
                <div className="deposit-confirm">
                  <p>Already scanned the payment QR code?</p>
                  <button className="secondary deposit-action" type="button" onClick={() => {
                    setUploadUnlocked(true);
                    setSuccess('QR scan confirmed. You can now upload your payment screenshot.');
                    setError('');
                  }}>
                    I&apos;ve Scanned the QR Code
                  </button>
                </div>
              )}
            </article>

            {!isStaff && (
              <article className="deposit-card deposit-proof-card">
                <h2>Upload payment screenshot</h2>
                <p className="muted">Attach a clear screenshot of your completed transfer for company verification.</p>
                {!uploadUnlocked && <p className="deposit-locked" role="status">Copy the wallet address or confirm your QR scan to unlock screenshot upload.</p>}
                <form onSubmit={(event) => void submitPaymentProof(event)}>
                  <input
                    ref={fileInputRef}
                    className="visually-hidden"
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                    disabled={!uploadUnlocked || submittingProof}
                    onChange={(event) => choosePaymentScreenshot(event.target.files?.[0] || null)}
                  />
                  <button
                    className="secondary deposit-action"
                    type="button"
                    disabled={!uploadUnlocked || submittingProof}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={18} /> Choose screenshot
                  </button>
                  <p className="deposit-file">Accepted image formats: JPG, JPEG, PNG, and WEBP.</p>
                  {paymentFile && <p className="deposit-file">Selected: {paymentFile.name}</p>}
                  {previewUrl && <figure className="deposit-preview"><img src={previewUrl} alt="Payment screenshot preview" /></figure>}
                  {proofProgress && <p className="deposit-progress" role="status">{proofProgress}</p>}
                  <button className="primary deposit-action" type="submit" disabled={!uploadUnlocked || !paymentFile || submittingProof}>
                    {submittingProof ? 'Submitting…' : 'SUBMIT PAYMENT PROOF'}
                  </button>
                </form>
                <p className="deposit-pending-note">Your payment remains pending until verified by an employee or Super Admin. Submitting proof does not add funds to your balance.</p>
              </article>
            )}
          </div>

          <section className="deposit-instructions" aria-labelledby="deposit-instructions-heading">
            <h2 id="deposit-instructions-heading">DEPOSIT INSTRUCTIONS</h2>
            <ol>
              <li>Copy the USDT TRC20 wallet address or scan the QR code.</li>
              <li>Open your crypto wallet and send USDT using the TRON (TRC20) network only.</li>
              <li>Make sure the network is TRC20 before confirming the transfer.</li>
              <li>Upload a clear screenshot showing the completed payment.</li>
              <li>Submit your payment proof.</li>
              <li>Wait for the company team to verify your payment.</li>
            </ol>
            <p className="deposit-warning">IMPORTANT: Sending funds through the wrong network may result in loss of funds.</p>
          </section>

          <section className="deposit-proof-list-section">
            <div className="deposit-list-heading">
              <div>
                <h2>{isStaff ? 'Payment proofs to verify' : 'Your payment proofs'}</h2>
                <p className="muted">{isStaff ? 'Verify submitted payment screenshots. Verification does not change user balances.' : 'Track the verification status of your submitted payments.'}</p>
              </div>
            </div>
            {proofs.length === 0 ? (
              <div className="deposit-proof-empty">{isStaff ? 'There are no payment proofs to review.' : 'You have not submitted any payment proofs.'}</div>
            ) : (
              <div className="deposit-proof-list">
                {proofs.map((proof) => (
                  <article className="deposit-proof-item" key={proof.id}>
                    <div className="deposit-proof-heading">
                      <div>
                        {isStaff && <strong>{proof.ownerName}</strong>}
                        <small>{new Date(proof.created_at).toLocaleString()}</small>
                      </div>
                      <span className={`deposit-proof-status status-${proof.status}`}>{proof.status}</span>
                    </div>
                    {proof.imageUrl ? <a href={proof.imageUrl} target="_blank" rel="noreferrer"><img src={proof.imageUrl} alt="Submitted payment screenshot" /></a> : <p className="deposit-file">Screenshot unavailable. Refresh to try again.</p>}
                    {isStaff && proof.status === 'pending' && (isSuperAdmin || proof.ownerRole === 'user') && (
                      <div className="deposit-review-actions">
                        <button className="primary" type="button" disabled={busyProofId === proof.id} onClick={() => void updateProofStatus(proof, 'verified')}>
                          {busyProofId === proof.id ? 'Saving…' : 'Mark verified'}
                        </button>
                        <button className="secondary" type="button" disabled={busyProofId === proof.id} onClick={() => void updateProofStatus(proof, 'rejected')}>
                          Reject proof
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          {isSuperAdmin && (
            <section className="deposit-admin-note">
              <h2>Deposit settings</h2>
              <p>Update the shared wallet address or QR code above. Payment verification never automatically changes user balances.</p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
