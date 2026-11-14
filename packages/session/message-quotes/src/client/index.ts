/** Quote selection actions and literal UserText excerpts registered by the browser plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ANNOTATIONS_ID, ANNOTATIONS_KIND, AnnotationsController, annotationBridge } from './annotations.ts'
import { MARK_ATTR, anchorQuote, findMark, flashMarks, injectMarkStyles } from './annotation-dom.ts'
import { AnnotationsTab } from './AnnotationsTab.tsx'
import { AnnotationsTitle } from './AnnotationsTitle.tsx'
import { QuoteSelectionAction } from './QuoteSelection.tsx'
import { QuotedUserText } from './QuotedUserText.tsx'
import { quoteRule } from './quote-rule.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh, type MessageQuotesKey } from './locales.ts'

export type {} from './quote-rule.ts'
export type { AnnotationItem, AnnotationsState } from './annotations.ts'
export { ANNOTATIONS_ID, ANNOTATIONS_KIND }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Quote selection action copy. */
    messageQuotes: MessageQuotesKey
  }
}

/** Browser plugin name. */
export const name = 'message-quotes'

/** Services needed to admit selections and register Quote presentation. */
export const inject = ['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.annotations']

/** The annotations tab type's static face; the chip gets a live title registration. */
function annotationsDefinition(title: () => string): SidebarRightTabDefinition {
  return { id: ANNOTATIONS_ID, kind: ANNOTATIONS_KIND, priority: 'builtin', title }
}

/**
 * Register Quote admission, its action surface, and literal UserText rendering.
 * @param ctx - Client root context owning every Quote contribution.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'message-quotes: dictionaries')
  ctx.effect(() => ctx.uiConversation.userText.register(quoteRule), 'message-quotes: UserText rule')
  ctx.effect(() => ctx.uiConversation.interactions.register({
    id: 'quote',
    onInteraction(request) {
      if (request.trigger !== 'selection' || request.readText() === null) return
      const binding = ctx.sessions.binding(request.sessionId)
      if (binding === undefined) return
      const session = binding.session.getSnapshot()
      if (session.removed || (session.subagent !== null
        && session.subagent.address.mode !== 'continuable')) return
      request.open()
    },
  }), 'message-quotes: selection interaction')
  ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
    name: 'conversation.chat.text-interaction', key: 'quote', locale: NS,
  }, QuoteSelectionAction))
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'quote', priority: 100,
  }, QuotedUserText))

  // Quotation annotations: the Word-style comment panel beside the conversation.
  const annotations = new AnnotationsController(ctx)
  annotationBridge.current = annotations
  ctx.effect(() => () => {
    if (annotationBridge.current === annotations) annotationBridge.current = null
  }, 'message-quotes: annotation bridge')
  injectMarkStyles(document)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(annotationsDefinition(() => t('annotation.tab.title'))), 'message-quotes: annotations tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ANNOTATIONS_ID, locale: NS,
    inject: () => ({
      hooks: { annotations: annotations.state },
      ensureAnnotations: (sessionId: SessionId) => { void annotations.ensure(sessionId) },
      revealQuote: (sessionId: SessionId, id: string) => {
        let mark = findMark(id)
        if (mark === null) {
          // The mark was lost to a re-render or a reload: re-anchor the
          // quotation by its text before scrolling to it.
          const item = annotations.find(id)
          if (item !== undefined) anchorQuote(sessionId, id, item.quote)
          mark = findMark(id)
        }
        if (mark === null) return
        mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
        flashMarks(id)
      },
      removeAnnotation: (sessionId: SessionId, id: string) => { annotations.remove(sessionId, id) },
      retryAnnotation: (sessionId: SessionId, id: string) => { void annotations.retry(sessionId, id) },
      clearFocus: (sessionId: SessionId) => { annotations.clearFocus(sessionId) },
    }),
  }, AnnotationsTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ANNOTATIONS_ID, locale: NS,
    inject: () => ({
      hooks: { annotations: annotations.state },
      ensureAnnotations: (sessionId: SessionId) => { void annotations.ensure(sessionId) },
    }),
  }, AnnotationsTitle))
  const onMarkClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const mark = target.closest(`[${MARK_ATTR}]`)
    if (mark === null) return
    const id = mark.getAttribute(MARK_ATTR)
    if (id === null) return
    const item = annotations.find(id)
    if (item === undefined) return
    ctx.sidebarRight.openTabIn(item.sessionId, ANNOTATIONS_KIND)
    annotations.requestFocus(item.sessionId, id)
  }
  document.addEventListener('click', onMarkClick, true)
  ctx.effect(() => () => { document.removeEventListener('click', onMarkClick, true) }, 'message-quotes: annotation mark clicks')
}
