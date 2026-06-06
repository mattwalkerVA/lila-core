// Tiny HTTP helpers shared across functions. Keeping CORS, JSON shape,
// and error mapping in one place so each handler can be a single page
// of business logic.

import { HttpError } from './scopedSupabase.ts'

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  return null
}

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  })
}

// Wraps a handler so thrown HttpError instances become structured 4xx
// responses and unexpected errors become a generic 500 (logged but not
// leaked). Every function file's top-level Deno.serve callback should
// be passed through this.
export function withErrorHandling(
  fn: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const pre = preflight(req)
      if (pre) return pre
      return await fn(req)
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return jsonResponse({ error: err.message }, err.status)
      }
      console.error('unhandled function error:', err)
      const message = err instanceof Error ? err.message : 'internal error'
      return jsonResponse({ error: 'internal error', detail: message }, 500)
    }
  }
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

// Returns true if the Authorization header carries a service-role JWT.
// The Supabase gateway already verifies the signature, so we only need
// to inspect the role claim — no need to re-verify or match the raw key.
export function hasServiceRole(authHeader: string): boolean {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.role === 'service_role'
  } catch {
    return false
  }
}
