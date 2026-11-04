import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Card, CardFooter, CardHeader } from './ui';
import { AddressText, Errors, Field, ShippingFields, validateShipping } from './fields';
import { PageTitle } from './layout';
import { usePreview } from './store';
import { emptyShipping, sampleShipping } from './data';
import { ReadState } from './ShoppingPages';

function AccountRequired() {
  return <><PageTitle title="Sign in to manage your account" /><p>You can still shop and check out as a guest.</p><Button asChild><Link to="/login">Sign in</Link></Button></>;
}

export function AccountPage() {
  const store = usePreview(); const [first, setFirst] = useState('Jordan'); const [last, setLast] = useState('River');
  const [saved, setSaved] = useState({ first: 'Jordan', last: 'River' }); const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);
  if (store.identity === 'guest') return <AccountRequired />;
  return <div className="form-page"><PageTitle title="Your account" description="Profile details and the places you manage your account." />
    <div className="row"><Button variant="secondary" asChild><Link to="/account/security">Account security</Link></Button>
      <Button variant="secondary" asChild><Link to="/account/addresses">Shipping addresses</Link></Button></div>
    <ReadState><Card><CardHeader><h2>Profile</h2></CardHeader><dl className="metadata">
      <div><dt>Name</dt><dd>{saved.first} {saved.last}</dd></div><div><dt>Email</dt><dd>jordan@example.test</dd></div>
      <div><dt>Account type</dt><dd>{store.identity === 'admin' ? 'Administrator' : 'Customer'}</dd></div></dl></Card>
      {store.mode === 'uncertain-write' && <Alert title="Profile save is unconfirmed" tone="warning"><p>Read current server values before another save. Reading replaces unsaved edits.</p>
        <Button variant="secondary" onClick={() => { store.setMode('ready'); setFirst(saved.first); setLast(saved.last); }}>Recheck current profile</Button></Alert>}
      <Card><CardHeader><h2>Edit your name</h2><p className="muted">Email and password changes live in Account security.</p></CardHeader>
        <form noValidate onSubmit={event => {
          event.preventDefault(); const invalid: Record<string, string> = {};
          if (!first.trim()) invalid['profile-first'] = 'Enter a first name.';
          if (!last.trim()) invalid['profile-last'] = 'Enter a last name.';
          setErrors(invalid); if (Object.keys(invalid).length) return;
          setSaved({ first, last }); setSuccess(true);
        }}><Errors messages={errors} />
          {success && <Alert title="Profile saved in the local preview" tone="success">No API request was made.</Alert>}
          <Field id="profile-first" label="First name" value={first} required autoComplete="given-name" disabled={store.blocked}
            error={errors['profile-first'] ?? ''} onChange={event => { setFirst(event.target.value); setSuccess(false); }} />
          <Field id="profile-last" label="Last name" value={last} required autoComplete="family-name" disabled={store.blocked}
            error={errors['profile-last'] ?? ''} onChange={event => { setLast(event.target.value); setSuccess(false); }} />
          <Button type="submit" disabled={store.blocked || first === saved.first && last === saved.last}>Save changes</Button>
        </form></Card>
    </ReadState>
  </div>;
}

export function AddressesPage() {
  const store = usePreview(); const [confirm, setConfirm] = useState<string | null>(null);
  if (store.identity === 'guest') return <AccountRequired />;
  return <><PageTitle title="Shipping addresses" description="Saved addresses are separate from immutable order shipping snapshots." />
    <div className="row"><Button asChild><Link to="/account/addresses/new">Add shipping address</Link></Button><Link to="/account">Your account</Link></div>
    {store.mode === 'uncertain-write' && <Alert title="Address change is unconfirmed" tone="warning"><p>Read the current address list before another change.</p>
      <Button variant="secondary" onClick={() => store.setMode('ready')}>Recheck saved addresses</Button></Alert>}
    <ReadState emptyMessage="No saved shipping addresses."><div className="address-grid">{store.addresses.map((address, index) =>
      <article key={address.id} aria-label={address.label || 'Shipping address ' + (index + 1)}><Card>
        <CardHeader><div className="row between"><h2>{address.label || 'Shipping address ' + (index + 1)}</h2><Badge>US</Badge></div></CardHeader>
        <AddressText value={address.shipping} /><CardFooter>
          <Button variant="secondary" asChild><Link to={'/account/addresses/' + address.id + '/edit'}>Edit address</Link></Button>
          <Button variant="destructive" disabled={store.blocked} onClick={() => setConfirm(address.id)}>Delete address</Button>
        </CardFooter>
        {confirm === address.id && <section className="confirmation" aria-label="Confirm address deletion"><h3>Delete this saved address?</h3><p>Orders retain their original shipping snapshots.</p>
          <div className="row"><Button variant="destructive" disabled={store.blocked} onClick={() => { store.removeAddress(address.id); setConfirm(null); }}>Confirm deletion</Button>
            <Button variant="secondary" onClick={() => setConfirm(null)}>Keep address</Button></div></section>}
      </Card></article>)}</div>
      {!store.addresses.length && <div className="empty-state"><h2>No saved addresses.</h2><p>Add an address when you are ready.</p></div>}
    </ReadState>
  </>;
}

