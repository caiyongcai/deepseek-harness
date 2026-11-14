/** Quotation annotations: the store, the one-shot Remote flow, and the popup bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AnnotationRequest, SessionAnnotation } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { findMark, flashMarks, unwrap } from './annotation-dom.ts'

/** The right Sidebar tab kind this controller opens for its annotation list. */
export const ANNOTATIONS_KIND = 'annotations'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const ANNOTATIONS_ID = '@deepseek-ai/dsh-message-quotes/annotations'

/** What the Host is asked to do with the quotation. */
export type AnnotationKind = AnnotationRequest['kind']

/**
 * One Word-style annotation anchored to a quotation in the conversation.
 *
 * Mutable on purpose: this is also the immer-draft shape behind
 * `createSnapshotStore.update`, so property modifiers stay off.
 */
export interface AnnotationItem {
  id: string
  sessionId: SessionId
  kind: AnnotationKind
  /** The quoted conversation text the annotation anchors to. */
  quote: string
  /** The reader's question; present only for `ask` annotations. */
  question?: string | undefined
  status: 'pending' | 'done' | 'failed'
  /** The model's reply once `status` is `done`; the failure message once `failed`. */
  answer: string
  createdAt: number
}

/** A "reveal this card" request; `revision` changes on every request so repeats re-fire. */
export interface AnnotationFocus {
  id: string
  revision: number
}

/** One Session's annotations and the pending focus request. */
export interface SessionAnnotationsState {
  items: AnnotationItem[]
  focus: AnnotationFocus | null
}

/** Every Session's annotations, keyed by Session identity. */
export interface AnnotationsState {
  bySession: Record<string, SessionAnnotationsState>
}

/** Empty bucket constant so selectors return stable references. */
const EMPTY_SESSION: SessionAnnotationsState = { items: [], focus: null }

/** Fresh annotation identity; crypto.randomUUID with a last-resort fallback. */
export function annotationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `a-${String(Date.now())}-${String(Math.random()).slice(2)}`
}

/** The wire form of one annotation: every field but the Session identity. */
function toStored(item: AnnotationItem): SessionAnnotation {
  return {
    id: item.id,
    kind: item.kind,
    quote: item.quote,
    ...item.question === undefined ? {} : { question: item.question },
    status: item.status,
    answer: item.answer,
    createdAt: item.createdAt,
  }
}

/** The in-memory form of one stored annotation; a pending item a reload interrupted reads as failed. */
function fromStored(sessionId: SessionId, annotation: SessionAnnotation): AnnotationItem {
  const interrupted = annotation.status === 'pending'
  return {
    id: annotation.id,
    sessionId,
    kind: annotation.kind,
    quote: annotation.quote,
    ...annotation.question === undefined ? {} : { question: annotation.question },
    status: interrupted ? 'failed' : annotation.status,
    answer: interrupted ? '' : annotation.answer,
    createdAt: annotation.createdAt,
  }
}

/**
 * The annotation list's single owner: writes the store, drives the one-shot
 * Remote call, and opens the right Sidebar tab. Components only read.
 */
export class AnnotationsController {
  /** The store the tab and title subscribe to through their injected hook. */
  readonly state: SnapshotStore<AnnotationsState> = createSnapshotStore({ bySession: {} })

  private focusRevision = 0

  /** Sessions whose persisted annotations were already loaded this run. */
  private readonly loaded = new Set<string>()

  /** @param ctx - browser plugin context carrying the Remote proxy and Sidebar controller. */
  constructor(private readonly ctx: Context) {}

  /** Read one Session's bucket, or the shared empty one. */
  session(sessionId: SessionId): SessionAnnotationsState {
    return this.state.getSnapshot().bySession[sessionId] ?? EMPTY_SESSION
  }

  /** Locate one annotation across Sessions (marks carry no Session identity). */
  find(id: string): AnnotationItem | undefined {
    for (const bucket of Object.values(this.state.getSnapshot().bySession)) {
      const item = bucket.items.find(candidate => candidate.id === id)
      if (item !== undefined) return item
    }
    return undefined
  }

  /**
   * Load one Session's persisted annotations, once per controller lifetime.
   * A failed load clears its marker so a later open can retry.
   * @param sessionId - the Session whose annotations are loaded.
   */
  async ensure(sessionId: SessionId): Promise<void> {
    if (this.loaded.has(sessionId)) return
    this.loaded.add(sessionId)
    let stored: readonly SessionAnnotation[] | undefined
    try {
      const result = await this.ctx.remote.annotations.list({ sessionId })
      if (result.ok) stored = result.value
    } catch {
      // Offline or transport fault: keep the in-memory view and allow a retry.
    }
    if (stored === undefined) {
      this.loaded.delete(sessionId)
      return
    }
    const annotations = stored
    this.state.update((draft) => {
      const bucket = draft.bySession[sessionId] ?? (draft.bySession[sessionId] = { items: [], focus: null })
      const known = new Set(bucket.items.map(item => item.id))
      for (const annotation of annotations) {
        if (known.has(annotation.id)) continue
        bucket.items.push(fromStored(sessionId, annotation))
      }
    })
  }

