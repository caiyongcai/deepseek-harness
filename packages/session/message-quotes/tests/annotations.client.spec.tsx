// @vitest-environment jsdom
/** The quotation-annotation flow: the standalone ask popover, explain, the Remote call, and persistence. */
import type { ComponentProps } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QuoteSelectionAction } from '../src/client/QuoteSelection.tsx'
import { AnnotationsTab } from '../src/client/AnnotationsTab.tsx'
import { AnnotationsController, annotationBridge } from '../src/client/annotations.ts'
import type { AnnotationItem } from '../src/client/annotations.ts'
import type { SessionAnnotation } from '@deepseek-ai/dsh-api-session-controller/types'
import { MARK_ATTR, anchorQuote, closeAskPopover, quoteRanks } from '../src/client/annotation-dom.ts'

afterEach(cleanup)

const SESSION = SessionId('anno-session')
const QUOTE = 'the quoted passage'

type Props = ComponentProps<typeof QuoteSelectionAction>

/** A live controller against stub Remote and Sidebar seats, as the plugin's inject resolves them. */
function makeController() {
  const generate = vi.fn(async () => ({ ok: true as const, value: 'the model answer' }))
  const put = vi.fn(
    async (_request: { sessionId: SessionId; annotation: SessionAnnotation }) => ({ ok: true as const, value: undefined }),
  )
  const list = vi.fn(async () => ({ ok: true as const, value: [] as SessionAnnotation[] }))
  const remove = vi.fn(async () => ({ ok: true as const, value: true }))
  const openTabIn = vi.fn()
  const controller = new AnnotationsController({
    logger: { warn: vi.fn() },
    remote: { annotations: { generate, put, list, delete: remove } },
    sidebarRight: { openTabIn },
  } as never)
  return { controller, generate, put, list, remove, openTabIn }
}

function props(): Props {
  return {
    trigger: 'selection',
    dismiss: vi.fn(),
    readText: vi.fn((): string | null => QUOTE),
    clearSelection: vi.fn(),
    inputActions: { insertQuote: vi.fn(() => true) },
    useSession: selector => selector({ removed: false, subagent: null } as never),
    sessionId: SESSION,
    t: key => key,
  } as Props
}

/** Mount conversation text and select the passage inside it, as a reader would. */
function selectPassage(): void {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  host.textContent = `alpha ${QUOTE} omega`
  document.body.appendChild(host)
  const text = host.firstChild as Text
  const start = host.textContent?.indexOf(QUOTE) ?? -1
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, start + QUOTE.length)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Mount the scoped conversation region a Session's messages render into. */
function mountConversation(): void {
  document.body.innerHTML = ''
  const root = document.createElement('div')
  root.setAttribute('data-conversation-content', '')
  root.setAttribute('data-conversation-session', SESSION)
  const first = document.createElement('p')
  first.textContent = 'first block mentions alpha words here'
  const second = document.createElement('p')
  second.textContent = 'second block mentions the quoted passage again'
  root.append(first, second)
  document.body.appendChild(root)
}

/** Release the module bridge and every leftover DOM anchor between tests. */
function resetBridge(): void {
  annotationBridge.current = null
  closeAskPopover()
  document.body.innerHTML = ''
}

