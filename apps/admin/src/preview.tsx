// Live-preview document. Loaded inside the editor's iframe (same origin). It
// pulls the content model from /_config, announces readiness to the parent
// editor, and re-renders whenever the parent posts the live form data. It
// renders the page's `blocks` into section markup. The built-in renderer knows
// the common section types and falls back to a generic view otherwise. A real
// project points live preview at its own frontend URL instead.
import { cloneElement, useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import DOMPurify from 'dompurify'
import { fetchSchema } from './api'
import type { AdminBlockMeta, AdminCollection, AdminFieldMeta } from './api'

type Data = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const rows = (v: unknown): Data[] => (Array.isArray(v) ? (v as Data[]) : [])
// Author-supplied rich content is sanitized before it ever reaches the DOM. The
// preview runs on the admin origin where the session token lives, so an
// unsanitized field value would be a stored-XSS / privilege-escalation vector.
const html = (v: unknown) => ({ __html: DOMPurify.sanitize(str(v)) })
// Only emit a CSS background URL when it can't break out of the `url(...)`
// declaration (no quotes/parens/whitespace/backslashes) — prevents CSS injection.
const bgImage = (v: unknown): { backgroundImage: string } | undefined => {
  const s = str(v).trim()
  if (!s || /["'()\\\s]/.test(s)) return undefined
  return { backgroundImage: `url("${s}")` }
}

export function PreviewPage({ collection }: { collection: string }) {
  const [coll, setColl] = useState<AdminCollection | null>(null)
  const [data, setData] = useState<Data>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchSchema()
      .then((s) => {
        if (!active) return
        const found = s.collections.find((c) => c.slug === collection) ?? null
        setColl(found)
        if (!found) setError(`Unknown collection “${collection}”.`)
      })
      .catch(() => active && setError('Could not load the content model.'))
    return () => {
      active = false
    }
  }, [collection])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only trust the editor that hosts this iframe (same-origin parent). Without
      // these checks any page could postMessage HTML into the preview, which is
      // rendered into the document — a DOM-XSS path on the admin's own origin.
      if (e.source !== window.parent || e.origin !== window.location.origin) return
      if (e.data && e.data.type === 'kernel-preview') setData((e.data.data as Data) ?? {})
    }
    window.addEventListener('message', onMessage)
    window.parent?.postMessage({ type: 'kernel-preview-ready' }, window.location.origin)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (error) return <div className="pv pv-empty">{error}</div>
  if (!coll) return <div className="pv pv-empty">Loading preview…</div>

  const blockFields = coll.fields.filter((f) => f.type === 'blocks')
  // Carry the source field name + its row index so each section knows its editor
  // dot-path ("layout.0") for click-to-edit.
  const sections = blockFields.flatMap((f) =>
    rows(data[f.name]).map((row, i) => ({
      row,
      def: (f.blocks ?? []).find((b) => b.slug === row.blockType),
      path: `${f.name}.${i}`,
    })),
  )

  return (
    <div className="pv" onClick={onPreviewClick} onPointerOver={onPreviewHover} onPointerLeave={onPreviewLeave}>
      {sections.length === 0 && <div className="pv-empty">Add sections to see the page here.</div>}
      {sections.map(({ row, def, path }) => (
        <Section key={path} data={row} def={def} path={path} />
      ))}
    </div>
  )
}

// --- click-to-edit bridge (preview → editor) -------------------------------
// Posts to the hosting editor on the admin origin only; never wildcard.
function postToEditor(type: string, path: string | null): void {
  window.parent?.postMessage({ type, path }, window.location.origin)
}

// Only `[data-kernel-path]` is ever stamped (see Section); nothing emits
// `data-kernel-field`, so the walk-up resolves the section path alone.
function nearestEl(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-kernel-path]')
}

function nearestPath(target: EventTarget | null): string | null {
  return nearestEl(target)?.getAttribute('data-kernel-path') ?? null
}

