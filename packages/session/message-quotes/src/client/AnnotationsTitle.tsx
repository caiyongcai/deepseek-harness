/** The annotations tab chip: its label plus the Session's annotation count. */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AnnotationsState } from './annotations.ts'
import css from './AnnotationsTab.module.css'

/** The chip's injected face: the store hook plus the load trigger. */
export interface AnnotationsTitleInjected {
  readonly hooks: { annotations: ObservableSnapshot<AnnotationsState> }
  /** Load the Session's persisted annotations (idempotent per Session). */
  readonly ensureAnnotations: (sessionId: SessionId) => void
}

/** The chip's composed props. */
export type AnnotationsTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & InjectFace<AnnotationsTitleInjected> & PropsLocale<'messageQuotes'>

/**
 * Render the tab chip text with a count badge.
 * @param props - the title slot's runtime seat, injected face, and copy.
 * @returns the localized label, with the count while any annotation exists.
 */
export function AnnotationsTitle({ sessionId, useAnnotations, ensureAnnotations, t }: AnnotationsTitleProps): ReactNode {
  const count = useAnnotations(state => state.bySession[sessionId]?.items.length ?? 0)
  // The chip renders while the Session view is open: load the persisted set
  // here so the count (and later the cards) survive a reload without waiting
  // for the tab body to be opened.
  useEffect(() => { ensureAnnotations(sessionId) }, [sessionId, ensureAnnotations])
  return (
    <span className={css.title}>
      {t('annotation.tab.title')}
      {count > 0 && <span className={css.count}>{count}</span>}
    </span>
  )
}