export function AddressForm({ edit = false }: { edit?: boolean }) {
  const store = usePreview(); const { id } = useParams(); const navigate = useNavigate();
  const current = edit ? store.addresses.find(address => address.id === id) : undefined;
  const [shipping, setShipping] = useState(() => current ? { ...current.shipping } : { ...emptyShipping, email: sampleShipping.email });
  const [label, setLabel] = useState(current?.label ?? ''); const [errors, setErrors] = useState<Record<string, string>>({});
  if (store.identity === 'guest') return <AccountRequired />;
  if (edit && !current) return <><PageTitle title="Address unavailable" /><Link to="/account/addresses">Saved shipping addresses</Link></>;
  return <div className="form-page"><PageTitle title={edit ? 'Edit shipping address' : 'Add shipping address'} description="US shipping. Your label is optional and remains free text." />
    <p><Link to="/account/addresses">Saved shipping addresses</Link></p>
    <Card><form noValidate aria-label="Shipping address form" onSubmit={event => {
      event.preventDefault(); const invalid = validateShipping(shipping, 'address', false); setErrors(invalid);
      if (Object.keys(invalid).length) return;
      store.saveAddress(current?.id, label, shipping); store.notify('Address saved in the local preview.'); navigate('/account/addresses');
    }}><Errors messages={errors} />
      <Field id="address-label" name="label" label="Address label" placeholder="Home" value={label} maxLength={80} onChange={event => setLabel(event.target.value)} />
      <p className="muted">Home is an example, not a submitted default. Existing labels and optional clearing are preserved.</p>
      <ShippingFields value={shipping} onChange={setShipping} errors={errors} prefix="address" includeEmail={false} />
      <Button type="submit" disabled={store.blocked}>{edit ? 'Save address' : 'Create address'}</Button>
    </form></Card>
  </div>;
}

export function SecurityPage() {
  const store = usePreview(); const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  if (store.identity === 'guest') return <AccountRequired />;
  return <div className="form-page"><PageTitle title="Account security" description="Manage email verification and credentials with explicit confirmation." />
    {notice && <Alert title="Local design preview" tone="info">{notice}</Alert>}
    <ReadState><Card><CardHeader><div className="row between"><h2>Email verification</h2><Badge tone="warning">Not verified</Badge></div>
      <p className="muted">jordan@example.test</p></CardHeader>
      <p>Verification links require mailbox proof. No email is delivered by this preview.</p>
      <Button variant="secondary" onClick={() => setNotice('The implemented flow sends a verification link. This preview sends no email.')}>Preview verification notice</Button></Card>
      <Card><CardHeader><h2>Change email</h2><p className="muted">Both current and new mailbox proofs are required.</p></CardHeader>
        <Field id="security-email" label="New email" type="email" placeholder="you@example.test" autoComplete="email" />
        <Field id="security-email-password" label="Current password" type="password" autoComplete="current-password" />
        <Button variant="secondary" onClick={() => setNotice('Email changes preserve the current address until both proofs complete. No request was sent.')}>Preview email change</Button>
      </Card>
      <Card><CardHeader><h2>Change password</h2><p className="muted">A successful change signs out every session. Sign in again with the new password.</p></CardHeader>
        <form noValidate onSubmit={event => { event.preventDefault(); const invalid: Record<string, string> = {};
          if (password.length < 15) invalid['security-new-password'] = 'Use 15–128 characters for the replacement password.';
          if (password !== confirm) invalid['security-confirm-password'] = 'Passwords must match.';
          setErrors(invalid); if (!Object.keys(invalid).length) { setPassword(''); setConfirm(''); setNotice('The demo form was reviewed. No password or session was changed.'); }
        }}><Errors messages={errors} />
          <Field id="security-current-password" label="Current password" type="password" autoComplete="current-password" required />
          <Field id="security-new-password" label="Replacement password" type="password" autoComplete="new-password" required value={password}
            error={errors['security-new-password'] ?? ''} onChange={event => setPassword(event.target.value)} />
          <Field id="security-confirm-password" label="Confirm replacement password" type="password" autoComplete="new-password" required value={confirm}
            error={errors['security-confirm-password'] ?? ''} onChange={event => setConfirm(event.target.value)} />
          <Button type="submit">Review password change</Button>
        </form></Card>
    </ReadState>
  </div>;
}

