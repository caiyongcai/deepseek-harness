/** Quote action rendered through the Chat text-interaction Slot. */
import { useEffect } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { annotationBridge, annotationId } from './annotations.ts'
import { openAskPopover, unwrap, wrapSelection } from './annotation-dom.ts'
import css from './QuoteSelection.module.css'

/**
 * Render the actions for a selection admitted by the Quote plugin: the
 * original quote-to-composer button plus the annotation pair — ask about the
 * selection, or explain it — whose cards live in the right Sidebar tab.
 *
 * The ask input deliberately does not render here: wrapping the selection
 * collapses it, and the conversation tears this popup down the moment its
 * selection stops matching. `beginAsk` opens a standalone popover instead.
 * @param props - area-local text interaction and standard Session/composer seats.
 * @returns the action row.
 */
export function QuoteSelectionAction({ dismiss, readText, clearSelection, inputActions, useSession, sessionId, t }:
PropsRuntime<'conversation.chat.text-interaction'> & PropsLocale<'messageQuotes'>) {
  const enabled = useSession(s => !s.removed && (s.subagent === null
    || s.subagent.address.mode === 'continuable'))
  const annotations = annotationBridge.current
  useEffect(() => {
    if (!enabled) dismiss()
  }, [enabled, dismiss])
  if (!enabled) return null

  /** Insert the selection into the composer as a quotation, as before. */
  const quote = (): void => {
    const text = readText()
    if (text === null) { dismiss(); return }
    if (!inputActions.insertQuote(text)) return
    clearSelection()
    dismiss()
  }

  /**
   * Anchor the selection, then open the standalone ask popover. This popup is
   * about to be torn down (the wrap collapses the selection it is matched
   * against), so the question input must live outside its lifecycle.
   */
  const beginAsk = (): void => {
    if (annotations === null) return
    const text = readText()
    if (text === null) { dismiss(); return }
    let rect: DOMRect | null = null
    try {
      const selection = globalThis.getSelection?.()
      if (selection !== undefined && selection !== null && selection.rangeCount > 0) {
        rect = selection.getRangeAt(0).getBoundingClientRect()
      }
    } catch {
      // No layout engine (jsdom) or a detached range: the popover falls back
      // to a viewport-centred anchor.
    }
    const id = annotationId()
    if (!wrapSelection(id)) { dismiss(); return }
    dismiss()
    openAskPopover({
      anchor: rect,
      placeholder: t('annotation.ask.placeholder'),
      submitLabel: t('annotation.ask.submit'),
      cancelLabel: t('annotation.cancel'),
      onSubmit: (question) => {
        void annotations.start(sessionId, { id, kind: 'ask', quote: text, question })
        clearSelection()
      },
      onCancel: () => { unwrap(id) },
    })
  }

  /** Anchor the selection as an explain annotation and start generation. */
  const explain = (): void => {
    if (annotations === null) return
    const text = readText()
    if (text === null) { dismiss(); return }
    const id = annotationId()
    if (!wrapSelection(id)) { dismiss(); return }
    void annotations.start(sessionId, { id, kind: 'explain', quote: text })
    clearSelection()
    dismiss()
  }

  return (
    <div className={css.actions}>
      <button type="button" className={css.action} aria-label={t('quote.add')}
        onPointerDown={(event) => { event.preventDefault() }}
        onClick={quote}>{t('quote.add')}</button>
      {annotations !== null && (
        <>
          <button type="button" className={css.action} aria-label={t('annotation.ask')}
            onPointerDown={(event) => { event.preventDefault() }}
            onClick={beginAsk}>{t('annotation.ask')}</button>
          <button type="button" className={css.action} aria-label={t('annotation.explain')}
            onPointerDown={(event) => { event.preventDefault() }}
            onClick={explain}>{t('annotation.explain')}</button>
        </>
      )}
    </div>
  )
}
