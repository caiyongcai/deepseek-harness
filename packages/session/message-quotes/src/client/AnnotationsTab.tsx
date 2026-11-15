/** Word-style annotation cards filling the right Sidebar tab. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AnnotationItem, AnnotationsState } from './annotations.ts'
import { anchorQuote, findMark, quoteRanks } from './annotation-dom.ts'
import css from './AnnotationsTab.module.css'

/** The tab body's injected face: the store hook plus the controller actions. */
export interface AnnotationsTabInjected {
  readonly hooks: { annotations: ObservableSnapshot<AnnotationsState> }
  /** Load the Session's persisted annotations (idempotent per Session). */
  readonly ensureAnnotations: (sessionId: SessionId) => void
  /** Scroll the conversation to the quotation and flash its marks. */
  readonly revealQuote: (sessionId: SessionId, id: string) => void
  /** Delete one annotation and unwrap its conversation marks. */
  readonly removeAnnotation: (sessionId: SessionId, id: string) => void
  /** Regenerate one failed (or stale) annotation in place. */
  readonly retryAnnotation: (sessionId: SessionId, id: string) => void
  /** Consume the pending card-focus request once applied. */
  readonly clearFocus: (sessionId: SessionId) => void
}

/** The tab body's composed props. */
export type AnnotationsTabProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<AnnotationsTabInjected> & PropsLocale<'messageQuotes'>

/** Stable empty list for sessions without annotations. */
const EMPTY_ITEMS: readonly AnnotationItem[] = []

/**
 * Order cards the way their quotations flow in the conversation: each card
 * ranks by its quotation's character offset in the rendered conversation
 * text, so the panel reads top-to-bottom like the chat. Quotations not
 * currently rendered keep creation order after every located one.
 * @param sessionId - the Session whose conversation supplies the order.
 * @param items - one Session's annotations in creation order.
 * @returns the same annotations in conversation order.
 */
function conversationOrder(sessionId: SessionId, items: readonly AnnotationItem[]): AnnotationItem[] {
  const ranks = quoteRanks(sessionId, items.map(item => ({ id: item.id, quote: item.quote })))
  return [...items].sort((a, b) => {
    const rankA = ranks.get(a.id) ?? -1
    const rankB = ranks.get(b.id) ?? -1
    if (rankA >= 0 && rankB >= 0 && rankA !== rankB) return rankA - rankB
    if (rankA >= 0 && rankB < 0) return -1
    if (rankA < 0 && rankB >= 0) return 1
    return a.createdAt - b.createdAt
  })
}

/**
 * Render the Session's annotation cards, scrolling to and flashing the card a
 * conversation mark click named.
 * @param props - the tab's runtime seat, injected face, and copy.
 * @returns the annotation list, or the empty-state hint.
 */
export function AnnotationsTab(
  { sessionId, useAnnotations, ensureAnnotations, revealQuote, removeAnnotation, retryAnnotation, clearFocus, t }: AnnotationsTabProps,
): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const items = useAnnotations(state => state.bySession[sessionId]?.items) ?? EMPTY_ITEMS
  const focus = useAnnotations(state => state.bySession[sessionId]?.focus) ?? null
  const [conversationTick, setConversationTick] = useState(0)

  // Load the Session's persisted annotations once the tab renders.
  useEffect(() => { ensureAnnotations(sessionId) }, [sessionId, ensureAnnotations])

  // Re-order as the conversation renders or grows: a structural DOM change
  // anywhere schedules one deferred re-render, and ordering only reads text.
  useEffect(() => {
    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = globalThis.requestAnimationFrame(() => { frame = 0; setConversationTick(tick => tick + 1) })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) globalThis.cancelAnimationFrame(frame)
    }
  }, [])

  // Re-anchor marks lost to a re-render or a reload, so conversation
  // highlighting, mark clicks, and reveal scrolling keep working.
  useEffect(() => {
    for (const item of items) {
      if (findMark(item.id) === null) anchorQuote(sessionId, item.id, item.quote)
    }
  }, [items, sessionId, conversationTick])

  const ordered = useMemo(
    () => conversationOrder(sessionId, items),
    [sessionId, items, conversationTick],
  )

  useEffect(() => {
    if (focus === null) return
    const card = rootRef.current?.querySelector(`[data-annotation-card="${focus.id}"]`)
    if (card instanceof HTMLElement) {
      // jsdom and older engines may not implement scrolling.
      if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      card.setAttribute('data-annotation-card-flash', '')
      const timer = globalThis.setTimeout(() => { card.removeAttribute('data-annotation-card-flash') }, 1800)
      clearFocus(sessionId)
      return () => { globalThis.clearTimeout(timer) }
    }
    clearFocus(sessionId)
    return undefined
  }, [focus, sessionId, clearFocus])

  if (ordered.length === 0) return <div className={css.empty}>{t('annotation.empty')}</div>
  return (
    <div ref={rootRef} className={css.list}>
      {ordered.map(item => (
        <AnnotationCard
          key={item.id}
          item={item}
          sessionId={sessionId}
          focused={focus?.id === item.id}
          revealQuote={revealQuote}
          removeAnnotation={removeAnnotation}
          retryAnnotation={retryAnnotation}
          t={t}
        />
      ))}
    </div>
  )
}

