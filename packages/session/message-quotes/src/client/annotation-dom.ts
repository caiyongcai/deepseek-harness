/** DOM anchors for quotation annotations: wrap the selection, reveal it, unwrap it. */

/** Attribute marking the conversation span(s) one annotation anchors to. */
export const MARK_ATTR = 'data-dsh-annotation'

/** Attribute flipped on for the short attention flash after a reveal. */
export const FLASH_ATTR = 'data-dsh-annotation-flash'

/** How long the reveal flash stays on, matching the CSS animation. */
const FLASH_MS = 1800

/** Word-style mark and flash rules, injected once per document by the plugin. */
const MARK_STYLES = `
[${MARK_ATTR}] {
  background: rgba(255, 197, 23, 0.4);
  border-bottom: 1px solid rgba(176, 132, 0, 0.65);
  border-radius: 2px;
  cursor: pointer;
}
[${FLASH_ATTR}] {
  animation: dsh-annotation-flash 1.6s ease-out;
}
@keyframes dsh-annotation-flash {
  0% { background: rgba(255, 152, 0, 0.85); }
  100% { background: rgba(255, 197, 23, 0.4); }
}
.dsh-anno-ask {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 14px;
  corner-shape: round;
  background: var(--dsw-alias-button-floating-fill, rgba(255, 255, 255, 0.98));
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-elevation-panel, 0 4px 16px rgba(0, 0, 0, 0.18));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px sans-serif);
}
.dsh-anno-ask-input {
  width: 240px;
  padding: 5px 10px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-input-fill, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px sans-serif);
  outline: none;
}
.dsh-anno-ask-input::placeholder {
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
}
.dsh-anno-ask-button {
  padding: 5px 10px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-button-floating-fill, rgba(240, 240, 240, 0.98));
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-elevation-panel, 0 2px 8px rgba(0, 0, 0, 0.14));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px sans-serif);
  cursor: pointer;
  white-space: nowrap;
}
.dsh-anno-ask-button:focus-visible,
.dsh-anno-ask-button:hover {
  background: var(--dsw-alias-button-floating-hover, rgba(226, 226, 226, 0.98));
}
.dsh-anno-ask-button:disabled {
  opacity: 0.5;
  cursor: default;
}
`

/**
 * Append the mark rules to the document head once.
 * @param doc - the browser document hosting the conversation.
 */
export function injectMarkStyles(doc: Document): void {
  if (doc.getElementById('dsh-annotation-mark-styles') !== null) return
  const style = doc.createElement('style')
  style.id = 'dsh-annotation-mark-styles'
  style.textContent = MARK_STYLES
  doc.head.appendChild(style)
}

/**
 * Wrap the live selection's text in mark spans carrying the annotation identity.
 * @param id - the annotation the mark belongs to.
 * @returns whether anything was wrapped; false leaves the caller to abort the annotation.
 */
export function wrapSelection(id: string): boolean {
  const selection = globalThis.getSelection?.()
  if (selection === undefined || selection === null || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (range.collapsed) return false
  const root = range.commonAncestorContainer
  const candidates: Text[] = []
  if (root.nodeType === Node.TEXT_NODE) {
    candidates.push(root as Text)
  } else {
    const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      if (node instanceof Text && node.data.length > 0 && range.intersectsNode(node)) candidates.push(node)
      node = walker.nextNode()
    }
  }
  let wrapped = 0
  for (const textNode of candidates) {
    const sub = (textNode.ownerDocument ?? document).createRange()
    sub.selectNodeContents(textNode)
    if (textNode === range.startContainer) sub.setStart(textNode, range.startOffset)
    if (textNode === range.endContainer) sub.setEnd(textNode, range.endOffset)
    if (sub.collapsed) continue
    try {
      const mark = (textNode.ownerDocument ?? document).createElement('span')
      mark.setAttribute(MARK_ATTR, id)
      sub.surroundContents(mark)
      wrapped += 1
    } catch {
      // A subrange that still clips a non-text node cannot be surrounded; skip it.
    }
  }
  return wrapped > 0
}

/**
 * Remove one annotation's marks, restoring the plain text.
 * @param id - the annotation whose marks are unwrapped.
 */
export function unwrap(id: string): void {
  for (const mark of document.querySelectorAll(`[${MARK_ATTR}="${id}"]`)) {
    const parent = mark.parentNode
    if (parent === null) continue
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  }
}

/**
 * Find the first conversation mark of one annotation.
 * @param id - the annotation identity.
 * @returns the mark element, or null when its message is not currently rendered.
 */