describe('quotation annotations', () => {
  it('asks through the standalone popover and records the answered annotation', async () => {
    selectPassage()
    const { controller, generate, openTabIn } = makeController()
    annotationBridge.current = controller
    try {
      const view = render(<QuoteSelectionAction {...props()} />)
      fireEvent.click(view.getByRole('button', { name: 'annotation.ask' }))

      // The popover owns the question input; the selection is already anchored.
      const popover = document.querySelector('.dsh-anno-ask')
      expect(popover).not.toBeNull()
      const input = popover?.querySelector('input')
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
      expect(document.querySelector(`[${MARK_ATTR}]`)).not.toBeNull()

      // Submit stays disabled until a question is typed, then settles the annotation.
      const submit = [...popover?.querySelectorAll('button') ?? []].find(button => button.textContent === 'annotation.ask.submit')
      expect(submit?.disabled).toBe(true)
      fireEvent.input(input!, { target: { value: 'What does this mean?' } })
      expect(submit?.disabled).toBe(false)
      fireEvent.click(submit!)

      expect(document.querySelector('.dsh-anno-ask')).toBeNull()
      await waitFor(() => { expect(generate).toHaveBeenCalledOnce() })
      expect(generate).toHaveBeenCalledWith(SESSION, { kind: 'ask', quote: QUOTE, question: 'What does this mean?' })
      await waitFor(() => {
        expect(controller.session(SESSION).items[0]).toMatchObject({
          kind: 'ask', quote: QUOTE, question: 'What does this mean?', status: 'done', answer: 'the model answer',
        })
      })
      expect(openTabIn).toHaveBeenCalledWith(SESSION, 'annotations')
    } finally {
      resetBridge()
    }
  })

  it('cancels the ask, unwrapping its anchor without any annotation or call', () => {
    selectPassage()
    const { controller, generate } = makeController()
    annotationBridge.current = controller
    try {
      const view = render(<QuoteSelectionAction {...props()} />)
      fireEvent.click(view.getByRole('button', { name: 'annotation.ask' }))
      const input = document.querySelector('.dsh-anno-ask input')
      expect(input).not.toBeNull()
      fireEvent.keyDown(input!, { key: 'Escape' })

      expect(document.querySelector('.dsh-anno-ask')).toBeNull()
      expect(document.querySelector(`[${MARK_ATTR}]`)).toBeNull()
      expect(generate).not.toHaveBeenCalled()
      expect(controller.session(SESSION).items).toHaveLength(0)
    } finally {
      resetBridge()
    }
  })

  it('explains the selection directly: anchored, generated, and surfaced in the tab', async () => {
    selectPassage()
    const { controller, generate, openTabIn } = makeController()
    annotationBridge.current = controller
    try {
      const view = render(<QuoteSelectionAction {...props()} />)
      fireEvent.click(view.getByRole('button', { name: 'annotation.explain' }))

      expect(document.querySelector('.dsh-anno-ask')).toBeNull()
      expect(document.querySelector(`[${MARK_ATTR}]`)).not.toBeNull()
      await waitFor(() => { expect(generate).toHaveBeenCalledOnce() })
      expect(generate).toHaveBeenCalledWith(SESSION, { kind: 'explain', quote: QUOTE })
      await waitFor(() => {
        expect(controller.session(SESSION).items[0]).toMatchObject({ kind: 'explain', status: 'done', answer: 'the model answer' })
      })
      expect(openTabIn).toHaveBeenCalledWith(SESSION, 'annotations')
    } finally {
      resetBridge()
    }
  })

  it('persists every state transition and deletes on removal', async () => {
    selectPassage()
    const { controller, put, remove } = makeController()
    annotationBridge.current = controller
    try {
      const view = render(<QuoteSelectionAction {...props()} />)
      fireEvent.click(view.getByRole('button', { name: 'annotation.explain' }))
      await waitFor(() => {
        expect(controller.session(SESSION).items[0]).toMatchObject({ status: 'done' })
      })
      // The pending record lands before generation, the settled one after it.
      await waitFor(() => { expect(put).toHaveBeenCalledTimes(2) })
      const pendingRequest = put.mock.calls[0]?.[0]
      const settledRequest = put.mock.calls[1]?.[0]
      expect(pendingRequest?.sessionId).toBe(SESSION)
      expect(pendingRequest?.annotation).toMatchObject({ kind: 'explain', quote: QUOTE, status: 'pending' })
      expect(settledRequest?.annotation).toMatchObject({ status: 'done', answer: 'the model answer' })

      const id = controller.session(SESSION).items[0]!.id
      controller.remove(SESSION, id)
      await waitFor(() => { expect(remove).toHaveBeenCalledWith({ sessionId: SESSION, id }) })
      expect(controller.session(SESSION).items).toHaveLength(0)
    } finally {
      resetBridge()
    }
  })

  it('loads persisted annotations once, folding interrupted pending items into failed', async () => {
    const stored: SessionAnnotation[] = [
      {
        id: 'stored-done', kind: 'explain', quote: 'earlier passage', status: 'done',
        answer: 'stored answer', createdAt: 1,
      },
      {
        id: 'stored-pending', kind: 'ask', quote: 'later passage', question: 'why?', status: 'pending',
        answer: '', createdAt: 2,
      },
    ]
    const { controller, list } = makeController()
    list.mockResolvedValue({ ok: true as const, value: stored })
    try {
      await controller.ensure(SESSION)
      const items = controller.session(SESSION).items
      expect(items).toHaveLength(2)
      expect(items.find(item => item.id === 'stored-done')).toMatchObject({ status: 'done', answer: 'stored answer' })
      expect(items.find(item => item.id === 'stored-pending')).toMatchObject({ status: 'failed', answer: '' })

      // A second ensure does not re-read or duplicate.
      await controller.ensure(SESSION)
      expect(list).toHaveBeenCalledOnce()
      expect(controller.session(SESSION).items).toHaveLength(2)
    } finally {
      resetBridge()
    }
  })
})