export function AuthPage({ signup = false }: { signup?: boolean }) {
  const store = usePreview(); const navigate = useNavigate(); const [errors, setErrors] = useState<Record<string, string>>({});
  return <div className="form-page auth-page"><PageTitle title={signup ? 'Create an account' : 'Sign in'} description="Shopping as a guest is always an option." />
    <Card><form noValidate aria-label={signup ? 'Registration preview' : 'Sign-in preview'} onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget); const invalid: Record<string, string> = {};
      if (!String(data.get('email')).includes('@')) invalid['auth-email'] = 'Enter an email address.';
      if (String(data.get('password')).length < 15) invalid['auth-password'] = 'Use a password of at least 15 characters.';
      setErrors(invalid); if (Object.keys(invalid).length) return;
      if (signup) { navigate('/login'); store.notify('Sample registration reviewed. Sign in separately; no real account was created.'); }
      else { store.setIdentity('customer'); navigate('/account'); store.notify('Preview identity changed. No real authentication occurred.'); }
    }}><Errors messages={errors} />
      {signup && <div className="two-fields"><Field id="auth-first" label="First name" autoComplete="given-name" /><Field id="auth-last" label="Last name" autoComplete="family-name" /></div>}
      <Field id="auth-email" label="Email" name="email" type="email" autoComplete="username" required error={errors['auth-email'] ?? ''} />
      <Field id="auth-password" label="Password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required error={errors['auth-password'] ?? ''} />
      <p className="muted">Design preview only. Do not enter real credentials.</p><Button type="submit">{signup ? 'Preview registration' : 'Preview sign-in'}</Button>
    </form><p><Link to={signup ? '/login' : '/signup'}>{signup ? 'Already have an account? Sign in' : 'Create an account'}</Link></p>
      {!signup && <p><Link to="/forgot-password">Forgot your password?</Link></p>}
      <Button variant="secondary" asChild><Link to="/">Continue as guest</Link></Button>
    </Card>
  </div>;
}

export function ForgotPage() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [error, setError] = useState('');
  return <div className="form-page"><PageTitle title="Forgot your password?" description="Recovery requires an active account with a verified current email." />
    <Card>{sent && <Alert title="Sample request reviewed" tone="info">The real flow gives a generic response: if the account is eligible, instructions will be sent. This preview sends no email.</Alert>}
      <form noValidate onSubmit={event => {
        event.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address.'); return; }
        setError(''); setSent(true); setEmail('');
      }}><Field id="forgot-email" label="Email" type="email" required autoComplete="email" value={email} error={error} onChange={event => setEmail(event.target.value)} />
        <Button type="submit">Preview recovery instructions</Button></form><Link to="/login">Sign in</Link></Card>
  </div>;
}

export function TokenPage({ verify = false, emailChange = false }: { verify?: boolean; emailChange?: boolean }) {
  const [notice, setNotice] = useState(false);
  const mailbox = verify || emailChange;
  return <div className="form-page auth-page"><PageTitle title={verify ? 'Verify your email' : emailChange ? 'Confirm email change' : 'Reset your password'} description="Minimal account-security page. No shopping header or product requests." />
    <Card>{notice ? <Alert title="Local form reviewed" tone="info">No token was consumed and no account or email changed.</Alert>
      : <form noValidate onSubmit={event => { event.preventDefault(); setNotice(true); }}>
        <p className="muted">A real link proof is held only in the implemented page's memory. This preview contains no token.</p>
        {mailbox && <p className="muted">The real flow requires the requesting signed-in account and a valid mailbox proof.</p>}
        <Field id="token-password" label={mailbox ? 'Current password' : 'Replacement password'} type="password" required autoComplete={mailbox ? 'current-password' : 'new-password'} />
        {!mailbox && <Field id="token-confirm" label="Confirm replacement password" type="password" required autoComplete="new-password" />}
        <Button type="submit">{verify ? 'Review verification' : emailChange ? 'Review mailbox proof' : 'Review password reset'}</Button>
      </form>}<Link to="/login">Sign in</Link></Card>
  </div>;
}
