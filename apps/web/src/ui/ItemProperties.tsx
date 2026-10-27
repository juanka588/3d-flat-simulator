import { itemDims, itemMountOf, validateLayout } from '@flat/scene';
import type { Item, ProductRecord, ProductSnapshot, Scene } from '@flat/scene';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, getProduct, serverRef, thumbnailUrl } from '../catalog/api';
import { flashNotice } from '../catalog/catalogStore';
import { formatDate, formatDims, formatPrice, isBuiltIn, isStale, itemName } from '../catalog/format';
import { snapshotOf } from '../catalog/place';
import { useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';
import { useSyncStore } from '../sync/sync-store';
import { activeModelController, modelStats } from '../viewer/model-runtime';

export type MeshBadge = { kind: 'real' | 'lookalike' | 'parametric' | 'offline' | 'loading'; label: string; title: string };

/** The mesh source badge (real / lookalike / parametric / offline), from the model controller's stats. */
export function meshBadge(source: string | undefined, offline: boolean): MeshBadge {
  if (offline) return { kind: 'offline', label: 'offline', title: 'The real model needs the local scene server; a stand-in shape at the exact size is drawn.' };
  switch (source) {
    case 'provider':
      return { kind: 'real', label: 'real model', title: "The retailer's own 3D model, streamed by the local server." };
    case 'lookalike':
      return { kind: 'lookalike', label: 'lookalike', title: 'A similar library model scaled to the exact size.' };
    case 'parametric':
      return { kind: 'parametric', label: 'parametric', title: 'A generated shape at the exact size.' };
    default:
      return { kind: 'loading', label: 'loading', title: 'The model is loading.' };
  }
}

/** Re-renders when the model controller reports a change (a model arrived or fell back). */
function useModelRevision(): number {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const c = activeModelController();
    return c?.subscribe(() => setRev((r) => r + 1));
  }, []);
  return rev;
}

export function useMeshBadge(itemId: string): MeshBadge {
  useModelRevision();
  const stats = modelStats();
  return meshBadge(stats.sources[itemId], stats.offline.includes(itemId));
}

/** What `validateLayout` says about one item. */
export function itemMessages(scene: Scene, item: Item): string[] {
  const roomId = item.roomId ?? scene.rooms.find((r) => r.id === item.roomId)?.id;
  try {
    const report = validateLayout(scene, roomId !== undefined ? { roomId } : {});
    return [...report.violations, ...report.warnings].filter((v) => v.entityIds.includes(item.id)).map((v) => v.message);
  } catch {
    return [];
  }
}

/** The product snapshot of a chosen variant, resolved from the server's record (never invented). */
export function variantSnapshot(record: ProductRecord, base: ProductSnapshot, sku: string): { snapshot: ProductSnapshot; variant: string; dims: ProductSnapshot['dims'] | null } | null {
  const v = record.variants.find((x) => x.sku === sku);
  if (v) {
    return {
      variant: v.sku,
      dims: v.dims ?? null,
      snapshot: { ...snapshotOf(record, new Date(), v.colour), sku: v.sku, name: v.name ?? record.name, price: v.price ?? record.price, dims: v.dims ?? record.dims, url: v.url ?? record.url },
    };
  }
  if (record.colours.includes(sku)) return { variant: sku, dims: null, snapshot: { ...base, snapshotAt: new Date().toISOString(), colour: sku } };
  return null;
}

