import { summarizeProduct } from '@flat/scene';
import type { ProductRecord, ProductSummary, ProviderInfo } from '@flat/scene';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, draftFromDimsError, fetchProviders, getProduct, recordWithUserDims, resolveUrl, searchProducts, serverRef, thumbnailUrl } from '../catalog/api';
import type { ServerRef } from '../catalog/api';
import { useCatalogStore } from '../catalog/catalogStore';
import { formatDims, formatPrice } from '../catalog/format';
import { productSource } from '../catalog/place';
import { providerView, personalUseBanner, productsAvailability, SERVER_HINT, SEARCH_MIN_CHARS, SEARCH_DEBOUNCE_MS } from '../catalog/panel-state';
import { useCardDrag } from '../catalog/use-card-drag';
import { useSyncStore } from '../sync/sync-store';

/** Records already read from the server (a card warms its record on press / hover so a drop does not wait). */
const records = new Map<string, ProductRecord>();

async function recordOf(ref: ServerRef, productId: string): Promise<ProductRecord> {
  const hit = records.get(productId);
  if (hit) return hit;
  const r = await getProduct(ref, productId);
  records.set(productId, r);
  return r;
}

export function ProductsTab({ onDragStart }: { onDragStart?: (() => void) | undefined }) {
  const mode = useSyncStore((s) => s.mode);
  const status = useSyncStore((s) => s.status);
  const serverUrl = useSyncStore((s) => s.serverUrl);
  const availability = productsAvailability({ mode, status, serverUrl });
  if (availability === 'no-server') return <p className="hint" data-testid="catalog-server-hint">{SERVER_HINT}</p>;
  return <ServerProducts onDragStart={onDragStart} />;
}

function ServerProducts({ onDragStart }: { onDragStart?: (() => void) | undefined }) {
  const { providers, providersLoaded, query, results, statuses, searching, searchError, providerFilter } = useCatalogStore();
  const store = useCatalogStore.getState;
  const [pasted, setPasted] = useState<ProductSummary[]>([]);

  // Providers: read once the server is there.
  const serverUrl = useSyncStore((s) => s.serverUrl);
  useEffect(() => {
    const ref = serverRef();
    if (!ref) return;
    let live = true;
    fetchProviders(ref)
      .then((p) => live && store().setProviders(p))
      .catch(() => live && store().setProviders([]));
    return () => {
      live = false;
    };
  }, [serverUrl, store]);

  // Search, debounced; a newer query supersedes an older answer.
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      store().setSearch({ results: [], statuses: [], searching: false, searchError: null });
      return;
    }
    const ref = serverRef();
    if (!ref) return;
    const mine = ++seq.current;
    store().setSearch({ searching: true, searchError: null });
    const timer = setTimeout(() => {
      searchProducts(ref, { q, ...(providerFilter ? { provider: providerFilter } : {}) })
        .then((r) => {
          if (mine !== seq.current) return;
          store().setSearch({ results: r.results, statuses: r.providers, searching: false });
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          store().setSearch({ results: [], statuses: [], searching: false, searchError: e instanceof ApiError ? e.message : 'The search failed.' });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, providerFilter, serverUrl, store]);

  const banner = personalUseBanner(providers);
  const failing = statuses.filter((s) => !s.ok);
  return (
    <div className="catalog-products" data-testid="catalog-products">
      {banner && (
        <p className="personal-banner" role="note" data-testid="personal-use-banner">
          {banner}
        </p>
      )}
      <ProviderChips providers={providers} loaded={providersLoaded} />
      <label className="catalog-search">
        <span className="visually-hidden">Search products</span>
        <input type="search" placeholder="Search products (bed, sofa, desk…)" value={query} onChange={(e) => store().setQuery(e.target.value)} data-testid="catalog-search" />
      </label>
      <PasteUrl onResolved={(r) => setPasted((p) => [summarizeProduct(r), ...p.filter((x) => x.productId !== summarizeProduct(r).productId)])} />
      {searching && <p className="hint" role="status">Searching…</p>}
      {searchError && <p className="catalog-error" role="alert">{searchError}</p>}
      {failing.map((s) => (
        <p key={s.provider} className="catalog-error" role="status">
          {s.provider}: {s.message ?? s.code ?? 'failed'}
        </p>
      ))}
      <ul className="product-list" data-testid="product-results">
        {pasted.map((p) => (
          <ProductCard key={`pasted-${p.productId}`} product={p} pasted onDragStart={onDragStart} />
        ))}
        {results.map((p) => (
          <ProductCard key={p.productId} product={p} onDragStart={onDragStart} />
        ))}
      </ul>
      {!searching && query.trim().length >= SEARCH_MIN_CHARS && results.length === 0 && !searchError && failing.length === 0 && <p className="hint">No product found.</p>}
      {query.trim().length < SEARCH_MIN_CHARS && results.length === 0 && pasted.length === 0 && <p className="hint">Type at least {SEARCH_MIN_CHARS} letters, then drag a card onto the view.</p>}
    </div>
  );
}

function ProviderChips({ providers, loaded }: { providers: ProviderInfo[]; loaded: boolean }) {
  const filter = useCatalogStore((s) => s.providerFilter);
  const setFilter = useCatalogStore((s) => s.setProviderFilter);
  if (!loaded) return null;
  if (providers.length === 0) return <p className="hint">No product provider is enabled on the server (set FLAT_PROVIDERS).</p>;
  return (
    <div className="provider-chips" role="group" aria-label="Providers">
      {providers.map((p) => {
        const v = providerView(p);
        return (
          <button key={p.id} type="button" className={`chip circuit-${p.circuit}`} data-provider={p.id} data-circuit={p.circuit} data-enabled={p.enabled} aria-pressed={filter === p.id} disabled={!p.enabled} title={v.tooltip} onClick={() => setFilter(filter === p.id ? null : p.id)}>
            <span className="dot" aria-hidden="true" />
            {p.label.replace(/\s*\(.*\)\s*$/, '')}
            <span className="visually-hidden"> ({v.state})</span>
          </button>
        );
      })}
    </div>
  );
}

function PasteUrl({ onResolved }: { onResolved: (r: ProductRecord) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string | undefined } | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [cm, setCm] = useState({ w: '', d: '', h: '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ref = serverRef();
    if (!ref || !url.trim()) return;
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const r = await resolveUrl(ref, url.trim());
      records.set(`${r.provider}:${r.sku}`, r);
      onResolved(r);
      setUrl('');
    } catch (err) {
      if (err instanceof ApiError) {
        const d = draftFromDimsError(err);
        if (d) {
          setDraft(d);
          setCm({ w: '', d: '', h: '' });
        }
        setError({ message: err.message, hint: err.hint });
      } else setError({ message: 'The page could not be read.' });
    } finally {
      setBusy(false);
    }
  };

  const complete = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const w = Number(cm.w);
    const d = Number(cm.d);
    const h = Number(cm.h);
    if (!(w > 0 && d > 0 && h > 0)) return setError({ message: 'Enter the width, depth and height in centimetres.' });
    try {
      const r = recordWithUserDims(draft, { w, d, h });
      records.set(`${r.provider}:${r.sku}`, r);
      onResolved(r);
      setDraft(null);
      setError(null);
      setUrl('');
    } catch {
      setError({ message: 'Those dimensions are not valid (0.01–10 m each).' });
    }
  };

  return (
    <form className="paste-url" onSubmit={(e) => void submit(e)}>
      <label>
        <span className="visually-hidden">Paste a product URL</span>
        <input type="url" placeholder="…or paste a product URL" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="paste-url" />
      </label>
      <button type="submit" disabled={busy || !url.trim()}>
        {busy ? '…' : 'Add'}
      </button>
      {error && (
        <p className="catalog-error" role="alert" data-testid="paste-error">
          {error.message}
          {error.hint ? ` ${error.hint}` : ''}
        </p>
      )}
      {draft && (
        <fieldset className="dims-form" data-testid="dims-form">
          <legend>Size of the product (cm)</legend>
          {(['w', 'd', 'h'] as const).map((k) => (
            <label key={k}>
              {k === 'w' ? 'Width' : k === 'd' ? 'Depth' : 'Height'}
              <input type="number" min="1" max="1000" step="0.5" inputMode="decimal" value={cm[k]} onChange={(e) => setCm({ ...cm, [k]: e.target.value })} data-testid={`dims-${k}`} />
            </label>
          ))}
          <button type="button" onClick={complete} data-testid="dims-submit">
            Use these sizes
          </button>
        </fieldset>
      )}
    </form>
  );
}