describe('annotation cards', () => {
  const DONE: AnnotationItem = {
    id: 'card-done', sessionId: SESSION, kind: 'explain', quote: QUOTE, status: 'done', answer: 'the model answer', createdAt: 1,
  }

  /** Tab props over one Session's items, with a focus request when given. */
  function tabProps(items: readonly AnnotationItem[], focusId?: string) {
    const state = { bySession: { [SESSION]: { items, focus: focusId === undefined ? null : { id: focusId } } } }
    return {
      sessionId: SESSION,
      useAnnotations: (selector: (value: unknown) => unknown) => selector(state),
      ensureAnnotations: vi.fn(),
      revealQuote: vi.fn(),
      removeAnnotation: vi.fn(),
      retryAnnotation: vi.fn(),
      clearFocus: vi.fn(),
      t: (key: string) => key,
    } as unknown as ComponentProps<typeof AnnotationsTab>
  }

  it('starts collapsed and toggles from the card header', () => {
    mountConversation()
    try {
      const view = render(<AnnotationsTab {...tabProps([DONE])} />)
      const toggle = view.getByRole('button', { name: 'annotation.expand' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      // Collapsed keeps the quotation's opening line but hides the answer.
      expect(view.container.querySelector('[data-annotation-card]')?.textContent).toContain(QUOTE)
      expect(view.queryByText('the model answer')).toBeNull()

      fireEvent.click(toggle)
      expect(view.getByRole('button', { name: 'annotation.collapse' }).getAttribute('aria-expanded')).toBe('true')
      expect(view.getByText('the model answer')).not.toBeNull()

      fireEvent.click(view.getByRole('button', { name: 'annotation.collapse' }))
      expect(view.queryByText('the model answer')).toBeNull()
      expect(view.getByRole('button', { name: 'annotation.expand' })).not.toBeNull()
    } finally {
      document.body.innerHTML = ''
    }
  })

  it('opens the card a conversation mark click focused', () => {
    mountConversation()
    try {
      const view = render(<AnnotationsTab {...tabProps([DONE], DONE.id)} />)
      expect(view.getByText('the model answer')).not.toBeNull()
      expect(view.getByRole('button', { name: 'annotation.collapse' })).not.toBeNull()
    } finally {
      document.body.innerHTML = ''
    }
  })
})

describe('annotation anchoring', () => {
  it('ranks quotations by their conversation position', () => {
    mountConversation()
    try {
      const ranks = quoteRanks(SESSION, [
        { id: 'late', quote: 'the quoted passage' },
        { id: 'early', quote: 'alpha words' },
        { id: 'absent', quote: 'nowhere to be found' },
      ])
      expect(ranks.get('early')!).toBeLessThan(ranks.get('late')!)
      expect(ranks.get('absent')).toBe(-1)
    } finally {
      document.body.innerHTML = ''
    }
  })

  it('re-anchors a lost mark by finding the quotation text', () => {
    mountConversation()
    try {
      expect(anchorQuote(SESSION, 're-anchored', 'second block mentions')).toBe(true)
      const mark = document.querySelector(`[${MARK_ATTR}="re-anchored"]`)
      expect(mark).not.toBeNull()
      expect(mark?.textContent).toBe('second block mentions')

      // Idempotent: an existing mark needs no re-anchoring.
      expect(anchorQuote(SESSION, 're-anchored', 'second block mentions')).toBe(true)
      expect(document.querySelectorAll(`[${MARK_ATTR}="re-anchored"]`)).toHaveLength(1)

      // An absent quotation reports failure without touching the DOM.
      expect(anchorQuote(SESSION, 'missing', 'nowhere to be found')).toBe(false)
      expect(document.querySelector(`[${MARK_ATTR}="missing"]`)).toBeNull()
    } finally {
      document.body.innerHTML = ''
    }
  })
})