/** Details, variants, validation and actions of the selected item (D10). */
export function ItemProperties({ scene, item }: { scene: Scene; item: Item }) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const select = useViewStore((s) => s.select);
  const mode = useSyncStore((s) => s.mode);
  const badge = useMeshBadge(item.id);
  const p = item.product;
  const builtIn = isBuiltIn(item);
  const dims = itemDims(item);
  const stale = p ? isStale(p.snapshotAt) : false;
  const messages = useMemo(() => itemMessages(scene, item), [scene, item]);
  const [fetched, setFetched] = useState<{ id: string; record: ProductRecord } | null>(null);
  const [busy, setBusy] = useState(false);

  // Variants and the photo come from the server's record; without a server the panel works from the snapshot.
  const refId = item.productRef ? `${item.productRef.provider}:${item.productRef.sku}` : undefined;
  const record = fetched && fetched.id === refId ? fetched.record : null;
  useEffect(() => {
    const ref = serverRef();
    if (!ref || !refId) return;
    let live = true;
    getProduct(ref, refId).then(
      (r) => live && setFetched({ id: refId, record: r }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [refId, mode]);

  const fail = (e: unknown) => flashNotice(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'The change was refused.');
  const run = (cmd: Parameters<typeof dispatch>[0], label: string) => {
    const r = dispatch(cmd, { label });
    if (!r.ok) flashNotice(r.errors[0]?.message ?? 'The change was refused.');
  };

  const chooseVariant = (sku: string) => {
    if (!record || !p) return;
    try {
      if (sku === '') {
        const base = snapshotOf(record, new Date());
        return run({ type: 'item.setVariant', id: item.id, variant: null, product: base, dims: record.dims }, `Reset ${itemName(item)}`);
      }
      const v = variantSnapshot(record, p, sku);
      if (!v) return;
      run({ type: 'item.setVariant', id: item.id, variant: v.variant, product: v.snapshot, dims: v.snapshot.dims }, `Variant of ${itemName(item)}`);
    } catch (e) {
      fail(e);
    }
  };

  const refresh = async () => {
    const ref = serverRef();
    if (!ref || !p || !refId) return;
    setBusy(true);
    try {
      const fresh = await getProduct(ref, refId);
      setFetched({ id: refId, record: fresh });
      const colour = p.colour;
      const snap = snapshotOf(fresh, new Date(), colour);
      run({ type: 'item.setVariant', id: item.id, variant: item.variant ?? null, product: snap, dims: snap.dims }, `Update price of ${itemName(item)}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = () => {
    const index = scene.items.findIndex((i) => i.id === item.id);
    const next: Item = item.locked ? (({ locked: _l, ...rest }) => rest)(item) : { ...item, locked: true };
    run(
      {
        type: 'batch',
        label: `${item.locked ? 'Unlock' : 'Lock'} ${itemName(item)}`,
        commands: [
          { type: 'item.remove', id: item.id },
          { type: 'item.place', item: next, index },
        ],
      } as Parameters<typeof dispatch>[0],
      `${item.locked ? 'Unlock' : 'Lock'} ${itemName(item)}`,
    );
  };

  const photo = thumbnailUrl(record?.photoUrl, serverRef());
  const variantOptions = record ? [...record.variants.map((v) => ({ value: v.sku, label: `${v.colour ?? v.name ?? v.sku}${v.price !== undefined ? ` · ${formatPrice(v.price, record.currency)}` : ''}` })), ...(record.variants.length === 0 ? record.colours.map((c) => ({ value: c, label: c })) : [])] : [];
  const chosen = item.variant ?? '';

  return (
    <div className="item-props" data-testid="item-properties">
      <div className="item-head">
        {photo && <img className="item-photo" src={photo} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
        <div className="item-badges">
          {builtIn && (
            <span className="badge badge-locked" data-testid="badge-builtin">
              Built-in (locked)
            </span>
          )}
          {!builtIn && item.locked && (
            <span className="badge badge-locked" data-testid="badge-locked">
              Locked
            </span>
          )}
          {!p && !builtIn && (
            <span className="badge badge-warn" data-testid="badge-no-product" title="A library shape: it has no price and no link.">
              no product
            </span>
          )}
          <span className={`badge badge-mesh badge-${badge.kind}`} data-testid="badge-mesh" data-source={badge.kind} title={badge.title}>
            {badge.label}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>Name</dt>
          <dd data-testid="item-name">{itemName(item)}</dd>
        </div>
        {p && (
          <>
            <div>
              <dt>Price</dt>
              <dd data-testid="item-price">{formatPrice(p.price, p.currency)} TTC</dd>
            </div>
            <div>
              <dt>Price date</dt>
              <dd data-testid="item-date">
                <time dateTime={p.snapshotAt}>{formatDate(p.snapshotAt)}</time>
                {stale && (
                  <span className="badge badge-warn" data-testid="stale-badge" title="This price is more than 7 days old.">
                    stale
                  </span>
                )}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Size</dt>
          <dd>{formatDims(dims)}</dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd>{scene.rooms.find((r) => r.id === item.roomId)?.name ?? item.roomId ?? '-'}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>
            {item.position[0].toFixed(2)}, {item.position[1].toFixed(2)} m · {item.rotation}°
            {itemMountOf(item) !== 'floor' ? ` · ${itemMountOf(item)} at ${item.elevation.toFixed(2)} m` : ''}
          </dd>
        </div>
      </dl>
      {p && (
        <p>
          <a href={p.url} target="_blank" rel="noopener noreferrer" data-testid="item-link">
            Product page ↗
          </a>
        </p>
      )}
      {p && stale && (
        <button type="button" onClick={() => void refresh()} disabled={busy || mode !== 'server' || item.locked === true} title={mode === 'server' ? 'Read the price and size again from the server' : 'Connect the scene server to refresh'} data-testid="update-price">
          {busy ? 'Updating…' : 'Update price/dims'}
        </button>
      )}
      {variantOptions.length > 0 && !item.locked && (
        <label className="variant-picker">
          Variant
          <select value={variantOptions.some((o) => o.value === chosen) ? chosen : ''} onChange={(e) => chooseVariant(e.target.value)} data-testid="variant-select">
            <option value="">{p?.colour ? `${p.colour} (current)` : 'Original'}</option>
            {variantOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {messages.length > 0 ? (
        <ul className="item-messages" role="status" data-testid="item-messages">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : (
        <p className="hint" data-testid="item-messages-ok">No layout problems.</p>
      )}
      <div className="item-actions">
        {!item.locked && (
          <>
            <button type="button" onClick={() => run({ type: 'item.rotate', id: item.id, rotation: (item.rotation + 90) % 360 }, `Rotate ${itemName(item)}`)} title="Rotate 90° (R)">
              Rotate 90°
            </button>
            <button type="button" onClick={() => run({ type: 'item.remove', id: item.id }, `Remove ${itemName(item)}`)} data-testid="remove-item" title="Remove (Delete)">
              Remove
            </button>
          </>
        )}
        {!builtIn && (
          <button type="button" onClick={toggleLock} data-testid="lock-toggle" aria-pressed={item.locked === true} title="Locked items stay put: the assistant cannot move them">
            {item.locked ? 'Unlock' : 'Lock'}
          </button>
        )}
        <button type="button" className="link" onClick={() => select(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
