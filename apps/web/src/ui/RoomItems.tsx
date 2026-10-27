import { billOfMaterials } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { useEffect, useMemo, useState } from 'react';
import { bomView, formatPrice } from '../catalog/format';
import { useViewStore } from '../state/viewStore';
import { modelStats } from '../viewer/model-runtime';
import { useModelRevision } from '../viewer/use-model-revision';

/** The clock, ticking once a minute (a price turns stale while the page stays open). */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Items per room with TTC prices and a total for the flat (existing furniture counts 0, locked products keep their price; stale prices are flagged). */
export function RoomItems({ scene }: { scene: Scene }) {
  const select = useViewStore((s) => s.select);
  const selected = useViewStore((s) => s.selection?.entityId);
  useModelRevision();
  const now = useNow();
  const view = useMemo(() => bomView(scene, billOfMaterials(scene, { now })), [scene, now]);
  const offline = new Set(modelStats().offline);
  if (view.itemCount === 0) return null;
  return (
    <section className="panel room-items" aria-label="Items" data-testid="room-items" data-item-keys="">
      <h2>Items</h2>
      {view.rooms.map((room) => (
        <div key={room.roomId} className="room-block" data-room={room.roomId}>
          <h3>
            {room.name} <span className="room-total" data-testid={`room-total-${room.roomId}`}>{formatPrice(room.totalEur, 'EUR')}</span>
          </h3>
          <ul>
            {room.lines.map((l) => (
              <li key={l.itemId}>
                <button type="button" className={`link${selected === l.itemId ? ' current' : ''}`} onClick={() => select({ kind: 'item', entityId: l.itemId })}>
                  {l.name}
                </button>
                <span className="line-price">{l.price}</span>
                {l.locked && <span className="badge badge-locked">locked</span>}
                {l.stale && <span className="badge badge-warn" title="Price older than 7 days">stale</span>}
                {l.noProduct && !l.existing && <span className="badge badge-warn">no product</span>}
                {offline.has(l.itemId) && <span className="badge" title="Real model unavailable without the server">offline</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="flat-total" data-testid="flat-total">
        <strong>Flat total</strong> <span>{formatPrice(view.totalEur, 'EUR')} TTC</span>
      </p>
      {(view.missingPrice > 0 || view.mixedCurrency) && (
        <p className="hint">
          {view.missingPrice > 0 ? `${view.missingPrice} item${view.missingPrice === 1 ? ' has' : 's have'} no price. ` : ''}
          {view.mixedCurrency ? 'Prices in other currencies are not added.' : ''}
        </p>
      )}
    </section>
  );
}