export function findMark(id: string): HTMLElement | null {
  const mark = document.querySelector(`[${MARK_ATTR}="${id}"]`)
  return mark instanceof HTMLElement ? mark : null
}

/**
 * Flash every conversation mark of one annotation.
 * @param id - the annotation identity.
 */
export function flashMarks(id: string): void {
  for (const mark of document.querySelectorAll(`[${MARK_ATTR}="${id}"]`)) {
    mark.setAttribute(FLASH_ATTR, '')
    globalThis.setTimeout(() => { mark.removeAttribute(FLASH_ATTR) }, FLASH_MS)
  }
}

/**
 * Conversation order of every rendered annotation anchor: identity to its
 * index in document order, so the tab lists cards the way quotations flow.
 * @returns identity → document-order rank; unrendered anchors are absent.
 */
export function domOrder(): Map<string, number> {
  const order = new Map<string, number>()
  for (const mark of document.querySelectorAll(`[${MARK_ATTR}]`)) {
    const id = mark.getAttribute(MARK_ATTR)
    if (id !== null && !order.has(id)) order.set(id, order.size)
  }
  return order
}

/**
 * The conversation region one Session's messages render into. Scoping every
 * text search here keeps quotation matching out of the annotation panel
 * itself, where every quote is echoed as a card header.
 * @param sessionId - the Session whose conversation is searched.
 * @returns the chat content element, or null while it is not rendered.
 */
export function conversationRoot(sessionId: string): HTMLElement | null {
  const selector = `[data-conversation-content][data-conversation-session="${sessionId.replace(/"/g, '\\"')}"]`
  const root = document.querySelector(selector)
  return root instanceof HTMLElement ? root : null
}

/** One located text node in a collected conversation text. */
interface TextNodeSpan {
  readonly node: Text
  /** Offset of the node's data within the collected text. */
  readonly start: number
}

/** The conversation's concatenated text plus the nodes it came from. */
interface CollectedText {
  readonly text: string
  readonly nodes: readonly TextNodeSpan[]
}

/**
 * Concatenate every text node under one element, remembering each node's
 * offset so a match range can be rebuilt across node boundaries.
 */
function collectText(root: Element): CollectedText {
  const nodes: TextNodeSpan[] = []
  let text = ''
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if (node instanceof Text && node.data.length > 0) {
      nodes.push({ node, start: text.length })
      text += node.data
    }
    node = walker.nextNode()
  }
  return { text, nodes }
}

/** Collapse whitespace runs to single spaces, preserving document order. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ')
}

/**
 * Wrap one annotation's quotation in mark spans by finding its text in the
 * conversation — the re-anchoring path for marks lost to a re-render or a
 * reload, mirroring what {@link wrapSelection} does at creation time.
 * @param sessionId - the Session whose conversation holds the quotation.
 * @param id - the annotation the marks belong to.
 * @param quote - the quoted conversation text to locate.
 * @returns whether the quotation was found and wrapped (or already marked).
 */
export function anchorQuote(sessionId: string, id: string, quote: string): boolean {
  if (findMark(id) !== null) return true
  const root = conversationRoot(sessionId)
  if (root === null || quote.length === 0) return false
  const { text, nodes } = collectText(root)
  const start = text.indexOf(quote)
  if (start < 0) return false
  const end = start + quote.length
  let wrapped = 0
  for (const span of nodes) {
    const nodeEnd = span.start + span.node.data.length
    const from = Math.max(start, span.start)
    const to = Math.min(end, nodeEnd)
    if (from >= to) continue
    const sub = (span.node.ownerDocument ?? document).createRange()
    sub.setStart(span.node, from - span.start)
    sub.setEnd(span.node, to - span.start)
    try {
      const mark = (span.node.ownerDocument ?? document).createElement('span')
      mark.setAttribute(MARK_ATTR, id)
      sub.surroundContents(mark)
      wrapped += 1
    } catch {
      // A subrange that still clips a non-text node cannot be surrounded; skip it.
    }
  }
  return wrapped > 0
}

/**
 * Locate each quotation's position in the conversation text, for ordering
 * cards the way their quotations flow. Matching falls back to
 * whitespace-normalized comparison (markdown rendering may reflow runs of
 * spaces); both coordinates grow monotonically with document order, so
 * mixing them still sorts correctly. Unfound quotations rank -1.
 * @param sessionId - the Session whose conversation is searched.
 * @param quotes - the annotations to rank, by identity and quotation.
 * @returns identity → character offset of its quotation, or -1 when absent.
 */
