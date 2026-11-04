import type { ReactNode } from 'react';
import { PageHeading } from './PageHeading';
import styles from './FormLayout.module.css';
import { Card } from './primitives/card';

export function FormLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card asChild className={`form-layout tw:p-4 tw:md:p-6 ${styles.page}`}><section>
      <PageHeading title={title} />
      {children}
    </section></Card>
  );
}
