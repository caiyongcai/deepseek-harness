/** Session Controller adapter for one-shot quotation annotations over the Session's own model. */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AnnotationDeleteRequest,
  AnnotationListRequest,
  AnnotationPutRequest,
  AnnotationRequest,
  SessionAnnotation,
} from './types.ts'

export type { AnnotationRequest } from './types.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    /** One-off quotation annotation (ask about, or explain, a selected passage). */
    'annotation': true
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `annotations` Remote namespace. */
    sessionAnnotations: SessionAnnotations
  }
}

/** Output budget for one annotation answer. */
const ANNOTATION_MAX_TOKENS = 2048

/**
 * Defensive character budget for the conversation transcript sent as annotation
 * context. Conversations within it travel whole, from their first message; a
 * longer one keeps its most recent turns and drops the oldest with a marker.
 */
const ANNOTATION_CONTEXT_MAX_CHARS = 96_000

/** One-shot system prompt: answer about the quotation in its own language, grounded in the supplied conversation context. */
const ANNOTATION_SYSTEM = 'You annotate quotations selected from an AI conversation. '
  + 'Reply in the same language as the quotation, concisely and accurately. '
  + 'Ground the reply in the quotation and, when supplied, the surrounding conversation context; '
  + 'use general knowledge only to clarify.'

/** One visible conversation message entered into the annotation context. */
interface TranscriptEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Collapse whitespace runs to single spaces so log text and rendered text compare equally. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ')
}

/** Visible text of one message's content; attachments become bracket labels. */
function visibleText(content: UserMessage['content']): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') parts.push(block.text)
        break
      case 'image':
        parts.push(`[Image: ${block.attachment.name ?? 'attachment'}]`)
        break
      case 'file':
        parts.push(`[File: ${block.attachment.name}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

/**
 * Collect the conversation's visible messages in log order: human prompts and
 * assistant replies as they render in the chat, skipping tool plumbing and
 * injected non-human context, mirroring the Markdown export's selection.
 * @param events - complete committed logical event snapshot in seq order.
 * @returns the conversation's user/assistant text in conversation order.
 */
function transcriptEntries(events: readonly SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user') break
        const text = visibleText(event.data.content)
        if (text.trim() !== '') entries.push({ role: 'user', text })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') break
        const text = visibleText(event.data.message.content)
        if (text.trim() !== '') entries.push({ role: 'assistant', text })
        break
      }
      default:
        break
    }
  }
  return entries
}

/**
 * Index of the conversation message that contains the quotation.
 * @param entries - conversation messages in order.
 * @param quote - the quoted conversation text.
 * @returns the first containing entry's index, or -1 when no message matches.
 */
function transcriptCut(entries: readonly TranscriptEntry[], quote: string): number {
  const needle = normalizeWhitespace(quote).trim()
  if (needle === '') return -1
  for (const [index, entry] of entries.entries()) {
    if (normalizeWhitespace(entry.text).includes(needle)) return index
  }
  return -1
}

/**
 * Enforce the context character budget by dropping the oldest entries.
 * @param entries - conversation messages already scoped to the quotation.
 * @returns the kept entries and whether any were dropped.
 */
function capTranscript(entries: readonly TranscriptEntry[]): { kept: readonly TranscriptEntry[]; truncated: boolean } {
  let total = 0
  for (const entry of entries) total += entry.text.length
  if (total <= ANNOTATION_CONTEXT_MAX_CHARS) return { kept: entries, truncated: false }
  let start = 0
  while (start < entries.length - 1 && total > ANNOTATION_CONTEXT_MAX_CHARS) {
    total -= entries[start]?.text.length ?? 0
    start += 1
  }
  return { kept: entries.slice(start), truncated: true }
}

/**
 * Render the scoped conversation as annotation context text.
 * @param entries - conversation messages in order.
 * @param truncated - whether older messages were dropped by the budget.
 * @returns the labeled transcript, empty when there is no conversation yet.
 */
function renderTranscript(entries: readonly TranscriptEntry[], truncated: boolean): string {
  if (entries.length === 0) return ''
  const body = entries
    .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}:\n${entry.text}`)
    .join('\n\n')
  return truncated ? `[…earlier messages omitted…]\n\n${body}` : body
}

