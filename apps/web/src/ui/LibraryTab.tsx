import { GENERATORS } from '@flat/scene';
import type { AnyGenerator } from '@flat/scene';
import { useEffect, useMemo, useState } from 'react';
import { addToRoom } from '../catalog/add-to-room';
import { formatDims } from '../catalog/format';
import { loadLibraryModels, matchesFilter } from '../catalog/library';
import type { LibraryModel } from '../catalog/library';
import { defaultParams, paramFields, resolveParams } from '../catalog/param-fields';
import type { ParamValues } from '../catalog/param-fields';
import { generatorSource, libraryModelSource } from '../catalog/place';
import { useCardDrag } from '../catalog/use-card-drag';

let modelsLoad: Promise<LibraryModel[]> | undefined;

/** Library: parametric generators (with a small parameter form) and the committed CC0 models. Items placed from here have no product. */
export function LibraryTab({ onDragStart }: { onDragStart?: (() => void) | undefined }) {
  const [filter, setFilter] = useState('');
  const [models, setModels] = useState<LibraryModel[]>([]);
  useEffect(() => {
    let live = true;
    void (modelsLoad ??= loadLibraryModels()).then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, []);
  const generators = GENERATORS.list().filter((g) => matchesFilter(filter, g.label, g.category, g.id));
  const shown = models.filter((m) => matchesFilter(filter, m.asset.name, m.asset.category, ...m.asset.styleTags));
  return (
    <div className="catalog-library" data-testid="catalog-library">
      <label className="catalog-search">
        <span className="visually-hidden">Filter the library</span>
        <input type="search" placeholder="Filter (sofa, bed…)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <p className="hint">Library shapes have no product: no price, no link.</p>
      <h3>Parametric</h3>
      <ul className="product-list">
        {generators.map((g) => (
          <GeneratorCard key={g.id} generator={g} onDragStart={onDragStart} />
        ))}
      </ul>
      <h3>Models (CC0)</h3>
      <ul className="product-list">
        {shown.map((m) => (
          <ModelCard key={m.asset.id} model={m} onDragStart={onDragStart} />
        ))}
      </ul>
      {models.length > 0 && shown.length === 0 && <p className="hint">No model matches.</p>}
    </div>
  );
}

function GeneratorCard({ generator, onDragStart }: { generator: AnyGenerator; onDragStart?: (() => void) | undefined }) {
  const fields = useMemo(() => paramFields(generator), [generator]);
  const [values, setValues] = useState<ParamValues>(() => defaultParams(generator));
  const [open, setOpen] = useState(false);
  const result = useMemo(() => resolveParams(generator, values), [generator, values]);
  const drag = useCardDrag({
    source: () => {
      const r = resolveParams(generator, values);
      if (!r.ok) throw new Error(r.error);
      return generatorSource(generator, r.params, r.dims);
    },
    onStart: onDragStart,
    disabled: !result.ok,
  });
  return (
    <li className="product-card generator-card" data-testid="generator-card" data-generator={generator.id} onPointerDown={drag.onPointerDown} onDragStart={(e) => e.preventDefault()}>
      <div className="thumb" aria-hidden="true">
        <span>{generator.label.slice(0, 1)}</span>
      </div>
      <div className="meta">
        <strong className="name">{generator.label}</strong>
        <span className="dims">{result.ok ? formatDims(result.dims) : 'invalid parameters'}</span>
        <span className="badges">
          <span className="badge">parametric</span>
          <button type="button" className="add-to-room" data-testid="add-to-room" disabled={!result.ok} aria-label={`Add ${generator.label} to the room`} title="Place it in the selected room (or the first room) at a spot the solver finds" onClick={() => result.ok && void addToRoom(generatorSource(generator, result.params, result.dims))}>
            Add to room
          </button>
          {fields.length > 0 && (
            <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide sizes' : 'Sizes…'}
            </button>
          )}
        </span>
        {open && (
          <div className="param-form">
            {fields.map((f) => (
              <label key={f.key} title={f.hint}>
                <span>{f.label}</span>
                {f.kind === 'number' ? (
                  <input type="number" value={Number(values[f.key] ?? f.def)} min={f.min} max={f.max} step={f.step} onChange={(e) => e.target.value !== '' && setValues({ ...values, [f.key]: Number(e.target.value) })} />
                ) : f.kind === 'boolean' ? (
                  <input type="checkbox" checked={Boolean(values[f.key] ?? f.def)} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />
                ) : (
                  <select value={String(values[f.key] ?? f.def)} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                )}
              </label>
            ))}
            {!result.ok && <p className="catalog-error">{result.error}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

function ModelCard({ model, onDragStart }: { model: LibraryModel; onDragStart?: (() => void) | undefined }) {
  const { asset } = model;
  const drag = useCardDrag({ source: () => libraryModelSource(asset), onStart: onDragStart });
  return (
    <li className="product-card model-card" data-testid="model-card" data-asset-id={asset.id} onPointerDown={drag.onPointerDown} onDragStart={(e) => e.preventDefault()} title={asset.credit ?? asset.licence}>
      <div className="thumb" aria-hidden="true">
        {model.thumb ? <img src={model.thumb} alt="" loading="lazy" draggable={false} /> : <span>{asset.name.slice(0, 1)}</span>}
      </div>
      <div className="meta">
        <strong className="name">{asset.name}</strong>
        <span className="dims">{formatDims(asset.nativeDims)}</span>
        <span className="badges">
          <span className="badge">{asset.licence}</span>
          <button type="button" className="add-to-room" data-testid="add-to-room" aria-label={`Add ${asset.name} to the room`} title="Place it in the selected room (or the first room) at a spot the solver finds" onClick={() => void addToRoom(libraryModelSource(asset))}>
            Add to room
          </button>
        </span>
      </div>
    </li>
  );
}
