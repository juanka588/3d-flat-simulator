import { useId } from 'react';
import { useCatalogStore } from '../catalog/catalogStore';
import type { CatalogTab } from '../catalog/catalogStore';
import { LibraryTab } from './LibraryTab';
import { ProductsTab } from './ProductsTab';

/**
 * The catalog (D10): real products from the local server, and the library of generators and CC0 models.
 * A card is dragged onto the 3D view to place it (see `catalog/placement.ts`).
 */
export default function CatalogPanel({ onDragStart }: { onDragStart?: () => void }) {
  const tab = useCatalogStore((s) => s.tab);
  const setTab = useCatalogStore((s) => s.setTab);
  const id = useId();
  const tabs: { id: CatalogTab; label: string }[] = [
    { id: 'products', label: 'Products' },
    { id: 'library', label: 'Library' },
  ];
  return (
    <section className="panel catalog" aria-label="Catalog" data-testid="catalog">
      <h2>Catalog</h2>
      <div role="tablist" aria-label="Catalog sections" className="catalog-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`${id}-${t.id}`} aria-selected={tab === t.id} aria-controls={`${id}-panel`} aria-pressed={undefined} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === 'products' ? <ProductsTab onDragStart={onDragStart} /> : <LibraryTab onDragStart={onDragStart} />}
      </div>
    </section>
  );
}
