import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { listDocs } from './api'
import type { AdminBlockMeta, AdminFieldMeta, Doc } from './api'
import { useCollection } from './schema'
import { RichTextEditor } from './RichTextEditor'

interface InputProps {
  field: AdminFieldMeta
  value: unknown
  onChange: (value: unknown) => void
}

type Obj = Record<string, unknown>

// --- row keys --------------------------------------------------------------
// Array/blocks rows carry a client-only `_key` so drag-and-drop and React keys
// stay stable across reorders. Keys are injected when a doc loads and stripped
// before save (see withRowKeys / stripRowKeys, used by the views).

export function genKey(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : 'k' + Math.random().toString(36).slice(2)
}

/** Recursively ensure every array/blocks row in `value` has a stable `_key`. */
export function withRowKeys(fields: AdminFieldMeta[], value: Obj): Obj {
  const out: Obj = { ...value }
  for (const f of fields) {
    const v = out[f.name]
    if (f.type === 'group' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[f.name] = withRowKeys(f.fields ?? [], v as Obj)
    } else if (f.type === 'array' && Array.isArray(v)) {
      out[f.name] = (v as Obj[]).map((r) => ({ _key: genKey(), ...withRowKeys(f.fields ?? [], r) }))
    } else if (f.type === 'blocks' && Array.isArray(v)) {
      out[f.name] = (v as Obj[]).map((r) => {
        const def = (f.blocks ?? []).find((b) => b.slug === r.blockType)
        return { _key: genKey(), ...withRowKeys(def?.fields ?? [], r) }
      })
    }
  }
  return out
}

/** Recursively drop client-only `_key` props before submitting. */
export function stripRowKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRowKeys)
  if (value && typeof value === 'object') {
    const out: Obj = {}
    for (const [k, v] of Object.entries(value as Obj)) {
      if (k === '_key') continue
      out[k] = stripRowKeys(v)
    }
    return out
  }
  return value
}

// --- icons -----------------------------------------------------------------

const DragIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="4" cy="2" r="1.1" />
      <circle cx="8" cy="2" r="1.1" />
      <circle cx="4" cy="6" r="1.1" />
      <circle cx="8" cy="6" r="1.1" />
      <circle cx="4" cy="10" r="1.1" />
      <circle cx="8" cy="10" r="1.1" />
    </g>
  </svg>
)
const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 3 9 9M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const DuplicateIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <rect x="4.5" y="4.5" width="5" height="5" rx="1.2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)
const BlockGlyph = () => (
  <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
    <rect x="6" y="7" width="26" height="6" rx="2" fill="currentColor" opacity="0.85" />
    <rect x="6" y="17" width="26" height="14" rx="2" fill="currentColor" opacity="0.18" />
  </svg>
)

// ---------------------------------------------------------------------------

/** Project-registered custom field components, keyed by `admin.component`. Loaded
 *  via the server's `admin.scripts` option before the app boots. */
interface KernelGlobal {
  fields?: Record<string, (props: InputProps) => ReactNode>
}
function customFieldComponent(key: string | undefined): ((props: InputProps) => ReactNode) | undefined {
  if (!key) return undefined
  const reg = (globalThis as { KernelCMS?: KernelGlobal }).KernelCMS
  return reg?.fields?.[key]
}

