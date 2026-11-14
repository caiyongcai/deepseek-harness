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
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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
 * One Word-style annotation card: the quotation as the anchor header, the
 * question for ask cards, and the model reply or its progress/failure state.
 */
function AnnotationCard({ item, sessionId, revealQuote, removeAnnotation, retryAnnotation, t }: {
  item: AnnotationItem
  sessionId: SessionId
  revealQuote: AnnotationsTabInjected['revealQuote']
  removeAnnotation: AnnotationsTabInjected['removeAnnotation']
  retryAnnotation: AnnotationsTabInjected['retryAnnotation']
} & PropsLocale<'messageQuotes'>): ReactNode {
  return (
    <article className={css.card} data-annotation-card={item.id}>
      <header className={css.head}>
        <span className={css.kind} data-kind={item.kind}>
          {t(item.kind === 'ask' ? 'annotation.kind.ask' : 'annotation.kind.explain')}
        </span>
        <button
          type="button"
          className={css.remove}
          aria-label={t('annotation.remove')}
          title={t('annotation.remove')}
          onClick={() => { removeAnnotation(sessionId, item.id) }}
        >
          ×
        </button>
      </header>
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
    </article>
  )
}
