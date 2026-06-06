// POST /connectors-google-calendar-oauth
// User-authed. iOS calls this with the authorization code after Google consent.
// Exchanges code for tokens and writes connector_accounts (provider='google_calendar').
// Native iOS flow: ios_client_id present → no client_secret.

import { authenticate, adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'

interface Body {
  code: string
  redirect_uri: string
  ios_client_id?: string
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.code) throw new HttpError(400, 'code required')
  if (!body.redirect_uri) throw new HttpError(400, 'redirect_uri required')

  const isNativeFlow = !!body.ios_client_id
  const clientId = isNativeFlow ? body.ios_client_id! : (Deno.env.get('GOOGLE_CLIENT_ID') ?? '')
  const clientSecret = isNativeFlow ? null : (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '')

  if (!clientId) throw new HttpError(500, 'google oauth not configured')
  if (!isNativeFlow && !clientSecret) throw new HttpError(500, 'google oauth not configured')

  const exchangeParams: Record<string, string> = {
    code: body.code,
    client_id: clientId,
    redirect_uri: body.redirect_uri,
    grant_type: 'authorization_code',
  }
  if (clientSecret) exchangeParams.client_secret = clientSecret

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(exchangeParams),
  })
  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    throw new HttpError(502, `google token exchange failed: ${text}`)
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    scope?: string
  }
  if (!tokens.refresh_token) {
    throw new HttpError(400, 'no refresh_token — user may need to revoke and re-authorize')
  }

  const { error } = await adminSupabase.from('connector_accounts').upsert(
    {
      user_id: userId,
      provider: 'google_calendar',
      refresh_token: tokens.refresh_token,
      scopes: tokens.scope ?? 'https://www.googleapis.com/auth/calendar.readonly',
      oauth_client_id: isNativeFlow ? clientId : null,
      history_id: null,
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_synced_at: null,
    },
    { onConflict: 'user_id,provider' },
  )
  if (error) throw new HttpError(500, `connector_accounts upsert: ${error.message}`)

  return jsonResponse({ connected: true })
}))