export function FieldInput({ field, value, onChange }: InputProps) {
  const readOnly = field.admin?.readOnly
  const placeholder = field.admin?.placeholder

  // A registered custom component wins over the built-in renderer.
  const Custom = customFieldComponent(field.admin?.component)
  if (Custom) return <Custom field={field} value={value} onChange={onChange} />

  switch (field.type) {
    case 'text':
    case 'email':
    case 'slug':
    case 'code':
      return (
        <input
          className="input"
          type={field.type === 'email' ? 'email' : 'text'}
          value={(value as string) ?? ''}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'password':
      return (
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={(value as string) ?? ''}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'textarea':
      return (
        <textarea
          className="input"
          rows={4}
          value={(value as string) ?? ''}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <input
          className="input"
          type="number"
          value={value === null || value === undefined ? '' : (value as number)}
          min={field.min}
          max={field.max}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
    case 'boolean':
    case 'checkbox':
      return (
        <label className="switch">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span>{value ? 'On' : 'Off'}</span>
        </label>
      )
    case 'date': {
      const local = toLocalInput(value)
      return (
        <input
          className="input"
          type="datetime-local"
          value={local}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      )
    }
    case 'select':
    case 'radio':
      return field.hasMany ? (
        <CheckList
          options={(field.options ?? []).map((o) => ({ id: o.value, label: o.label }))}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
        />
      ) : (
        <select className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          {field.defaultValue === undefined && <option value="">{field.required ? 'Select…' : '— none —'}</option>}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'relationship':
    case 'upload':
      if (Array.isArray(field.relationTo)) {
        // Single polymorphic ref gets a collection+document picker; the hasMany
        // variant falls back to JSON until a dedicated multi-picker lands.
        return field.hasMany ? (
          <JsonInput value={value} onChange={onChange} />
        ) : (
          <PolymorphicRelationshipInput field={field} value={value} onChange={onChange} />
        )
      }
      return <RelationshipInput field={field} value={value} onChange={onChange} />
    case 'richText':
      return field.richText ? (
        <RichTextEditor meta={field.richText} value={value} onChange={onChange} readOnly={readOnly} />
      ) : (
        <JsonInput value={value} onChange={onChange} />
      )
    case 'group':
      return <GroupInput field={field} value={value} onChange={onChange} />
    case 'array':
      return <ArrayInput field={field} value={value} onChange={onChange} />
    case 'blocks':
      return <BlocksInput field={field} value={value} onChange={onChange} />
    default:
      return <JsonInput value={value} onChange={onChange} />
  }
}

/** Render a list of nested fields against an object value. */
function NestedFields({
  fields,
  value,
  onChange,
}: {
  fields: AdminFieldMeta[]
  value: Obj
  onChange: (next: Obj) => void
}) {
  return (
    <>
      {fields.map((f) => (
        <div className="field" key={f.name}>
          <label className="field-label">
            {f.label}
            {f.required && <span className="req">*</span>}
          </label>
          {f.admin?.description && <div className="field-help">{f.admin.description}</div>}
          <FieldInput field={f} value={value?.[f.name]} onChange={(val) => onChange({ ...value, [f.name]: val })} />
        </div>
      ))}
    </>
  )
}

// --- sortable primitives (dnd-kit) -----------------------------------------

function Sortable({
  ids,
  onReorder,
  children,
}: {
  ids: string[]
  onReorder: (from: number, to: number) => void
  children: ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) onReorder(from, to)
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

function SortableItem({
  id,
  children,
}: {
  id: string
  children: (handle: { ref: (el: HTMLElement | null) => void; props: Record<string, unknown> }) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
    opacity: isDragging ? 0.7 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'is-dragging' : undefined}>
      {children({ ref: setActivatorNodeRef, props: { ...attributes, ...listeners } })}
    </div>
  )
}

function GroupInput({ field, value, onChange }: InputProps) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
  return (
    <div className="nested group">
      <NestedFields fields={field.fields ?? []} value={obj} onChange={onChange} />
    </div>
  )
}

function ArrayInput({ field, value, onChange }: InputProps) {
  const rows = Array.isArray(value) ? (value as Obj[]) : []
  const ids = rows.map((r) => String(r._key))
  const set = (next: Obj[]) => onChange(next)
  return (
    <div className="nested array">
      {rows.length > 0 && (
        <Sortable ids={ids} onReorder={(from, to) => set(arrayMove(rows, from, to))}>
          <div className="array-list">
            {rows.map((row, i) => (
              <SortableItem id={String(row._key)} key={String(row._key)}>
                {(handle) => (
                  <div className="nested-row">
                    <div className="nested-row-head">
                      <button
                        ref={handle.ref}
                        type="button"
                        className="drag"
                        {...handle.props}
                        aria-label="Drag to reorder"
                      >
                        <DragIcon />
                      </button>
                      <span className="muted">
                        {field.label} {i + 1}
                      </span>
                      <span className="spacer" />
                      <button
                        type="button"
                        className="icon-btn"
                        title="Remove"
                        onClick={() => set(rows.filter((_, idx) => idx !== i))}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                    <NestedFields
                      fields={field.fields ?? []}
                      value={row}
                      onChange={(v) => set(rows.map((r, idx) => (idx === i ? { ...v, _key: r._key } : r)))}
                    />
                  </div>
                )}
              </SortableItem>
            ))}
          </div>
        </Sortable>
      )}
      <button type="button" className="btn ghost" onClick={() => set([...rows, { _key: genKey() }])}>
        + Add row
      </button>
    </div>
  )
}

function BlocksInput({ field, value, onChange }: InputProps) {
  const blocks = field.blocks ?? []
  const rows = Array.isArray(value) ? (value as Obj[]) : []
  const ids = rows.map((r) => String(r._key))
  const [libOpen, setLibOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const set = (next: Obj[]) => onChange(next)
  const defFor = (slug: unknown) => blocks.find((b) => b.slug === slug)

  const add = (slug: string) => {
    set([...rows, { _key: genKey(), blockType: slug }])
    setLibOpen(false)
  }
  const duplicate = (i: number) => {
    const copy = { ...rows[i], _key: genKey() }
    const next = [...rows]
    next.splice(i + 1, 0, copy)
    set(next)
  }

  return (
    <div className="nested blocks">
      {rows.length > 0 && (
        <Sortable ids={ids} onReorder={(from, to) => set(arrayMove(rows, from, to))}>
          <div className="blocks-list">
            {rows.map((row, i) => {
              const def = defFor(row.blockType)
              const key = String(row._key)
              const isCollapsed = collapsed[key]
              return (
                <SortableItem id={key} key={key}>
                  {(handle) => (
                    <div
                      className={`block-card${isCollapsed ? ' is-collapsed' : ''}`}
                      data-path={`${field.name}.${i}`}
                    >
                      <div className="block-head">
                        <button
                          ref={handle.ref}
                          type="button"
                          className="drag"
                          {...handle.props}
                          aria-label="Drag to reorder"
                        >
                          <DragIcon />
                        </button>
                        <span className="block-num">{String(i + 1).padStart(2, '0')}</span>
                        <span className="block-pill">{def?.labels.singular ?? String(row.blockType)}</span>
                        <span className="spacer" />
                        <button type="button" className="icon-btn" title="Duplicate" onClick={() => duplicate(i)}>
                          <DuplicateIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Remove"
                          onClick={() => set(rows.filter((_, idx) => idx !== i))}
                        >
                          <CloseIcon />
                        </button>
                        <button
                          type="button"
                          className={`icon-btn chevron${isCollapsed ? ' rot' : ''}`}
                          title={isCollapsed ? 'Expand' : 'Collapse'}
                          onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                        >
                          <Chevron />
                        </button>
                      </div>
                      {!isCollapsed &&
                        (def ? (
                          <div className="block-body">
                            <NestedFields
                              fields={def.fields}
                              value={row}
                              onChange={(v) =>
                                set(
                                  rows.map((r, idx) =>
                                    idx === i ? { ...v, _key: r._key, blockType: r.blockType } : r,
                                  ),
                                )
                              }
                            />
                          </div>
                        ) : (
                          <div className="block-body field-error">Unknown block “{String(row.blockType)}”.</div>
                        ))}
                    </div>
                  )}
                </SortableItem>
              )
            })}
          </div>
        </Sortable>
      )}
      <button type="button" className="btn add-section" onClick={() => setLibOpen(true)} disabled={blocks.length === 0}>
        + Add section
      </button>
      {libOpen && <SectionLibrary blocks={blocks} onPick={add} onClose={() => setLibOpen(false)} />}
    </div>
  )
}

// --- section library modal --------------------------------------------------

function SectionLibrary({
  blocks,
  onPick,
  onClose,
}: {
  blocks: AdminBlockMeta[]
  onPick: (slug: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const matched = blocks.filter(
    (b) =>
      !term || b.labels.singular.toLowerCase().includes(term) || (b.description ?? '').toLowerCase().includes(term),
  )
  const order: string[] = []
  const byGroup = new Map<string, AdminBlockMeta[]>()
  for (const b of matched) {
    const g = b.group ?? ''
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      order.push(g)
    }
    byGroup.get(g)!.push(b)
  }
  // ungrouped first
  order.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0))

  return (
    <div className="lib-overlay" onMouseDown={onClose}>
      <div className="lib-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <h3>Add a section</h3>
          <button type="button" className="icon-btn lg" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <input
          className="input lib-search"
          autoFocus
          placeholder="Search sections…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="lib-body">
          {order.map((g) => (
            <div className="lib-group" key={g || '_'}>
              {g && <div className="lib-group-label">{g}</div>}
              <div className="lib-grid">
                {byGroup.get(g)!.map((b) => (
                  <button
                    type="button"
                    key={b.slug}
                    className="lib-card"
                    onClick={() => onPick(b.slug)}
                    title={b.description || b.labels.singular}
                  >
                    <div className="lib-thumb">
                      {b.thumbnail ? <img src={b.thumbnail} alt="" /> : <BlockGlyph />}
                      <span className="lib-card-cap">{b.labels.singular}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {matched.length === 0 && <div className="muted lib-empty">No sections match “{q}”.</div>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function CheckList({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string }>
  value: string[]
  onChange: (v: unknown) => void
}) {
  return (
    <div className="checklist">
      {options.map((o) => (
        <label key={o.id} className="checkbox">
          <input
            type="checkbox"
            checked={value.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))}
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}

/** Picker for a polymorphic relationship (`relationTo: string[]`): choose the target
 *  collection, then a document. Stores `{ relationTo, value }`. */
function PolymorphicRelationshipInput({ field, value, onChange }: InputProps) {
  const collections = (Array.isArray(field.relationTo) ? field.relationTo : []) as string[]
  const ref =
    value && typeof value === 'object' && 'relationTo' in (value as object)
      ? (value as { relationTo: string; value: unknown })
      : null
  const [coll, setColl] = useState<string>(ref?.relationTo ?? collections[0] ?? '')
  const rel = useCollection(coll)
  const titleKey = rel?.useAsTitle ?? 'id'
  const { data, isLoading } = useQuery({
    queryKey: ['rel-options', coll],
    queryFn: () => listDocs(coll, { limit: 100, depth: 0 }),
    enabled: Boolean(coll),
  })
  const docs: Doc[] = data?.docs ?? []
  const label = (d: Doc): string => String(d[titleKey] ?? d.id)
  const currentId =
    ref && ref.relationTo === coll
      ? typeof ref.value === 'object' && ref.value
        ? (ref.value as Doc).id
        : String(ref.value ?? '')
      : ''
  return (
    <div className="poly-rel">
      <select
        className="input"
        aria-label="Related collection"
        value={coll}
        onChange={(e) => {
          setColl(e.target.value)
          onChange(null)
        }}
      >
        {collections.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="input"
        aria-label="Related document"
        value={currentId}
        onChange={(e) => onChange(e.target.value ? { relationTo: coll, value: e.target.value } : null)}
      >
        <option value="">{isLoading ? 'Loading…' : '— none —'}</option>
        {docs.map((d) => (
          <option key={d.id} value={d.id}>
            {label(d)}
          </option>
        ))}
      </select>
    </div>
  )
}

function RelationshipInput({ field, value, onChange }: InputProps) {
  const relSlug = (typeof field.relationTo === 'string' ? field.relationTo : '') || ''
  const rel = useCollection(relSlug)
  const titleKey = rel?.useAsTitle ?? 'id'
  const { data, isLoading } = useQuery({
    queryKey: ['rel-options', relSlug],
    queryFn: () => listDocs(relSlug, { limit: 100, depth: 0 }),
    enabled: Boolean(relSlug),
  })
  const docs: Doc[] = data?.docs ?? []
  const label = (doc: Doc): string => String(doc[titleKey] ?? doc.id)

  if (field.hasMany) {
    return (
      <CheckList
        options={docs.map((d) => ({ id: d.id, label: label(d) }))}
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={onChange}
      />
    )
  }
  const current = typeof value === 'object' && value ? (value as Doc).id : (value as string | null)
  return (
    <select className="input" value={current ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{isLoading ? 'Loading…' : '— none —'}</option>
      {docs.map((d) => (
        <option key={d.id} value={d.id}>
          {label(d)}
        </option>
      ))}
    </select>
  )
}

function JsonInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : JSON.stringify(value, null, 2)))
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <textarea
        className="input mono"
        rows={6}
        value={text}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          if (next.trim() === '') {
            setError(null)
            onChange(null)
            return
          }
          try {
            onChange(JSON.parse(next))
            setError(null)
          } catch {
            setError('Invalid JSON')
          }
        }}
      />
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}

function toLocalInput(value: unknown): string {
  if (!value) return ''
  const date = new Date(value as string)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 16)
}