// Single local selection highlight, mirroring the editor-side focus. Reused on
// each click so only the active section carries `.kernel-pv-selected`.
let selectedEl: Element | null = null
function onPreviewClick(e: ReactMouseEvent): void {
  const el = nearestEl(e.target)
  if (!el) return
  if (selectedEl !== el) {
    selectedEl?.classList.remove('kernel-pv-selected')
    el.classList.add('kernel-pv-selected')
    selectedEl = el
  }
  const path = el.getAttribute('data-kernel-path')
  if (path) postToEditor('kernel-preview-select', path)
}

let lastHover: string | null = null
function onPreviewHover(e: ReactPointerEvent): void {
  const path = nearestPath(e.target)
  if (path === lastHover) return
  lastHover = path
  postToEditor('kernel-preview-hover', path)
}

function onPreviewLeave(): void {
  if (lastHover === null) return
  lastHover = null
  postToEditor('kernel-preview-hover', null)
}

function Section({ data, def, path }: { data: Data; def?: AdminBlockMeta; path: string }) {
  const el = renderSection(data, def) as ReactElement<Record<string, unknown> & { className?: string }>
  const className = [el.props.className, 'kernel-pv-block'].filter(Boolean).join(' ')
  // Stamp the section's own root element so it stays full-bleed (no extra wrapper).
  return cloneElement(el, { 'data-kernel-path': path, className })
}

function renderSection(data: Data, def?: AdminBlockMeta): ReactElement {
  switch (str(data.blockType)) {
    case 'hero':
      return <Hero data={data} />
    case 'intro':
      return <Intro data={data} />
    case 'key_facts':
      return <KeyFacts data={data} />
    case 'full_experience':
      return <FullExperience data={data} />
    case 'tv_streaming':
      return <TvStreaming data={data} />
    case 'media_split':
      return <MediaSplit data={data} />
    case 'faq':
      return <Faq data={data} />
    default:
      return <Generic data={data} def={def} />
  }
}

function Eyebrow({ children }: { children: unknown }) {
  return str(children) ? <p className="s-eyebrow">{str(children)}</p> : null
}

function Hero({ data }: { data: Data }) {
  return (
    <section className="s-hero" style={bgImage(data.image)}>
      <div className="s-hero-overlay" />
      <div className="s-hero-inner">
        <Eyebrow>{data.eyebrow}</Eyebrow>
        <h1 className="s-hero-title">{str(data.heading)}</h1>
        {str(data.badge) && <p className="s-hero-badge">{str(data.badge)}</p>}
        <div className="s-hero-actions">
          {str(data.primary_label) && <span className="s-btn s-btn-gold">{str(data.primary_label)}</span>}
          {str(data.secondary_label) && <span className="s-btn s-btn-ghost">{str(data.secondary_label)}</span>}
        </div>
      </div>
    </section>
  )
}

function Intro({ data }: { data: Data }) {
  return (
    <section className="s-pad s-center">
      <h2 className="s-h2 s-gold">{str(data.heading)}</h2>
      {str(data.description) && (
        <div className="s-prose s-gold-soft" dangerouslySetInnerHTML={html(data.description)} />
      )}
    </section>
  )
}

