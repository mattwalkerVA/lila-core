// Backfill embeddings into the vector(1024) columns created for Memory v2.
//
// This script is intentionally provider-light: it uses OpenAI-compatible
// /v1/embeddings over fetch, with dimensions defaulting to 1024 so the
// output fits the existing pgvector columns.
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//
// Optional env:
//   EMBEDDING_MODEL=text-embedding-3-small
//   EMBEDDING_DIMENSIONS=1024
//   EMBEDDING_BATCH_SIZE=24
//   EMBEDDING_TABLE=captures      # limit to one table while testing

import { makeServiceClient } from '../src/memory/supabase.js'

interface TableSpec {
  table: string
  select: string
  text: (row: any) => string
}

const TABLES: TableSpec[] = [
  { table: 'captures', select: 'id, raw_text', text: (r) => r.raw_text },
  { table: 'tasks', select: 'id, title, first_step, notes', text: (r) => [r.title, r.first_step, r.notes].filter(Boolean).join('\n') },
  { table: 'notes', select: 'id, title, content', text: (r) => [r.title, r.content].filter(Boolean).join('\n') },
  { table: 'reflections', select: 'id, prompt, content', text: (r) => [r.prompt, r.content].filter(Boolean).join('\n') },
  { table: 'messages', select: 'id, person, body', text: (r) => [r.person, r.body].filter(Boolean).join('\n') },
  { table: 'bookmarks', select: 'id, url, title, summary', text: (r) => [r.title, r.summary, r.url].filter(Boolean).join('\n') },
  { table: 'memories', select: 'id, topic_key, content', text: (r) => [r.topic_key, r.content].filter(Boolean).join('\n') },
  { table: 'conversation_messages', select: 'id, role, content', text: (r) => [r.role, r.content].filter(Boolean).join('\n') },
]

const url = requireEnv('SUPABASE_URL')
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
const openAIKey = requireEnv('OPENAI_API_KEY')
const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small'
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? '1024')
const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE ?? '24')
const onlyTable = process.env.EMBEDDING_TABLE

const supabase = makeServiceClient({ url, serviceRoleKey })

for (const spec of TABLES.filter((t) => !onlyTable || t.table === onlyTable)) {
  let embedded = 0
  for (;;) {
    const { data, error } = await supabase
      .from(spec.table)
      .select(spec.select)
      .is('embedded_at', null)
      .limit(batchSize)
    if (error) throw new Error(`${spec.table} select failed: ${error.message}`)
    const rows = (data ?? []).filter((row) => spec.text(row).trim().length > 0)
    if (rows.length === 0) break

    const vectors = await embed(rows.map((row) => spec.text(row)))
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const vector = vectors[i]!
      const { error: updateError } = await supabase
        .from(spec.table)
        .update({
          embedding: vectorLiteral(vector),
          embedding_model: model,
          embedded_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      if (updateError) throw new Error(`${spec.table} update ${row.id} failed: ${updateError.message}`)
      embedded += 1
    }
    console.log(`${spec.table}: embedded ${embedded}`)
  }
}

async function embed(inputs: string[]): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAIKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: inputs,
      dimensions,
    }),
  })
  if (!response.ok) {
    throw new Error(`embedding request failed ${response.status}: ${await response.text()}`)
  }
  const body = await response.json() as { data: Array<{ embedding: number[] }> }
  return body.data.map((item) => item.embedding)
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(',')}]`
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