/**
 * One Word-style annotation card. The header is the collapse switch: a
 * collapsed card keeps only the kind, the quotation's first line, and any
 * progress/failure marker, so a long list stays scannable. Expanding reveals
 * the full quotation (itself the reveal action), the question, and the answer.
 */
function AnnotationCard({ item, sessionId, focused, revealQuote, removeAnnotation, retryAnnotation, t }: {
  item: AnnotationItem
  sessionId: SessionId
  /** A conversation mark click asked for this card; opening it shows the answer. */
  focused: boolean
  revealQuote: AnnotationsTabInjected['revealQuote']
  removeAnnotation: AnnotationsTabInjected['removeAnnotation']
  retryAnnotation: AnnotationsTabInjected['retryAnnotation']
} & PropsLocale<'messageQuotes'>): ReactNode {
  const [expanded, setExpanded] = useState(false)

  // Focus from a conversation mark opens the card, then the caller clears it.
  useEffect(() => {
    if (focused) setExpanded(true)
  }, [focused])

  return (
    <article className={css.card} data-annotation-card={item.id} data-expanded={expanded ? 'true' : 'false'}>
      <div className={css.head}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'annotation.collapse' : 'annotation.expand')}
          title={t(expanded ? 'annotation.collapse' : 'annotation.expand')}
          onClick={() => { setExpanded(value => !value) }}
        >
          <span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span className={css.kind} data-kind={item.kind}>
            {t(item.kind === 'ask' ? 'annotation.kind.ask' : 'annotation.kind.explain')}
          </span>
          {!expanded && <span className={css.preview}>{item.quote}</span>}
          {item.status === 'pending' && <span className={css.spinner} aria-label={t('annotation.pending')} />}
          {item.status === 'failed' && (
            <span className={css.statusBadge} data-status="failed">{t('annotation.failed')}</span>
          )}
        </button>
        <button
          type="button"
          className={css.remove}
          aria-label={t('annotation.remove')}
          title={t('annotation.remove')}
          onClick={() => { removeAnnotation(sessionId, item.id) }}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className={css.body}>
          <button
            type="button"
            className={css.quote}
            title={t('annotation.reveal')}
            onClick={() => { revealQuote(sessionId, item.id) }}
          >
            {item.quote}
          </button>
          {item.kind === 'ask' && item.question !== undefined && (
            <div className={css.question}>
              <span className={css.questionLabel}>{t('annotation.question')}</span>
              {item.question}
            </div>
          )}
          {item.status === 'pending' && (
            <div className={css.pending}><span className={css.spinner} />{t('annotation.pending')}</div>
          )}
          {item.status === 'failed' && (
            <div className={css.failed}>
              <span className={css.failedText}>{t('annotation.failed')}{item.answer.length > 0 ? `：${item.answer}` : ''}</span>
              <button type="button" className={css.retry} onClick={() => { retryAnnotation(sessionId, item.id) }}>
                {t('annotation.retry')}
              </button>
            </div>
          )}
          {item.status === 'done' && <div className={css.answer}>{item.answer}</div>}
        </div>
      )}
    </article>
  )
}