function KeyFacts({ data }: { data: Data }) {
  return (
    <section className="s-pad s-glow">
      <div className="s-head">
        <Eyebrow>{data.eyebrow}</Eyebrow>
        <h2 className="s-h2">{str(data.heading)}</h2>
        {str(data.intro) && <p className="s-intro">{str(data.intro)}</p>}
      </div>
      <div className="s-facts">
        {rows(data.facts).map((f, i) => (
          <div className="s-fact" key={i}>
            <p className="s-fact-label">{str(f.label)}</p>
            <div className="s-fact-value">{str(f.value)}</div>
            {str(f.detail) && <p className="s-fact-detail">{str(f.detail)}</p>}
          </div>
        ))}
      </div>
      {rows(data.pills).length > 0 && (
        <div className="s-pills">
          {rows(data.pills).map((p, i) => (
            <span className="s-pill" key={i}>
              {str(p.label)}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function FullExperience({ data }: { data: Data }) {
  return (
    <section className="s-pad" style={{ background: '#500113' }}>
      <div className="s-head">
        <Eyebrow>{data.eyebrow}</Eyebrow>
        <h2 className="s-h2">{str(data.heading)}</h2>
        {str(data.intro) && <p className="s-intro">{str(data.intro)}</p>}
      </div>
      <div className="s-cards s-cards-3">
        {rows(data.moments).map((m, i) => (
          <article className="s-card" key={i}>
            {str(m.kicker) && <p className="s-card-kicker">{str(m.kicker)}</p>}
            <h3 className="s-card-title">{str(m.title)}</h3>
            {str(m.body) && <div className="s-prose" dangerouslySetInnerHTML={html(m.body)} />}
          </article>
        ))}
      </div>
    </section>
  )
}

function TvStreaming({ data }: { data: Data }) {
  return (
    <section className="s-pad s-glow" style={{ background: '#500113' }}>
      <div className="s-head">
        <Eyebrow>{data.eyebrow}</Eyebrow>
        <h2 className="s-h2">{str(data.heading)}</h2>
        {str(data.intro) && <p className="s-intro">{str(data.intro)}</p>}
      </div>
      <div className="s-cards s-cards-3">
        {rows(data.broadcasters).map((b, i) => (
          <article className={`s-card${b.featured ? ' s-card-accent' : ''}`} key={i}>
            {str(b.channel) && <p className="s-card-kicker">{str(b.channel)}</p>}
            <h3 className="s-card-name">{str(b.name)}</h3>
            {str(b.highlight) && <p className="s-card-highlight">{str(b.highlight)}</p>}
            {str(b.detail) && <p className="s-prose">{str(b.detail)}</p>}
          </article>
        ))}
      </div>
    </section>
  )
}

function MediaSplit({ data }: { data: Data }) {
  const right = str(data.image_side) === 'right'
  const media = <div className="s-split-media" style={bgImage(data.image)} />
  const text = (
    <div className="s-split-text">
      <Eyebrow>{data.eyebrow}</Eyebrow>
      <h2 className="s-h2">{str(data.heading)}</h2>
      {str(data.body) && <div className="s-prose" dangerouslySetInnerHTML={html(data.body)} />}
      {str(data.cta_label) && <span className="s-btn s-btn-gold s-mt">{str(data.cta_label)}</span>}
    </div>
  )
  return (
    <section className="s-split" style={{ background: '#500113' }}>
      {right ? (
        <>
          {text}
          {media}
        </>
      ) : (
        <>
          {media}
          {text}
        </>
      )}
    </section>
  )
}

function Faq({ data }: { data: Data }) {
  return (
    <section className="s-split s-faq">
      <div className="s-split-media" style={bgImage(data.image)} />
      <div className="s-split-text">
        <Eyebrow>{data.eyebrow}</Eyebrow>
        <h2 className="s-h2">{str(data.heading)}</h2>
        {str(data.intro) && <p className="s-intro s-intro-left">{str(data.intro)}</p>}
        <div className="s-faq-list">
          {rows(data.items).map((it, i) => (
            <div className="s-faq-item" key={i}>
              <p className="s-faq-q">{str(it.question)}</p>
              {str(it.answer) && <div className="s-prose" dangerouslySetInnerHTML={html(it.answer)} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Generic({ data, def }: { data: Data; def?: AdminBlockMeta }) {
  return (
    <section className="s-pad s-generic">
      {def && <div className="s-generic-kind">{def.labels.singular}</div>}
      {(def?.fields ?? []).map((field) => (
        <GenericField key={field.name} field={field} value={data[field.name]} />
      ))}
    </section>
  )
}

function GenericField({ field, value }: { field: AdminFieldMeta; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  if (field.type === 'richText') return <div className="s-prose" dangerouslySetInnerHTML={html(value)} />
  if (field.type === 'textarea' || field.type === 'text' || field.type === 'email' || field.type === 'slug')
    return <p className="s-prose">{String(value)}</p>
  return null
}
