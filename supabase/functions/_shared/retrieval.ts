import { adminSupabase } from './scopedSupabase.ts'

export interface MemoryRetrievalResult {
  source_table: string
  source_id: string
  title: string | null
  body: string | null
  created_at: string
  score: number
  metadata: Record<string, unknown>
}

export interface RetrieveMemoryArgs {
  userId: string
  query: string
  limit?: number
  reason?: string
  conversationMessageId?: string | null
  logAccess?: boolean
}

export async function retrieveMemory(args: RetrieveMemoryArgs): Promise<MemoryRetrievalResult[]> {
  const query = args.query.trim()
  if (query.length < 2) return []

  const limit = Math.min(Math.max(args.limit ?? 8, 1), 20)
  const { data, error } = await adminSupabase.rpc('lila_search_memory', {
    search_user_id: args.userId,
    search_query: query,
    match_limit: limit,
  })
  if (error) throw new Error(`memory retrieval failed: ${error.message}`)

  const results = ((data ?? []) as MemoryRetrievalResult[])
    .filter((row) => row.source_table && row.source_id)
    .slice(0, limit)

  if (args.logAccess !== false && results.length > 0) {
    await logMemoryAccesses({
      userId: args.userId,
      query,
      reason: args.reason ?? 'retrieval',
      conversationMessageId: args.conversationMessageId ?? null,
      results,
    })
  }

  return results
}

async function logMemoryAccesses(args: {
  userId: string
  query: string
  reason: string
  conversationMessageId: string | null
  results: MemoryRetrievalResult[]
}) {
  const rows = args.results.map((result) => ({
    user_id: args.userId,
    query: args.query,
    source_table: result.source_table,
    source_id: result.source_id,
    retrieval_kind: 'lexical',
    score: result.score,
    reason: args.reason,
    conversation_message_id: args.conversationMessageId,
    metadata: {
      title: result.title,
      created_at: result.created_at,
      ...result.metadata,
    },
  }))

  const { error } = await adminSupabase.from('memory_accesses').insert(rows)
  if (error) {
    // Retrieval should not fail just because audit logging hiccupped.
    console.error('memory_accesses insert failed:', error.message)
  }
}

export function renderRetrievedMemoryContext(results: MemoryRetrievalResult[]): string {
  if (results.length === 0) return ''
  const lines: string[] = ['# Retrieved memory']
  for (const [i, result] of results.entries()) {
    lines.push(`## Source ${i + 1}: ${result.source_table}:${result.source_id}`)
    lines.push(JSON.stringify({
      table: result.source_table,
      id: result.source_id,
      title: result.title,
      body: truncate(result.body ?? '', 900),
      created_at: result.created_at,
      score: result.score,
      metadata: result.metadata,
    }, null, 2))
  }
  return lines.join('\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trim()}…`
}