export function quoteRanks(sessionId: string, quotes: readonly { id: string; quote: string }[]): Map<string, number> {
  const ranks = new Map<string, number>()
  const root = conversationRoot(sessionId)
  if (root === null) {
    for (const { id } of quotes) ranks.set(id, -1)
    return ranks
  }
  const { text } = collectText(root)
  const normalized = normalizeWhitespace(text)
  for (const { id, quote } of quotes) {
    let rank = quote.length === 0 ? -1 : text.indexOf(quote)
    if (rank < 0) {
      const needle = normalizeWhitespace(quote)
      rank = needle.length === 0 ? -1 : normalized.indexOf(needle)
    }
    ranks.set(id, rank)
  }
  return ranks
}

/** The live ask popover, if one is open. */
let askPopover: { readonly close: () => void } | null = null

/** Options for the standalone ask popover. */
export interface AskPopoverOptions {
  /** Viewport rect of the anchored selection; the popover opens right below it. */
  readonly anchor: DOMRect | null
  /** Input placeholder and aria label. */
  readonly placeholder: string
  /** Submit button label. */
  readonly submitLabel: string
  /** Cancel button label. */
  readonly cancelLabel: string
  /** Called with the trimmed question on submit; never with an empty string. */
  readonly onSubmit: (question: string) => void
  /** Called when the popover is dismissed without a question. */
  readonly onCancel: () => void
}

/**
 * Open the standalone "ask about this quotation" popover.
 *
 * The conversation's selection popup is torn down the moment its DOM
 * selection stops matching (the wrap itself collapses it), so the question
 * input lives here instead: plain DOM appended to the document body, immune
 * to the popup's lifecycle. Only one popover exists at a time; opening a new
 * one closes the previous.
 * @param opts - placement, labels, and the submit/cancel callbacks.
 */
export function openAskPopover(opts: AskPopoverOptions): void {
  closeAskPopover()
  const box = document.createElement('div')
  box.className = 'dsh-anno-ask'
  box.setAttribute('role', 'group')
  const input = document.createElement('input')
  input.className = 'dsh-anno-ask-input'
  input.type = 'text'
  input.placeholder = opts.placeholder
  input.setAttribute('aria-label', opts.placeholder)
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'dsh-anno-ask-button'
  submit.textContent = opts.submitLabel
  submit.disabled = true
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dsh-anno-ask-button'
  cancel.textContent = opts.cancelLabel
  box.append(input, submit, cancel)

  let settled = false
  const settle = (finish: 'submit' | 'cancel'): void => {
    if (settled) return
    settled = true
    close()
    const question = input.value.trim()
    if (finish === 'submit' && question.length > 0) opts.onSubmit(question)
    else opts.onCancel()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') { event.preventDefault(); if (input.value.trim().length > 0) settle('submit') }
    else if (event.key === 'Escape') { event.preventDefault(); settle('cancel') }
  }
  const onInput = (): void => { submit.disabled = input.value.trim().length === 0 }
  const onSubmitClick = (): void => { if (input.value.trim().length > 0) settle('submit') }
  const onCancelClick = (): void => { settle('cancel') }
  const onOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && box.contains(event.target)) return
    settle('cancel')
  }
  const close = (): void => {
    askPopover = null
    input.removeEventListener('keydown', onKey)
    input.removeEventListener('input', onInput)
    submit.removeEventListener('click', onSubmitClick)
    cancel.removeEventListener('click', onCancelClick)
    document.removeEventListener('pointerdown', onOutside)
    box.remove()
  }
  input.addEventListener('keydown', onKey)
  input.addEventListener('input', onInput)
  submit.addEventListener('click', onSubmitClick)
  cancel.addEventListener('click', onCancelClick)
  document.body.appendChild(box)
  askPopover = { close }
  // Place after layout so the box can be measured, clamped into the viewport.
  const width = box.offsetWidth
  const height = box.offsetHeight
  const anchor = opts.anchor ?? { left: Math.max(12, (window.innerWidth - width) / 2), bottom: 96, top: 96 } as DOMRect
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8))
  const below = anchor.bottom + 8
  const top = below + height > window.innerHeight ? Math.max(8, anchor.top - height - 8) : below
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  // The opening click is still dispatching; only treat later pointers as outside.
  window.setTimeout(() => { if (!settled) document.addEventListener('pointerdown', onOutside) }, 0)
  input.focus()
}

/** Close the ask popover, if one is open, as if cancelled. */
export function closeAskPopover(): void {
  askPopover?.close()
}
