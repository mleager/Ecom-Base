import type { Inventory } from '../../shared/api/contracts';
import styles from './admin.module.css';

export function InventoryCounters({ inventory }: { inventory: Inventory }) {
  return <div className={styles.counters} role="group" aria-label="Last observed inventory counters">
    <p>On hand: {inventory.quantity_on_hand}</p>
    <p>Reserved: {inventory.quantity_reserved}</p>
    <p>Available: {inventory.quantity_available}</p>
  </div>;
}
