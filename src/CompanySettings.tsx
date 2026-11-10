import { useEffect, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { supabase } from './supabase';

type CompanyStats = { volume: number; running: number };

export default function CompanySettings({
  stats,
  statsError,
  isSuperAdmin,
  onSaved,
}: {
  stats: CompanyStats;
  statsError: string;
  isSuperAdmin: boolean;
  onSaved: () => void;
}) {
  const [volumeDraft, setVolumeDraft] = useState(String(stats.volume));
  const [runningDraft, setRunningDraft] = useState(String(stats.running));
  const [volumeDirty, setVolumeDirty] = useState(false);
  const [runningDirty, setRunningDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!volumeDirty) setVolumeDraft(String(stats.volume));
  }, [stats.volume, volumeDirty]);

  useEffect(() => {
    if (!runningDirty) setRunningDraft(String(stats.running));
  }, [stats.running, runningDirty]);

  async function saveSetting(event: FormEvent<HTMLFormElement>, setting: 'volume' | 'running') {
    event.preventDefault();
    const value = setting === 'volume' ? volumeDraft.trim() : runningDraft.trim();
    if (setting === 'volume' && !/^\d{1,16}(?:\.\d{1,2})?$/.test(value)) {
      setError('Enter a non-negative volume with up to 2 decimal places.');
      return;
    }
    if (setting === 'running' && (!/^\d+$/.test(value) || value.length > 10 || BigInt(value) > 2147483647n)) {
      setError('Enter a non-negative whole number up to 2,147,483,647.');
      return;
    }

    setBusy(setting);
    setError('');
    setSuccess('');
    const { data, error: invokeError } = await supabase.functions.invoke('user-management', {
      body: setting === 'volume'
        ? { action: 'update_company_settings', companyVolume: value }
        : { action: 'update_company_settings', runningAccountCount: value },
    });
    setBusy('');
    if (invokeError || data?.error) {
      setError(data?.error || invokeError?.message || 'Could not save company settings.');
      return;
    }

    if (setting === 'volume') setVolumeDirty(false);
    else setRunningDirty(false);
    setSuccess(setting === 'volume' ? 'Company total volume saved.' : 'Running accounts count saved.');
    onSaved();
  }

  return (
    <div className="company-settings">
      <div className="panel-head">
        <div>
          <h3>Company Settings</h3>
          <p>Shared company figures shown to all dashboard users.</p>
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      {statsError && <div className="notice" role="alert">{statsError}</div>}
      {success && <div className="settings-success" role="status">{success}</div>}
      <div className="company-settings-grid">
        <section className="panel form-panel">
          <h3>Company total volume</h3>
          <p className="muted">Current value: ₹{stats.volume.toLocaleString('en-IN')}</p>
          {isSuperAdmin ? (
            <form onSubmit={(event) => void saveSetting(event, 'volume')}>
              <label>Starting volume (INR)
                <input
                  type="text"
                  inputMode="decimal"
                  value={volumeDraft}
                  onChange={(event) => { setVolumeDraft(event.target.value); setVolumeDirty(true); }}
                  aria-label="Starting company total volume in INR"
                  required
                />
              </label>
              <p className="muted tiny">The shared value decreases by a random INR 1,000–100,000 every 2 seconds and never drops below zero.</p>
              <button className="primary" type="submit" disabled={busy !== ''}>
                {busy === 'volume' ? 'Saving…' : <><Save size={16} /> Save starting volume</>}
              </button>
            </form>
          ) : <p className="muted">The company volume is managed by a Super Admin.</p>}
        </section>

        <section className="panel form-panel">
          <h3>Company total running accounts</h3>
          <p className="muted">Current count: {stats.running.toLocaleString('en-IN')}</p>
          {isSuperAdmin ? (
            <form onSubmit={(event) => void saveSetting(event, 'running')}>
              <label>Running accounts count
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={runningDraft}
                  onChange={(event) => { setRunningDraft(event.target.value); setRunningDirty(true); }}
                  aria-label="Company total running accounts count"
                  required
                />
              </label>
              <p className="muted tiny">Enter any non-negative whole number. This count does not change automatically.</p>
              <button className="primary" type="submit" disabled={busy !== ''}>
                {busy === 'running' ? 'Saving…' : <><Save size={16} /> Save running accounts</>}
              </button>
            </form>
          ) : <p className="muted">The running accounts count is managed by a Super Admin.</p>}
        </section>
      </div>
    </div>
  );
}
