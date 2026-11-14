/** Conversation-context assembly for one-shot quotation annotations. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionAnnotations } from '../src/annotations.ts'

/** Target Session identity shared by the agent double and the query stub. */
const SESSION = SessionId('session-annotations-context')

/** Direct-entry double: init is invoked by the harness, not the plugin loader. */
class TestAnnotations extends SessionAnnotations {
  initialize(): Promise<void> {
    return this[Service.init]()
  }
}

const contexts = new Set<Context>()

afterEach(async () => {
  try {
    await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  } finally {
    contexts.clear()
  }
})

/** The model-side request captured by the llm stub. */
let captured: GenerateOptions | undefined

/**
 * Install the two services `generate` reads plus a sessionQuery stub answering
 * either a fixed event log or a failure, then construct the service directly.
 * Storage and typert stay absent: no Remote method under test touches them.
 * @param events - the log the query stub reports, or the error it throws.
 * @returns the constructed annotation service.
 */
function harness(events: readonly SessionEvent[] | Error): TestAnnotations {
  const ctx = new Context()
  contexts.add(ctx)
  ctx.provide('llm', {
    stream: async function* (options: GenerateOptions) {
      captured = options
      yield { type: 'text-delta', index: 0, text: 'the answer' }
    },
  } as never)
  ctx.provide('sessionQuery', {
    readSession: async (sessionId: typeof SESSION) => {
      if (events instanceof Error) throw events
      return { session: { id: sessionId }, inheritedEventCount: 0, events }
    },
  } as never)
  return new TestAnnotations(ctx)
}

/** The lone user message's text of one captured request. */
function requestText(options: GenerateOptions | undefined): string {
  const block = options?.messages[0]?.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** Agent double supplying only the model route generate reads. */
function agentDouble(): Agent {
  return {
    id: SESSION,
    options: { provider: 'mock-provider', model: 'mock-model' },
    session: { id: SESSION, requestHeader: () => undefined },
  } as unknown as Agent
}

/** Monotonic event seq counter for the fabricated log. */
let seq = 0

/** One appended human user message. */
function userEvent(text: string, kind: 'user' | 'hook' = 'user'): SessionEvent {
  seq += 1
  return {
    type: 'user/message',
    seq,
    time: 1000,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: `u${seq}`,
      content: [{ type: 'text', text }],
      source: { kind },
    },
  } as unknown as SessionEvent
}

/**
 * One appended assistant message: a text reply, or a tool-call-only step when
 * `text` is null (which the transcript must skip).
 */
function assistantEvent(text: string | null): SessionEvent {
  seq += 1
  return {
    type: 'assistant/message',
    seq,
    time: 1000,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: `a${seq}`,
        content: text === null
          ? [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }]
          : [{ type: 'text', text }],
        source: { kind: 'model' },
      },
      stream: [],
    },
  } as unknown as SessionEvent
}

describe('SessionAnnotations conversation context', () => {
  it('sends the conversation from its start through the message holding the quotation', async () => {
    const annotations = harness([
      userEvent('What is deepseek-harness?'),
      assistantEvent(null),
      assistantEvent('It is a monorepo\nwith many packages.'),
      userEvent('And what about tests?'),
      assistantEvent('Tests live under tests/.'),
    ])
    const answer = await annotations.generate(agentDouble(), {
      kind: 'explain',
      // Whitespace differs from the log's line break: matching normalizes it.
      quote: 'monorepo   with many packages.',
    }, new AbortController().signal)
    expect(answer).toBe('the answer')
    expect(captured?.provider).toBe('mock-provider')
    expect(captured?.model).toBe('mock-model')
    const text = requestText(captured)
    // The conversation prefix and the quoted message itself travel whole.
    expect(text).toContain('User:\nWhat is deepseek-harness?')
    expect(text).toContain('Assistant:\nIt is a monorepo\nwith many packages.')
    // Everything after the quoted message, and tool-only steps, stay out.
    expect(text).not.toContain('And what about tests?')
    expect(text).not.toContain('Tests live under')
    expect(text).not.toContain('read_file')
    // The quotation and its framing close the message.
    expect(text).toContain('Quotation:\n"""\nmonorepo   with many packages.\n"""')
    expect(text).toContain('Explain this quotation')
  })

  it('keeps the whole conversation when no message contains the quotation', async () => {
    const annotations = harness([
      userEvent('First question'),
      assistantEvent('First answer'),
      userEvent('Second question'),
      assistantEvent('Second answer'),
    ])
    await annotations.generate(agentDouble(), { kind: 'ask', quote: 'a passage that appears nowhere', question: 'why?' },
      new AbortController().signal)
    const text = requestText(captured)
    expect(text).toContain('First question')
    expect(text).toContain('Second answer')
    expect(text).toContain('Question: why?')
  })

  it('skips injected non-human user messages', async () => {
    const annotations = harness([
      userEvent('Real prompt'),
      userEvent('injected file-change notice', 'hook'),
      assistantEvent('The reply'),
    ])
    await annotations.generate(agentDouble(), { kind: 'explain', quote: 'The reply' },
      new AbortController().signal)
    const text = requestText(captured)
    expect(text).toContain('Real prompt')
    expect(text).not.toContain('file-change notice')
  })

  it('answers with the quotation alone when the log read fails', async () => {
    const annotations = harness(new Error('storage unavailable'))
    const answer = await annotations.generate(agentDouble(), { kind: 'explain', quote: 'the quoted passage' },
      new AbortController().signal)
    expect(answer).toBe('the answer')
    const text = requestText(captured)
    expect(text).toContain('Quotation:')
    expect(text).toContain('the quoted passage')
    expect(text).not.toContain('User:')
    expect(text).not.toContain('Assistant:')
  })
})
