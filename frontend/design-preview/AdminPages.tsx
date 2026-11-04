import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Card, CardFooter, CardHeader, Select } from './ui';
import { Errors, Field } from './fields';
import { PageTitle } from './layout';
import { usePreview } from './store';
import { money } from './data';
import { ProductPicture, ReadState } from './ShoppingPages';
import { SearchBar } from './SearchBar';

function Required() {
  return <><PageTitle title="Administrator access required" /><Alert title="Select the administrator preview identity" tone="warning">
    These sample screens do not grant real permissions.</Alert></>;
}

function WriteNotice() {
  const store = usePreview();
  if (store.mode === 'pending-write') return <Alert title="Change in progress">Wait for the result before another write.</Alert>;
  if (store.mode === 'uncertain-write') return <Alert title="The change is unconfirmed" tone="warning"><p>Read current values before another write. Do not repeat automatically.</p>
    <Button variant="secondary" onClick={() => store.setMode('ready')}>Recheck current product</Button></Alert>;
  return null;
}

export function AdminHome() {
  const store = usePreview();
  if (store.identity !== 'admin') return <Required />;
  return <div className="admin-home"><PageTitle title="Administration" description="Your current account has administrator access." />
    <Button asChild><Link to="/admin/products">Browse products</Link></Button></div>;
}

