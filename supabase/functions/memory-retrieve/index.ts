// POST /memory/retrieve
// Body: { query: string, limit?: number }
//
// Authenticated lexical retrieval over Lila's substrate. This is the Memory v2
// foundation: every result is source-addressable and every retrieval is
// written to memory_accesses so "why did Lila know that?" has an audit trail.

import { authenticate, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'
import { retrieveMemory } from '../_shared/retrieval.ts'

interface Body {
  query?: string
  limit?: number
}

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  const query = body.query?.trim()
  if (!query) throw new HttpError(400, 'query required')

  const results = await retrieveMemory({
    userId,
    query,
    limit: body.limit ?? 8,
    reason: 'manual_memory_retrieve',
  })

  return jsonResponse({ results })
}))
