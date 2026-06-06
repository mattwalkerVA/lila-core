// Robust JSON extraction from a model response. Models occasionally wrap
// JSON in fences or add a trailing sentence even when told not to; this
// helper is the single place we forgive that.

export function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const obj = text.match(/\{[\s\S]*\}/)
  if (obj) return obj[0]
  throw new Error('no JSON object found in model output')
}

export function parseJsonObject<T = unknown>(text: string): T {
  const extracted = extractJsonObject(text)
  // Models occasionally emit literal newlines inside JSON string values.
  // JSON.parse rejects these (strings must use \n escape sequences).
  // Replacing all literal CR/LF with a space is safe: JSON uses whitespace
  // only as structural formatting between tokens, never inside string values.
  const cleaned = extracted.replace(/\r?\n/g, ' ')
  return JSON.parse(cleaned) as T
}