export function AdminList() {
  const store = usePreview(); const location = useLocation(); const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const query = params.get('q') ?? '';
  const [status, setStatus] = useState(params.get('is_active') ?? 'all'); const [limit, setLimit] = useState(params.get('limit') ?? '20');
  useEffect(() => {
    const next = new URLSearchParams(location.search); setStatus(next.get('is_active') ?? 'all'); setLimit(next.get('limit') ?? '20');
  }, [location.search]);
  const committedStatus = params.get('is_active') ?? 'all';
  function submit(value: string) {
    const next = new URLSearchParams();
    if (value) next.set('q', value);
    if (status !== 'all') next.set('is_active', status);
    next.set('limit', limit);
    navigate('/admin/products?' + next.toString());
  }
  const rows = store.products.filter(product => (product.name + ' ' + product.sku).toLowerCase().includes(query.toLowerCase()))
    .filter(product => committedStatus === 'all' || String(product.id !== 'bottle') === committedStatus);
  if (store.identity !== 'admin') return <Required />;
  return <><PageTitle title="Manage products" description="Literal name/SKU search in the administrator context. This preview filters four sample rows only." />
    <div className="row"><Button asChild><Link to="/admin/products/new">Create product</Link></Button></div>
    <Card className="admin-filters"><SearchBar context="admin" query={query} onSubmit={submit}>
      <div className="row"><div><p className="field-label">Product status</p><Select label="Product status" value={status} onValueChange={setStatus}
        options={[{ value: 'all', label: 'All statuses' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} /></div>
        <div><p className="field-label">Products per page</p><Select label="Products per page" value={limit} onValueChange={setLimit}
          options={[{ value: '20', label: '20 per page' }, { value: '50', label: '50 per page' }, { value: '100', label: '100 per page' }]} /></div>
        <Button type="submit" variant="secondary">Apply filters</Button>
        <Button variant="secondary" onClick={() => navigate('/admin/products')}>Clear filters</Button></div></SearchBar></Card>
    <p className="muted">Availability is an observation, not an inventory reservation.</p><WriteNotice />
    <ReadState emptyMessage="No products match these filters.">
      <p className="muted" role="status">{rows.length} products on this page</p>
      {rows.length ? <div className="table-scroll" role="region" aria-label="Products table, scroll horizontally on narrow screens" tabIndex={0}>
        <table data-slot="table"><thead><tr><th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Status</th><th scope="col" className="numeric">Unit price</th><th scope="col" className="numeric">Available quantity</th></tr></thead>
          <tbody>{rows.map(product => <tr key={product.id}><th scope="row"><Link to={'/admin/products/' + product.id + location.search}>{product.name}</Link></th>
            <td className="sku">{product.sku}</td><td><Badge tone={product.id === 'bottle' ? 'warning' : 'success'}>{product.id === 'bottle' ? 'Inactive' : 'Active'}</Badge></td>
            <td className="numeric">{money(product.price)}</td><td className="numeric">{product.stock}</td></tr>)}</tbody></table>
      </div> : <div className="empty-state"><h2>No products match these filters.</h2></div>}
    </ReadState>
    <nav data-slot="pagination" className="pagination" aria-label="Admin product pages"><Button variant="secondary" disabled>Previous</Button><span>Page 1</span><Button variant="secondary" disabled>Next</Button></nav>
  </>;
}

export function AdminProduct() {
  const store = usePreview(); const { id } = useParams(); const location = useLocation(); const product = store.products.find(value => value.id === id);
  const [refreshed, setRefreshed] = useState(false);
  if (store.identity !== 'admin') return <Required />;
  if (!product) return <PageTitle title="Product unavailable" />;
  return <><PageTitle title={product.name} description="Administrator product details" /><div className="row">
    <Button variant="secondary" asChild><Link to={'/admin/products' + location.search}>Back to products</Link></Button>
    <Button variant="secondary" onClick={() => setRefreshed(true)}>Refresh</Button></div>
    {refreshed && <p role="status">Sample product and inventory observations refreshed. No request was sent.</p>}
    <ReadState><div className="product-detail-grid"><ProductPicture product={product} /><Card><CardHeader><h2>Product details</h2><p className="sku">{product.sku}</p></CardHeader>
      <Badge tone="success">Active</Badge><p className="price">{money(product.price)}</p><p>{product.description}</p>
      <p className="muted">Product reference: sample-{product.id}</p><p className="sku">Image URL: /fixtures/v1/{product.image}</p>
      <CardFooter><Button variant="secondary" asChild><Link to={'/admin/products/' + id + '/edit'}>Edit product</Link></Button>
        <Button asChild><Link to={'/admin/products/' + id + '/inventory'}>Adjust inventory quantity</Link></Button></CardFooter></Card></div>
      <section aria-label="Inventory" className="inventory-cards">{[['On hand', product.stock + 2], ['Reserved', 2], ['Available', product.stock]].map(([label, value]) =>
        <Card key={label}><h2>{label}</h2><p className="price">{value}</p></Card>)}</section>
      <p className="muted">Availability excludes reservations and may change after refresh.</p></ReadState>
  </>;
}

export function AdminForm({ edit = false }: { edit?: boolean }) {
  const store = usePreview(); const { id } = useParams(); const product = edit ? store.products.find(value => value.id === id) : undefined;
  const [name, setName] = useState(product?.name ?? ''); const [sku, setSku] = useState(product?.sku ?? '');
  const [price, setPrice] = useState(product ? (product.price / 100).toFixed(2) : '');
  const [errors, setErrors] = useState<Record<string, string>>({}); const [saved, setSaved] = useState(false);
  if (store.identity !== 'admin') return <Required />;
  if (edit && !product) return <PageTitle title="Product unavailable" />;
  return <div className="form-page"><PageTitle title={edit ? 'Edit product' : 'Create product'} description="Review public information. No real product is created or updated here." />
    <p><Link to="/admin/products">Back to products</Link></p><WriteNotice />
    <ReadState><Card><form noValidate onSubmit={event => {
      event.preventDefault(); const invalid: Record<string, string> = {};
      if (!name.trim()) invalid['admin-name'] = 'Enter a product name.';
      if (!sku.trim()) invalid['admin-sku'] = 'Enter a SKU.';
      if (!/^\d+(\.\d{1,2})?$/.test(price)) invalid['admin-price'] = 'Enter a nonnegative USD price with at most two decimal places.';
      setErrors(invalid); if (!Object.keys(invalid).length) setSaved(true);
    }}><Errors messages={errors} />
      {saved && <Alert title="Sample form reviewed" tone="success">No catalog data or server state was changed.</Alert>}
      <Field id="admin-name" label="Product name" required value={name} error={errors['admin-name'] ?? ''} onChange={event => setName(event.target.value)} />
      <Field id="admin-sku" label="SKU" required value={sku} error={errors['admin-sku'] ?? ''} onChange={event => setSku(event.target.value)} />
      <Field id="admin-price" label="Price (USD)" inputMode="decimal" required value={price} error={errors['admin-price'] ?? ''} onChange={event => setPrice(event.target.value)} />
      <div className="field"><label htmlFor="admin-description">Description</label><textarea id="admin-description" rows={4} defaultValue={product?.description ?? ''} /></div>
      <Field id="admin-image" label="Image path" placeholder="/fixtures/v1/lamp.svg" defaultValue={product?.image ? '/fixtures/v1/' + product.image : ''} />
      <p className="muted">{edit ? 'Metadata edits do not adjust inventory.' : 'Creation starts active with zero inventory.'} Server validation remains authoritative.</p>
      <Button type="submit" disabled={store.blocked}>{edit ? 'Review product changes' : 'Review new product'}</Button>
    </form></Card></ReadState>
  </div>;
}

export function InventoryPage() {
  const store = usePreview(); const { id } = useParams(); const product = store.products.find(value => value.id === id);
  const [quantity, setQuantity] = useState(''); const [confirm, setConfirm] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  if (store.identity !== 'admin') return <Required />;
  if (!product) return <PageTitle title="Product unavailable" />;
  return <div className="form-page"><PageTitle title="Adjust inventory" description={product.name + ' · ' + product.sku} />
    <p><Link to={'/admin/products/' + id}>Back to product</Link></p><WriteNotice />
    <ReadState><Card><CardHeader><h2>Current availability</h2><p className="price">{product.stock} units</p></CardHeader>
      <p className="muted">Reservations are separate. Inventory changes must preserve server invariants.</p>
      {done && <Alert title="Sample adjustment reviewed" tone="success">No inventory was changed.</Alert>}
      <form noValidate onSubmit={event => { event.preventDefault();
        if (!/^-?\d+$/.test(quantity) || Number(quantity) === 0) { setError('Enter a nonzero whole-number adjustment.'); return; }
        setError(''); setConfirm(true);
      }}><Field id="inventory-delta" label="Quantity adjustment" placeholder="For example, 5 or -2" inputMode="numeric" value={quantity} error={error} onChange={event => { setQuantity(event.target.value); setConfirm(false); }} />
        <Button type="submit" disabled={store.blocked}>Review adjustment</Button>
      </form>
      {confirm && <section className="confirmation" aria-label="Confirm inventory adjustment"><h3>Adjust by {quantity} units?</h3>
        <p>The server must validate available and reserved stock before committing.</p><div className="row">
          <Button disabled={store.blocked} onClick={() => { setDone(true); setConfirm(false); }}>Confirm sample adjustment</Button>
          <Button variant="secondary" onClick={() => setConfirm(false)}>Keep current stock</Button></div></section>}
    </Card></ReadState>
  </div>;
}