  /**
   * Create a pending annotation, reveal the panel, persist it, and start
   * generation.
   * @param sessionId - the Session the quotation lives in.
   * @param input - identity, kind, quotation, and the ask question when present.
   */
  async start(sessionId: SessionId, input: { id: string; kind: AnnotationKind; quote: string; question?: string }): Promise<void> {
    const item: AnnotationItem = {
      id: input.id, sessionId, kind: input.kind, quote: input.quote, question: input.question,
      status: 'pending', answer: '', createdAt: Date.now(),
    }
    this.state.update((draft) => {
      const bucket = draft.bySession[sessionId] ?? (draft.bySession[sessionId] = { items: [], focus: null })
      bucket.items.push(item)
    })
    this.persist(sessionId, item)
    this.ctx.sidebarRight.openTabIn(sessionId, ANNOTATIONS_KIND)
    await this.run(sessionId, input.id)
  }

  /** Regenerate one annotation in place, keeping its anchor and position. */
  async retry(sessionId: SessionId, id: string): Promise<void> {
    let restarted = false
    this.state.update((draft) => {
      const item = draft.bySession[sessionId]?.items.find(candidate => candidate.id === id)
      if (item !== undefined) { item.status = 'pending'; item.answer = ''; restarted = true }
    })
    if (restarted) this.persist(sessionId, this.session(sessionId).items.find(candidate => candidate.id === id))
    await this.run(sessionId, id)
  }

  /** Drop one annotation, unwrap its conversation mark, and delete its record. */
  remove(sessionId: SessionId, id: string): void {
    unwrap(id)
    void this.ctx.remote.annotations.delete({ sessionId, id }).then(
      (result) => { if (!result.ok) this.warn('delete', result.error.message) },
      (error: unknown) => { this.warn('delete', String(error)) },
    )
    this.state.update((draft) => {
      const bucket = draft.bySession[sessionId]
      if (bucket === undefined) return
      bucket.items = bucket.items.filter(item => item.id !== id)
      if (bucket.focus?.id === id) bucket.focus = null
    })
  }

  /** Ask the tab to scroll one card into view and flash it. */
  requestFocus(sessionId: SessionId, id: string): void {
    this.focusRevision += 1
    const revision = this.focusRevision
    this.state.update((draft) => {
      const bucket = draft.bySession[sessionId] ?? (draft.bySession[sessionId] = { items: [], focus: null })
      bucket.focus = { id, revision }
    })
  }

  /** Consume the pending focus request after the tab applied it. */
  clearFocus(sessionId: SessionId): void {
    this.state.update((draft) => {
      const bucket = draft.bySession[sessionId]
      if (bucket !== undefined) bucket.focus = null
    })
  }

  /** Report a persistence failure without disturbing the in-memory view. */
  private warn(operation: string, message: string): void {
    this.ctx.logger.warn(`annotations ${operation} failed: ${message}`)
  }

  /** Best-effort persistence of one annotation's current state. */
  private persist(sessionId: SessionId, item: AnnotationItem | undefined): void {
    if (item === undefined) return
    const annotation = toStored(item)
    void this.ctx.remote.annotations.put({ sessionId, annotation }).then(
      (result) => { if (!result.ok) this.warn('put', result.error.message) },
      (error: unknown) => { this.warn('put', String(error)) },
    )
  }

  /** Run the one-shot generation for one pending annotation. */
  private async run(sessionId: SessionId, id: string): Promise<void> {
    const item = this.session(sessionId).items.find(candidate => candidate.id === id)
    if (item === undefined) return
    const request: AnnotationRequest = item.question === undefined
      ? { kind: item.kind, quote: item.quote }
      : { kind: item.kind, quote: item.quote, question: item.question }
    const settle = (status: 'done' | 'failed', answer: string): void => {
      this.state.update((draft) => {
        const current = draft.bySession[sessionId]?.items.find(candidate => candidate.id === id)
        if (current !== undefined) { current.status = status; current.answer = answer }
      })
      this.persist(sessionId, this.session(sessionId).items.find(candidate => candidate.id === id))
    }
    try {
      const result = await this.ctx.remote.annotations.generate(sessionId, request)
      if (result.ok) settle('done', result.value)
      else settle('failed', result.error.message)
    } catch (error) {
      settle('failed', error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * The selection popup reaches the controller here: the
 * `conversation.chat.text-interaction` Slot declares no inject channel, and
 * the popup action shares this module with the plugin's `apply`.
 */
export const annotationBridge: { current: AnnotationsController | null } = { current: null }

/** Mark lookup and flash, re-exported so the tab's injected face names one module. */
export { findMark, flashMarks }
