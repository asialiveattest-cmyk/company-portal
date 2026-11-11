import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ArrowLeft, Download, FileVideo2, RefreshCw, ShieldCheck, Smartphone, UploadCloud } from 'lucide-react';
import { Upload as TusUpload } from 'tus-js-client';
import { supabase } from './supabase';
import './test-otp.css';

type TestOtpAsset = {
  asset_type: 'apk' | 'video';
  storage_path: string;
  file_name: string;
  uploaded_by: string;
  uploaded_at: string;
  download_url: string;
};

type SubmittedAccount = {
  id: string;
  bank_name: string | null;
  account_type: string | null;
  ifsc_code: string | null;
  customer_id: string | null;
  user_id_text: string | null;
  account_number: string | null;
  mobile_number: string | null;
};

type Completion = {
  user_id: string;
  account_submission_id: string;
  completed_at: string;
};

type CompletionDisplay = Completion & {
  user_name: string;
  account: SubmittedAccount | null;
};

type AssetType = 'apk' | 'video';

const videoTypes: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

const assetLabels: Record<AssetType, string> = {
  apk: 'Test application APK',
  video: 'Instruction video',
};

function safeFileName(fileName: string) {
  const safe = fileName.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.slice(-180) || 'test-file';
}

export default function TestOtp({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  const [accounts, setAccounts] = useState<SubmittedAccount[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [assets, setAssets] = useState<TestOtpAsset[]>([]);
  const [completionRecords, setCompletionRecords] = useState<CompletionDisplay[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<SubmittedAccount | null>(null);
  const [setupAccountId, setSetupAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<AssetType | ''>('');
  const [uploadProgress, setUploadProgress] = useState<Record<AssetType, number>>({ apk: 0, video: 0 });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadAssets = useCallback(async () => {
    const { data, error: assetsError } = await supabase.from('test_otp_assets')
      .select('asset_type,storage_path,file_name,uploaded_by,uploaded_at')
      .order('uploaded_at', { ascending: false });
    if (assetsError) {
      setError(assetsError.message);
      return;
    }

    const results = await Promise.all((data || []).map(async (asset) => {
      const { data: signed, error: signedError } = await supabase.storage
        .from('account-documents')
        .createSignedUrl(
          asset.storage_path,
          3600,
          asset.asset_type === 'apk' ? { download: asset.file_name } : undefined,
        );
      if (signedError) {
        setError(`Could not prepare authenticated download for ${asset.file_name}: ${signedError.message}`);
      }
      return {
        ...asset,
        asset_type: asset.asset_type as AssetType,
        download_url: signed?.signedUrl || '',
      };
    }));
    setAssets(results);
  }, []);

  const loadUserData = useCallback(async () => {
    if (isSuperAdmin) return;
    const [accountResult, completionResult] = await Promise.all([
      supabase.from('account_submissions')
        .select('id,bank_name,account_type,ifsc_code,customer_id,user_id_text,account_number,mobile_number')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase.from('test_otp_completions')
        .select('user_id,account_submission_id,completed_at')
        .eq('user_id', userId),
    ]);
    if (accountResult.error || completionResult.error) {
      setError(accountResult.error?.message || completionResult.error?.message || 'Could not load Test OTP details.');
      return;
    }
    setAccounts((accountResult.data || []) as SubmittedAccount[]);
    setCompletions((completionResult.data || []) as Completion[]);
  }, [isSuperAdmin, userId]);

  const loadAdminCompletions = useCallback(async () => {
    if (!isSuperAdmin) return;
    const rows: Completion[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: queryError } = await supabase.from('test_otp_completions')
        .select('user_id,account_submission_id,completed_at')
        .order('completed_at', { ascending: false })
        .range(from, from + 999);
      if (queryError) {
        setError(queryError.message);
        return;
      }
      rows.push(...((data || []) as Completion[]));
      if (!data || data.length < 1000) break;
    }

    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const accountIds = [...new Set(rows.map((row) => row.account_submission_id))];
    const [profiles, accountRows] = await Promise.all([
      userIds.length
        ? supabase.from('profiles').select('id,full_name').in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
      accountIds.length
        ? supabase.from('account_submissions')
          .select('id,bank_name,account_type,ifsc_code,customer_id,user_id_text,account_number,mobile_number')
          .in('id', accountIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (profiles.error || accountRows.error) {
      setError(profiles.error?.message || accountRows.error?.message || 'Could not load completion details.');
      return;
    }
    const profileNames = Object.fromEntries((profiles.data || []).map((profile) => [profile.id, profile.full_name || 'Unnamed user']));
    const accountsById = Object.fromEntries(((accountRows.data || []) as SubmittedAccount[]).map((account) => [account.id, account]));
    setCompletionRecords(rows.map((row) => ({
      ...row,
      user_name: profileNames[row.user_id] || 'Unknown user',
      account: accountsById[row.account_submission_id] || null,
    })));
  }, [isSuperAdmin]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    await Promise.all([loadAssets(), loadUserData(), loadAdminCompletions()]);
    setLoading(false);
  }, [loadAdminCompletions, loadAssets, loadUserData]);

  useEffect(() => {
    void refresh();
    const channel = supabase.channel(`test-otp-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'test_otp_assets' }, () => {
        void loadAssets();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'test_otp_completions' }, () => {
        void loadUserData();
        void loadAdminCompletions();
      })
      .subscribe();
    const interval = window.setInterval(() => {
      void loadAssets();
      void loadUserData();
      void loadAdminCompletions();
    }, 60000);
    return () => {
      window.clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [loadAdminCompletions, loadAssets, loadUserData, refresh, userId]);

  const assetsByType = useMemo(() => Object.fromEntries(
    assets.map((asset) => [asset.asset_type, asset]),
  ) as Partial<Record<AssetType, TestOtpAsset>>, [assets]);
  const completedAccountIds = useMemo(() => new Set(completions.map((row) => row.account_submission_id)), [completions]);

  function showSetup(account: SubmittedAccount) {
    setSelectedAccount(account);
    setSetupAccountId(account.id);
    setError('');
    setSuccess('');
  }

  async function completeInstallation() {
    if (!selectedAccount || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const { error: completionError } = await supabase.rpc('complete_test_otp_installation', {
      p_account_submission_id: selectedAccount.id,
    });
    setBusy(false);
    if (completionError) {
      setError(completionError.message);
      return;
    }
    const accountName = selectedAccount.bank_name || selectedAccount.account_type || 'selected account';
    setSuccess(`Test OTP installation recorded for ${accountName}.`);
    setSelectedAccount(null);
    setSetupAccountId('');
    await Promise.all([loadUserData(), loadAdminCompletions()]);
  }

  async function uploadAsset(type: AssetType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (type === 'apk' && !file.name.toLowerCase().endsWith('.apk')) {
      setError('Choose an APK file.');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (type === 'video' && !Object.prototype.hasOwnProperty.call(videoTypes, extension)) {
      setError('Choose an MP4, WEBM, MOV, or M4V instruction video.');
      return;
    }
    const contentType = type === 'apk'
      ? 'application/vnd.android.package-archive'
      : file.type.startsWith('video/') ? file.type : videoTypes[extension];
    const objectName = `test-otp/${type}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    setUploading(type);
    setUploadProgress((current) => ({ ...current, [type]: 0 }));
    setError('');
    setSuccess('');

    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!session?.access_token) throw new Error('Your session has expired. Sign in again to upload a file.');

      const fingerprint = async (uploadFile: File) =>
        `company-portal-test-otp:${userId}:${type}:${uploadFile.name}:${uploadFile.size}:${uploadFile.lastModified}`;
      const upload = new TusUpload(file, {
        endpoint: `${import.meta.env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/upload/resumable`,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        metadata: {
          bucketName: 'account-documents',
          objectName,
          contentType,
          cacheControl: '3600',
        },
        chunkSize: 6 * 1024 * 1024,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        fingerprint,
        onProgress: (sent, total) => {
          setUploadProgress((current) => ({ ...current, [type]: total ? Math.floor((sent / total) * 100) : 0 }));
        },
      });

      const previous = await upload.findPreviousUploads();
      const resumable = previous.find((item) => item.metadata.objectName?.startsWith(`test-otp/${type}/`));
      let uploadPath = objectName;
      const resumablePath = resumable?.metadata.objectName;
      if (resumable && resumablePath) {
        uploadPath = resumablePath;
        upload.resumeFromPreviousUpload(resumable);
      }
      await new Promise<void>((resolve, reject) => {
        upload.options.onError = reject;
        upload.options.onSuccess = () => resolve();
        upload.start();
      });

      const { error: saveError } = await supabase.rpc('set_test_otp_asset', {
        p_asset_type: type,
        p_storage_path: uploadPath,
        p_file_name: file.name,
      });
      if (saveError) {
        throw new Error(`The file uploaded but its metadata could not be saved: ${saveError.message}`);
      }
      setSuccess(`${assetLabels[type]} uploaded and is now available to users.`);
      await Promise.all([loadAssets(), loadAdminCompletions()]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : `Could not upload the ${assetLabels[type].toLowerCase()}.`);
    } finally {
      setUploading('');
    }
  }

  const accountLabel = (account: SubmittedAccount) =>
    [account.bank_name, account.account_type, account.account_number && `•••• ${account.account_number.slice(-4)}`]
      .filter(Boolean)
      .join(' · ') || 'Submitted account';

  return (
    <section className="test-otp" aria-labelledby="test-otp-heading">
      <div className="test-otp-heading">
        <div>
          <div className="eyebrow">{isSuperAdmin ? 'TEST OTP MANAGEMENT' : 'ACCOUNT TOOLS'}</div>
          <h1 id="test-otp-heading">{isSuperAdmin ? 'Test OTP Management' : selectedAccount ? 'Test OTP setup' : 'TEST OTP'}</h1>
          <p>{isSuperAdmin ? 'Publish private test-app files and review installation completions.' : selectedAccount ? 'Install the test app for the account selected below.' : 'Select one of your submitted accounts to set up the test app.'}</p>
        </div>
        <button className="secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <div className="test-otp-message error" role="alert">{error}</div>}
      {success && <div className="test-otp-message success" role="status">{success}</div>}

      {loading ? <div className="test-otp-empty">Loading Test OTP details…</div> : isSuperAdmin ? (
        <div className="test-otp-admin">
          <div className="test-otp-admin-grid">
            {(['apk', 'video'] as const).map((type) => {
              const asset = assetsByType[type];
              return (
                <article className="test-otp-card" key={type}>
                  <div className="test-otp-card-title">
                    <span>{type === 'apk' ? <Smartphone size={20} /> : <FileVideo2 size={20} />}</span>
                    <div><h2>{assetLabels[type]}</h2><p>{type === 'apk' ? 'Original APK file · no application size limit' : 'MP4, WEBM, MOV, or M4V'}</p></div>
                  </div>
                  {asset ? (
                    <div className="test-otp-current-file">
                      <strong>{asset.file_name}</strong>
                      <span>Uploaded {new Date(asset.uploaded_at).toLocaleString()}</span>
                      {asset.download_url && <a href={asset.download_url} target="_blank" rel="noreferrer" download={asset.file_name}><Download size={15} /> View current file</a>}
                    </div>
                  ) : <p className="test-otp-no-file">No {type === 'apk' ? 'APK' : 'instruction video'} uploaded yet.</p>}
                  <label className="test-otp-upload-label">
                    <input
                      type="file"
                      accept={type === 'apk' ? '.apk,application/vnd.android.package-archive' : 'video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v'}
                      disabled={uploading !== ''}
                      onChange={(event) => void uploadAsset(type, event)}
                    />
                    <span><UploadCloud size={18} /> {uploading === type ? 'Uploading…' : asset ? 'Replace file' : 'Upload file'}</span>
                  </label>
                  {uploading === type && (
                    <div className="test-otp-progress">
                      <div><span>Uploading original file</span><strong>{uploadProgress[type]}%</strong></div>
                      <progress max="100" value={uploadProgress[type]} />
                    </div>
                  )}
                  {type === 'apk' && <p className="test-otp-hint">Resumable upload retries interrupted transfers. Supabase Storage quotas and limits still apply.</p>}
                </article>
              );
            })}
          </div>

          <section className="test-otp-completions">
            <div className="test-otp-section-heading"><h2>Installation completions</h2><span>{completionRecords.length} recorded</span></div>
            {completionRecords.length === 0 ? <div className="test-otp-empty">No users have recorded a completed installation yet.</div> : (
              <div className="test-otp-record-list">
                {completionRecords.map((record) => (
                  <article className="test-otp-record" key={`${record.user_id}-${record.account_submission_id}`}>
                    <div><strong>{record.user_name}</strong><span>{record.account ? accountLabel(record.account) : 'Account details unavailable'}</span></div>
                    <time>{new Date(record.completed_at).toLocaleString()}</time>
                  </article>
                ))}
              </div>
            )}
          </section>
          <p className="test-otp-safety"><ShieldCheck size={16} /> Installation testing only. Do not collect, enter, or forward real SMS OTPs; use only the test app’s safe test-code verification.</p>
        </div>
      ) : selectedAccount ? (
        <div className="test-otp-setup">
          <button className="secondary test-otp-back" type="button" onClick={() => { setSelectedAccount(null); setSetupAccountId(''); }}>
            <ArrowLeft size={16} /> Back to submitted accounts
          </button>
          <article className="test-otp-card test-otp-account-details">
            <h2>Selected account</h2>
            <dl>
              {[
                ['Bank', selectedAccount.bank_name],
                ['Account type', selectedAccount.account_type],
                ['Account number', selectedAccount.account_number],
                ['IFSC', selectedAccount.ifsc_code],
                ['Customer ID', selectedAccount.customer_id],
                ['User ID', selectedAccount.user_id_text],
                ['Mobile number', selectedAccount.mobile_number],
              ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          </article>

          <article className="test-otp-card test-otp-download-card">
            <h2>Install the test app</h2>
            <p>Download the latest test application and follow the instruction video. This test does not use or collect real SMS OTPs.</p>
            {assetsByType.apk?.download_url ? (
              <a className="primary test-otp-download" href={assetsByType.apk.download_url} download={assetsByType.apk.file_name}>
                <Download size={18} /> DOWNLOAD APK
              </a>
            ) : <p className="test-otp-no-file">The test APK has not been uploaded yet.</p>}
          </article>

          <article className="test-otp-card test-otp-video-card">
            <h2>Instruction video</h2>
            {assetsByType.video?.download_url ? (
              <video controls preload="metadata" src={assetsByType.video.download_url}>
                Your browser does not support video playback.
              </video>
            ) : <p className="test-otp-no-file">The instruction video has not been uploaded yet.</p>}
          </article>

          <div className="test-otp-privacy-note">
            <ShieldCheck size={18} />
            <p>Use this app only for the test flow. Never enter, share, or send real SMS OTPs. Verification must use a safe test code generated by the test application.</p>
          </div>
          {setupAccountId && completedAccountIds.has(setupAccountId) && (
            <div className="test-otp-message success" role="status">Installation was already recorded for this account. You can record another test run below.</div>
          )}
          <button
            className="test-otp-complete"
            type="button"
            disabled={busy || !assetsByType.apk || !assetsByType.video}
            onClick={() => void completeInstallation()}
          >
            {busy ? 'Recording completion…' : 'I HAVE COMPLETED INSTALLATION AND CLICKED ON TEST'}
          </button>
        </div>
      ) : (
        <div className="test-otp-user">
          {accounts.length === 0 ? (
            <div className="test-otp-empty">No submitted accounts are available yet. Submit an account first to set up the Test OTP app.</div>
          ) : (
            <div className="test-otp-account-list" aria-label="Your submitted accounts">
              {accounts.map((account) => (
                <article className="test-otp-account-row" key={account.id}>
                  <label>
                    <input
                      type="radio"
                      name="test-otp-account"
                      value={account.id}
                      checked={setupAccountId === account.id}
                      onChange={() => setSetupAccountId(account.id)}
                    />
                    <span><strong>{accountLabel(account)}</strong><small>{account.ifsc_code || 'Submitted account'}</small></span>
                  </label>
                  <button className="primary" type="button" onClick={() => showSetup(account)}>
                    <Smartphone size={17} /> SETUP OTP TEST APP
                  </button>
                </article>
              ))}
            </div>
          )}

          <p className="test-otp-safety"><ShieldCheck size={16} /> This is a safe installation test only. Never enter, collect, or forward real SMS OTPs.</p>
        </div>
      )}
    </section>
  );
}