/**
 * Compose the single user message for one annotation request.
 * @param request - kind, quotation, and optional question from the browser.
 * @param context - the conversation transcript up to the quoted message, or ''.
 * @returns the lone request message of the one-shot call.
 */
function annotationMessage(request: AnnotationRequest, context: string): string {
  const quoted = `Quotation:\n"""\n${request.quote}\n"""`
  const framing = context === ''
    ? ''
    : `The conversation before the quotation, ending with the message the quotation is selected from:\n\n${context}\n\n`
  if (request.kind === 'ask') {
    return `${framing}${quoted}\n\nQuestion: ${request.question ?? ''}\n\nAnswer the question about the quotation, using the conversation above when it helps.`
  }
  return `${framing}${quoted}\n\nExplain this quotation, using the conversation above when it helps.`
}

/** One stored annotation row; the storage-domain record schema's element. */
const storedAnnotation = z.object({
  id: z.string(),
  kind: z.enum(['ask', 'explain']),
  quote: z.string(),
  question: z.string().optional(),
  status: z.enum(['pending', 'done', 'failed']),
  answer: z.string(),
  createdAt: z.number(),
})

/** One Session's stored annotations; the whole record is replaced on every write. */
const annotationsRecord = z.object({ items: z.array(storedAnnotation) })

/** One Session's annotations as stored, inferred from the record schema. */
type SessionAnnotationsRecord = z.infer<typeof annotationsRecord>

/**
 * The quotation-annotation storage domain: one `sessions` table keyed by
 * {@link SessionId}, each record the full annotation set of one Session
 * (`per-record` layout — the shipped json backend stores one document per
 * session under `<root>/session_annotations/sessions/`). Annotations are
 * reader commentary, never conversation content, so an unreadable record is
 * disposable: `backup-and-skip` moves it aside rather than costing the boot.
 */
export const sessionAnnotationsDomainSpec = defineDomain({
  name: 'session_annotations',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, SessionAnnotationsRecord>(annotationsRecord) },
})

/**
 * Host Remote adapter for quotation annotations: a one-shot `ctx.llm.stream`
 * call generates the text over the conversation transcript up to the quoted
 * message (read through session-query, never appended to the Session log, so
 * annotating leaves the conversation untouched), while `list`/`put`/`delete`
 * persist the annotation set per Session through the storage domain.
 */
export class SessionAnnotations extends TypertRemoteService {
  static inject = ['llm', 'typert', 'storageDomain', 'sessionQuery']

  /** The per-Session annotation table, opened once at service start. */
  private table?: KvTable<SessionId, SessionAnnotationsRecord>

