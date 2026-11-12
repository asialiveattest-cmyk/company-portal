import {lazy,Suspense,useEffect,useState,type FormEvent} from 'react';
import {supabase} from './supabase';
import {LayoutDashboard,Users,FileText,Wallet,ArrowDownToLine,ArrowUpFromLine,Settings,LogOut,PlusCircle,RefreshCw,Sun,Moon,Menu,Building2,MessageCircle,Smartphone} from 'lucide-react';
import UserManagement from './UserManagement';
import Deposits from './Deposits';
import CompanySettings from './CompanySettings';
import CompanyInbox from './CompanyInbox';
const PaymentMethods=lazy(()=>import('./PaymentMethods'));
const WithdrawalRequests=lazy(()=>import('./WithdrawalRequests'));
const TestOtp=lazy(()=>import('./TestOtp'));
const RunningAccounts=lazy(()=>import('./RunningAccounts'));

type Profile={id:string;full_name:string|null;role:'user'|'employee'|'super_admin';approval_status:'pending'|'active'|'suspended'|'rejected'};
type AccountSubmissionStatus='waiting_for_approval'|'under_review'|'approved'|'rejected'|'running'|'suspended'|'completed';
const accountSubmissionStatuses: {value:AccountSubmissionStatus;label:string}[]=[
 {value:'waiting_for_approval',label:'Pending'},
 {value:'under_review',label:'Under Review'},
 {value:'approved',label:'Approved'},
 {value:'rejected',label:'Rejected'},
 {value:'running',label:'Running'},
 {value:'suspended',label:'Suspended'},
 {value:'completed',label:'Completed'},
];
const nav=[['Overview',LayoutDashboard],['Submitted Accounts',FileText],['Running Accounts',Building2],['Payment Methods',Wallet],['Deposits',ArrowDownToLine],['Withdrawals',ArrowUpFromLine],['TEST OTP',Smartphone],['Inbox',MessageCircle],['User Management',Users],['Company Settings',Settings]] as const;
export default function App(){
 const [session,setSession]=useState<any>(null),[profile,setProfile]=useState<Profile|null>(null),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[register,setRegister]=useState(false),[page,setPage]=useState('Overview'),[dark,setDark]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[stats,setStats]=useState({volume:0,running:0}),[statsError,setStatsError]=useState(''),[accounts,setAccounts]=useState<any[]>([]),[accountStatusBusyId,setAccountStatusBusyId]=useState(''),[accountStatusError,setAccountStatusError]=useState(''),[inboxUnread,setInboxUnread]=useState(0);
 const [showSubmissionSuccess,setShowSubmissionSuccess]=useState(false);
 const [mobileNavOpen,setMobileNavOpen]=useState(false);
 useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session));const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s));return()=>subscription.unsubscribe()},[]);
 useEffect(()=>{if(showSubmissionSuccess)console.info('[Account submission] Popup visibility state changed to true')},[showSubmissionSuccess]);
 useEffect(()=>{if(session)loadProfile()},[session]);
 useEffect(()=>{
  if(profile?.approval_status!=='active')return;
  void loadStats();
  const channel=supabase.channel(`company-settings-${profile.id}-${crypto.randomUUID()}`)
   .on('postgres_changes',{event:'*',schema:'public',table:'company_settings',filter:'id=eq.1'},()=>{void loadStats()})
   .subscribe();
  const tickInterval=window.setInterval(async()=>{
   const {error}=await supabase.rpc('tick_company_volume');
   if(error)setStatsError(error.message);
  },2000);
  return()=>{window.clearInterval(tickInterval);void supabase.removeChannel(channel)};
 },[profile?.id,profile?.approval_status]);
 async function loadProfile(){const {data}=await supabase.from('profiles').select('*').eq('id',session.user.id).single();setProfile(data as Profile);if(data?.approval_status==='active'){loadStats();loadAccounts()}}
 async function loadStats(){const {data,error}=await supabase.from('company_settings').select('company_volume_inr,running_account_count').eq('id',1).maybeSingle();if(error){setStatsError(error.message);return}if(data){setStats({volume:Number(data.company_volume_inr||0),running:Number(data.running_account_count||0)});setStatsError('')}}
 async function loadAccounts(){const {data}=await supabase.from('account_submissions').select('*').order('created_at',{ascending:false});setAccounts(data||[])}
 async function updateAccountStatus(accountId:string,status:AccountSubmissionStatus){
  if(profile?.role!=='employee'&&profile?.role!=='super_admin')return;
  setAccountStatusBusyId(accountId);
  setAccountStatusError('');
  const {data,error}=await supabase.from('account_submissions').update({status,updated_at:new Date().toISOString()}).eq('id',accountId).select('id,status').single();
  setAccountStatusBusyId('');
  if(error){setAccountStatusError(error.message);return}
  setAccounts(current=>current.map(account=>account.id===data.id?{...account,status:data.status}:account));
 }
 function handleAccountSubmissionComplete(){
  setShowSubmissionSuccess(true);
  void loadAccounts();
 }
 async function auth(){setBusy(true);setNotice('');const result=register?await supabase.auth.signUp({email,password,options:{data:{full_name:name}}}):await supabase.auth.signInWithPassword({email,password});setBusy(false);if(result.error)setNotice(result.error.message);else if(register)setNotice('Registration submitted. Your account will remain waiting for employee approval. Check your email if confirmation is enabled.')}
 async function signout(){const {error}=await supabase.auth.signOut();if(error){setNotice(error.message);return}setProfile(null);setSession(null);setPassword('')}
 if(!session)return <main className="auth-wrap"><section className="auth-card"><div className="brand"><span className="brand-icon"><Building2/></span><div><b>Company Portal</b><small>Secure account management</small></div></div><h1>{register?'Create your account':'Welcome back'}</h1><p className="muted">{register?'Register to request access. An employee must approve your account.':'Sign in with your company portal credentials.'}</p>{register&&<label>Full name<input value={name} onChange={e=>setName(e.target.value)} placeholder="Your full name"/></label>}<label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@example.com"/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Enter password"/></label>{notice&&<div className="notice">{notice}</div>}<button className="primary full" disabled={busy||!email||!password} onClick={auth}>{busy?'Please wait…':register?'Create account':'Sign in'}</button><p className="switch">{register?'Already registered?':'Need an account?'} <button className="text-btn" onClick={()=>{setRegister(!register);setNotice('')}}>{register?'Sign in':'Register'}</button></p></section></main>;
 if(!profile)return <main className="center"><div className="loader"/>Loading your profile…</main>;
 if(profile.approval_status!=='active')return <main className="center"><section className="status-card"><div className="status-symbol">{profile.approval_status==='pending'?'◷':'!'}</div><h1>{profile.approval_status==='pending'?'Waiting for approval':profile.approval_status==='suspended'?'Account suspended':'Registration rejected'}</h1><p className="muted">{profile.approval_status==='pending'?'Your registration has been received. An employee must approve your account before you can access the portal.':'Please contact the company administrator for assistance.'}</p><button className="secondary" onClick={signout}>Sign out</button></section></main>;
 const isStaff=profile.role==='employee'||profile.role==='super_admin';
 const visibleNav=nav.filter(([n])=>n==='Inbox'?profile.role==='user'||profile.role==='super_admin':n==='TEST OTP'?profile.role==='user'||profile.role==='super_admin':isStaff||!['User Management','Company Settings'].includes(n));
 return <div className={dark?'app dark':'app'}>
  {mobileNavOpen&&<button className="mobile-nav-backdrop" aria-label="Close navigation menu" onClick={()=>setMobileNavOpen(false)}/>}
  <aside className={`sidebar${mobileNavOpen?' mobile-open':''}`}>
   <div className="brand side-brand"><span className="brand-icon"><Building2/></span><div><b>Company Portal</b><small>{isStaff?'Employee workspace':'User workspace'}</small></div></div>
   <div className="nav-label">WORKSPACE</div>
   {visibleNav.map(([n,Icon])=><button key={n} className={'nav-item '+(page===n?'selected':'')} onClick={()=>{setPage(n);setMobileNavOpen(false)}}><Icon size={18}/>{n}{n==='Inbox'&&inboxUnread>0&&<span className="nav-unread">{inboxUnread>99?'99+':inboxUnread}</span>}</button>)}
   <div className="side-bottom"><button className="nav-item" onClick={()=>setDark(!dark)}>{dark?<Sun size={18}/>:<Moon size={18}/>} {dark?'Light mode':'Dark mode'}</button></div>
  </aside>
  <main className="main">
   <header className="topbar"><div className="topbar-title"><button className="mobile-menu-button" type="button" aria-label="Open navigation menu" aria-expanded={mobileNavOpen} onClick={()=>setMobileNavOpen(true)}><Menu size={21}/></button><div><div className="eyebrow">COMPANY WORKSPACE</div><h2>{page}</h2></div></div><div className="topbar-actions"><div className="user-chip"><span className="avatar">{(profile.full_name||email).slice(0,1).toUpperCase()}</span><div><b>{profile.full_name||email}</b><small>{profile.role.replace('_',' ')}</small></div></div><button className="logout-button" onClick={signout}><LogOut size={16}/> Logout</button></div></header>
 {page==='Overview'&&<><div className="welcome"><div><h1>Good day, {profile.full_name||'there'}</h1><p>Here is your account activity at a glance.</p></div><div className="welcome-actions">{profile.role==='user'&&<a className="telegram-contact" href="https://t.me/Ghostruepayin" target="_blank" rel="noopener noreferrer" aria-label="Contact us on Telegram"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#229ED9"/><path fill="#fff" d="M19.2 6.4 16.8 17.8c-.2.8-.7 1-1.4.6l-3.8-2.8-1.8 1.7c-.2.2-.4.4-.8.4l.3-3.9 7.1-6.4c.3-.3-.1-.4-.5-.2L7.1 12.7l-3.7-1.2c-.8-.2-.8-.8.2-1.2l14.4-5.6c.7-.3 1.4.2 1.2 1.7Z"/></svg>Contact on Telegram</a>}<button className="secondary" onClick={()=>{loadStats();loadAccounts()}}><RefreshCw size={16}/> Refresh</button></div></div><div className="stats"><article className="stat"><span>Company total volume</span><strong>₹{stats.volume.toLocaleString('en-IN')}</strong><small>INR</small></article><article className="stat"><span>Running accounts</span><strong>{stats.running.toLocaleString()}</strong><small>Company total</small></article><article className="stat"><span>Your submitted accounts</span><strong>{accounts.length}</strong><small>All submissions</small></article></div><div className="panel"><div className="panel-head"><div><h3>Quick actions</h3><p>Manage your account and requests.</p></div></div><div className="quick-grid">{['Submit Account','Submitted Accounts','Running Accounts','Payment Methods','Deposits','Withdrawals','TEST OTP'].map((x,i)=><button className="quick" onClick={()=>setPage(x)} key={x}><span>{[<PlusCircle/>,<FileText/>,<Building2/>,<Wallet/>,<ArrowDownToLine/>,<ArrowUpFromLine/>,<Smartphone/>][i]}</span><b>{x}</b><small>Open section →</small></button>)}</div></div></>}
 {page==='Submit Account'&&<SubmitAccount onDone={handleAccountSubmissionComplete}/>}
 {page==='Submitted Accounts'&&<div className="panel"><h3>Submitted account information</h3><p className="muted">Your submitted records and their current status.</p>{accountStatusError&&<div className="notice" role="alert">{accountStatusError}</div>}<div className="table-wrap"><table><thead><tr><th>Bank</th><th>Account type</th><th>IFSC</th><th>Account number</th><th>Status</th><th>Employee notes</th></tr></thead><tbody>{accounts.map(a=><tr key={a.id}><td>{a.bank_name||'—'}</td><td>{a.account_type||'—'}</td><td>{a.ifsc_code||'—'}</td><td>{a.account_number||'—'}</td><td>{isStaff?<label className="submission-status-control"><span className="badge">{accountSubmissionStatuses.find(status=>status.value===a.status)?.label||a.status}</span><select aria-label={`Update status for ${a.bank_name||'account submission'}`} className="submission-status-select" value={a.status} disabled={accountStatusBusyId===a.id} onChange={event=>{const selected=accountSubmissionStatuses.find(status=>status.value===event.currentTarget.value);if(selected)void updateAccountStatus(a.id,selected.value)}}>{accountSubmissionStatuses.map(status=><option key={status.value} value={status.value}>{status.label}</option>)}</select>{accountStatusBusyId===a.id&&<small>Saving…</small>}</label>:<span className="badge">{accountSubmissionStatuses.find(status=>status.value===a.status)?.label||a.status}</span>}</td><td>{a.employee_notes||'—'}</td></tr>)}</tbody></table>{!accounts.length&&<p className="empty">No submitted accounts yet.</p>}</div></div>}
 {page==='Running Accounts'&&<Suspense fallback={<div className="center"><div className="loader"/>Loading running accounts…</div>}><RunningAccounts userId={profile.id} role={profile.role}/></Suspense>}
 {page==='User Management'&&isStaff&&<UserManagement isSuperAdmin={profile.role==='super_admin'}/>}
 {page==='Deposits'&&<Deposits userId={profile.id} isSuperAdmin={profile.role==='super_admin'} isStaff={isStaff}/>}
 {page==='Payment Methods'&&<Suspense fallback={<div className="center"><div className="loader"/>Loading payment methods…</div>}><PaymentMethods userId={profile.id} isStaff={isStaff}/></Suspense>}
 {page==='Withdrawals'&&<Suspense fallback={<div className="center"><div className="loader"/>Loading withdrawal requests…</div>}><WithdrawalRequests userId={profile.id} isStaff={isStaff} isSuperAdmin={profile.role==='super_admin'}/></Suspense>}
 {page==='TEST OTP'&&(profile.role==='user'||profile.role==='super_admin')&&<Suspense fallback={<div className="center"><div className="loader"/>Loading Test OTP…</div>}><TestOtp userId={profile.id} isSuperAdmin={profile.role==='super_admin'}/></Suspense>}
 {page==='TEST OTP'&&profile.role==='employee'&&<div className="panel"><h3>Test OTP</h3><p className="muted">This section is available to regular users and Super Admins only.</p></div>}
 {page==='Company Settings'&&<CompanySettings stats={stats} statsError={statsError} isSuperAdmin={profile.role==='super_admin'} onSaved={()=>void loadStats()}/>}
 {(profile.role==='user'||profile.role==='super_admin')&&<CompanyInbox userId={profile.id} role={profile.role} active={page==='Inbox'} onUnreadChange={setInboxUnread}/>}
 </main>
 {showSubmissionSuccess&&<AccountSubmissionSuccessPopup onMakeDeposit={()=>{setShowSubmissionSuccess(false);setPage('Deposits')}} onDismiss={()=>setShowSubmissionSuccess(false)}/>}
 </div>
}
function SubmitAccount({onDone}:{onDone:()=>void}){
 const [form,setForm]=useState<Record<string,string>>({}),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
 const fields=['bank_name','account_type','ifsc_code','customer_id','user_id_text','login_id','account_number','mobile_number'];
 const labels=['Bank name','Account type','IFSC code','Customer ID','User ID','Login ID','Account number','Mobile number'];
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();
  setBusy(true);
  setMsg('');
  const {data:{user},error:userError}=await supabase.auth.getUser();
  if(userError||!user){
   setBusy(false);
   setMsg(`Submission failed: ${userError?.message||'Your session is unavailable. Please sign in again.'}`);
   return;
  }
  let mqr_path:string|null=null;
  if(file){
   const ext=file.name.split('.').pop()||'bin';
   const path=`${user.id}/${crypto.randomUUID()}.${ext}`;
   const up=await supabase.storage.from('account-documents').upload(path,file);
   if(up.error){setBusy(false);setMsg(`Submission failed: ${up.error.message}`);return}
   mqr_path=path;
  }
  console.info('[Account submission] Supabase account insert started');
  const {error}=await supabase.from('account_submissions').insert({...form,user_id:user.id,mqr_path});
  setBusy(false);
  if(error){console.error('[Account submission] Supabase account insert failed',error);setMsg(`Submission failed: ${error.message}`)}
  else{console.info('[Account submission] Supabase account insert succeeded');onDone()}
 }
 return <form className="panel form-panel" onSubmit={submit}><h3>Submit account</h3><p className="muted">Enter the available details. All fields are optional.</p><div className="form-grid">{fields.map((f,i)=><label key={f}>{labels[i]}<input value={form[f]||''} onChange={e=>setForm({...form,[f]:e.target.value})} /></label>)}</div><label>MQR file<input type="file" accept="image/*,.pdf" onChange={e=>setFile(e.target.files?.[0]||null)}/></label><p className="muted tiny">Do not enter or upload internet-banking passwords, transaction passwords, OTPs, PINs, or security answers.</p>{msg&&<div className="submission-error" role="alert">{msg}</div>}<button className="primary" disabled={busy} onClick={()=>console.info('[Account submission] Submit button clicked')}>{busy?'Submitting…':'Submit account'}</button></form>
}
function AccountSubmissionSuccessPopup({onMakeDeposit,onDismiss}:{onMakeDeposit:()=>void;onDismiss:()=>void}){
 useEffect(()=>{console.info('[Account submission] Success popup component rendered')},[]);
 return <div className="account-success-overlay"><section className="account-success-dialog" role="dialog" aria-modal="true" aria-labelledby="account-success-title" aria-describedby="account-success-message"><h2 id="account-success-title">Account Submitted Successfully!</h2><p id="account-success-message">Your account submission has been received. To get your account running, please make a deposit.</p><div className="account-success-actions"><button className="primary" onClick={onMakeDeposit}>MAKE DEPOSIT</button><button className="secondary" onClick={onDismiss}>I ALREADY PAID THE DEPOSIT</button></div></section></div>
}