export function ProductCard({ product, pasted = false, onDragStart }: { product: ProductSummary; pasted?: boolean; onDragStart?: (() => void) | undefined }) {
  const ref = serverRef();
  const [record, setRecord] = useState<ProductRecord | undefined>(() => records.get(product.productId));
  const [photoFailed, setPhotoFailed] = useState(false);
  const warm = useCallback(() => {
    const r = serverRef();
    if (!r || record) return;
    recordOf(r, product.productId).then(setRecord, () => undefined);
  }, [product.productId, record]);
  const drag = useCardDrag({
    source: () => productSource(product),
    record: () => {
      const r = serverRef();
      if (!r) return Promise.reject(new Error('The scene server is not connected.'));
      return recordOf(r, product.productId);
    },
    onStart: onDragStart,
    disabled: !product.priceTtc,
  });
  const thumb = thumbnailUrl(product.photoUrl, ref);
  const openPage = async () => {
    const r = serverRef();
    if (!r) return;
    try {
      window.open((await recordOf(r, product.productId)).url, '_blank', 'noopener,noreferrer');
    } catch {
      // the card keeps working
    }
  };
  return (
    <li className="product-card" data-testid="product-card" data-product-id={product.productId} data-draggable={product.priceTtc} onPointerDown={drag.onPointerDown} onPointerEnter={warm} onFocus={warm} onDragStart={(e) => e.preventDefault()}>
      <div className="thumb" aria-hidden="true">
        {thumb && !photoFailed ? <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setPhotoFailed(true)} /> : <span>{product.category.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="meta">
        <strong className="name">{product.name}</strong>
        <span className="price" data-testid="card-price">
          {formatPrice(product.price, product.currency)}
          {product.priceTtc ? ' TTC' : ' (no VAT info: cannot be placed)'}
        </span>
        <span className="dims" data-testid="card-dims">
          {formatDims(product.dims)}
          {product.dimsSource === 'user' ? ' (your sizes)' : ''}
        </span>
        <span className="badges">
          {product.has3d && (
            <span className="badge badge-3d" title="The retailer has a 3D model of this product">
              3D
            </span>
          )}
          {pasted && <span className="badge">pasted</span>}
          {record ? (
            <a href={record.url} target="_blank" rel="noopener noreferrer">
              Product page ↗
            </a>
          ) : (
            <button type="button" className="link" onClick={() => void openPage()}>
              Product page ↗
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
