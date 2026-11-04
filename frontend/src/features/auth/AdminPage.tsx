import { Link } from 'react-router';
import { PageHeading } from '../../shared/ui/PageHeading';
import styles from '../admin/admin.module.css';
import { Button } from '../../shared/ui/primitives/button';
import { Card } from '../../shared/ui/primitives/card';

export function AdminPage() {
  return <Card asChild className={`tw:p-4 tw:md:p-6 ${styles.page}`}><section>
    <PageHeading title="Administration" />
    <p>Your current account has administrator access.</p>
    <p><Button asChild><Link to="/admin/products">Browse products</Link></Button></p>
    <p><Link to="/account">Your account</Link></p>
    <p><Link to="/">Return home</Link></p>
  </section></Card>;
}