  /** @param ctx - Host context carrying the composed LLM and storage services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionAnnotations', { namespace: 'annotations' })
  }

  /** Open the storage domain and keep its table for the service's lifetime. */
  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof sessionAnnotationsDomainSpec> = await this.ctx.storageDomain.open(sessionAnnotationsDomainSpec)
    this.ctx.effect(() => () => { void domain.close() }, 'sessionAnnotations: domain close')
    this.table = domain.table('sessions')
  }

  /** The opened annotation table; Remote methods fail fast before init finished. */
  private requireTable(): KvTable<SessionId, SessionAnnotationsRecord> {
    const table = this.table
    if (table === undefined) throw new RemoteError('annotations/not-ready', 'Annotation storage is not open yet', {})
    return table
  }

  /**
   * List one Session's persisted annotations, newest record first is not
   * implied: the browser re-orders cards by the quotations' conversation
   * positions, so creation order is all the wire needs to carry.
   * @param request - the Session whose annotations are listed.
   * @param signal - caller cancellation.
   * @returns the Session's stored annotations in creation order.
   */
  @Remote
  list(request: AnnotationListRequest, signal: AbortSignal): Promise<SessionAnnotation[]> {
    signal.throwIfAborted()
    return Promise.resolve(this.requireTable().get(request.sessionId)?.items ?? [])
  }

  /**
   * Upsert one annotation into one Session's persisted set.
   * @param request - the Session and the full annotation record to store.
   * @param signal - caller cancellation.
   * @returns the stored annotation.
   */
  @Remote
  async put(request: AnnotationPutRequest, signal: AbortSignal): Promise<SessionAnnotation> {
    signal.throwIfAborted()
    const annotation = request.annotation
    if (annotation.id.length === 0 || annotation.quote.trim().length === 0) {
      throw new RemoteError('annotations/empty-quote', 'Annotation requires a non-empty quotation', {})
    }
    if (annotation.kind === 'ask' && (annotation.question === undefined || annotation.question.trim().length === 0)) {
      throw new RemoteError('annotations/empty-question', 'An ask annotation requires a question', {})
    }
    const table = this.requireTable()
    const current = table.get(request.sessionId)?.items ?? []
    const items = current.some(item => item.id === annotation.id)
      ? current.map(item => item.id === annotation.id ? annotation : item)
      : [...current, annotation]
    await table.put(request.sessionId, { items })
    return annotation
  }

  /**
   * Delete one annotation from one Session's persisted set; the last removal
   * also drops the Session's record.
   * @param request - the Session and the annotation's identity.
   * @param signal - caller cancellation.
   * @returns whether the annotation existed and was removed.
   */
  @Remote
  async delete(request: AnnotationDeleteRequest, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const table = this.requireTable()
    const record = table.get(request.sessionId)
    if (record === undefined) return false
    const items = record.items.filter(item => item.id !== request.id)
    if (items.length === record.items.length) return false
    if (items.length === 0) await table.delete(request.sessionId)
    else await table.put(request.sessionId, { items })
    return true
  }

  /**
   * Generate one annotation for a quotation from the given Agent's Session.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param request - annotation kind, quotation, and optional question.
   * @param signal - caller cancellation.
   * @returns the model's annotation text; an unknown model route or an empty
   * reply surfaces as a Remote error the browser renders as a failed annotation.
   */
  @Remote
  async generate(
    agent: Agent,
    request: AnnotationRequest,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    if (request.quote.trim().length === 0) throw new RemoteError('annotations/empty-quote', 'Annotation requires a non-empty quotation', {})
    if (request.kind === 'ask' && (request.question === undefined || request.question.trim().length === 0)) {
      throw new RemoteError('annotations/empty-question', 'An ask annotation requires a question', {})
    }
    const target = agent.session.requestHeader()?.config
      ?? (agent.options.provider !== undefined && agent.options.provider.length > 0
        && agent.options.model !== undefined && agent.options.model.length > 0
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined)
    if (target === undefined) {
      throw new RemoteError('annotations/no-model', 'No provider/model is available for this Session yet', {})
    }
    const context = await this.conversationContext(agent.session.id, request.quote, signal)
    const messages: RequestMessage[] = [
      { role: 'user', content: [{ type: 'text', text: annotationMessage(request, context) }] },
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      system: ANNOTATION_SYSTEM,
      messages,
      maxTokens: ANNOTATION_MAX_TOKENS,
      sessionId: agent.session.id,
      purpose: 'annotation',
      signal,
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    } catch (_error) {
      signal.throwIfAborted()
      throw new RemoteError('annotations/failed', 'Annotation generation failed', {})
    }
    const text = assembler.blocks()
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text.length === 0) throw new RemoteError('annotations/empty-result', 'Annotation generation produced no text', {})
    return text
  }

  /**
   * Best-effort conversation context for one annotation: every visible
   * user/assistant message from the Session log's start through the message
   * that contains the quotation. The read never fails the annotation: on any
   * error the call proceeds with the quotation alone.
   * @param sessionId - the Session the quotation lives in.
   * @param quote - the quoted conversation text locating the cut.
   * @param signal - caller cancellation.
   * @returns the rendered transcript, or '' when no context is available.
   */
  private async conversationContext(sessionId: SessionId, quote: string, signal: AbortSignal): Promise<string> {
    try {
      const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
      signal.throwIfAborted()
      const entries = transcriptEntries(snapshot.events)
      const cut = transcriptCut(entries, quote)
      const scoped = cut < 0 ? entries : entries.slice(0, cut + 1)
      const { kept, truncated } = capTranscript(scoped)
      return renderTranscript(kept, truncated)
    } catch (error) {
      signal.throwIfAborted()
      this.ctx.logger.warn(`annotations context read failed for "${sessionId}": ${String(error)}`)
      return ''
    }
  }
}

export default SessionAnnotations
