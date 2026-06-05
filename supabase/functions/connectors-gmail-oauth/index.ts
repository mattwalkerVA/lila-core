// POST /connectors-gmail-oauth
// User-authed. iOS calls this with the authorization code after the user
// completes the Google OAuth consent screen.
//
// Exchanges the code for tokens, writes (or updates) the connector_accounts
// row for this user. The refresh token is stored as-is here; encryption
// at rest is handled by the column's pgsodium/Vault policy in the migration.
//
// On success returns { connected: true }. On revocation (status='revoked'),
// the row is updated and the user must re-authorize.

import { authenticate, adminSupabase, HttpError } from '../_shared/scopedSupabase.ts'
import { withErrorHandling, jsonResponse, readJson } from '../_shared/http.ts'

interface Body {
  code: string
  redirect_uri: string
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

Deno.serve(withErrorHandling(async (req) => {
  const { userId } = await authenticate(req)
  const body = await readJson<Body>(req)
  if (!body.code) throw new HttpError(400, 'code required')
  if (!body.redirect_uri) throw new HttpError(400, 'redirect_uri required')

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
  if (!clientId || !clientSecret) throw new HttpError(500, 'google oauth not configured')

  // Exchange code → tokens.
  const params = new URLSearchParams({
    code: body.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: body.redirect_uri,
    grant_type: 'authorization_code',
  })
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    throw new HttpError(502, `google token exchange failed: ${text}`)
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    scope?: string
    token_type?: string
  }
  if (!tokens.refresh_token) {
    // Google only returns the refresh_token on first authorization or after
    // the user revokes and re-grants. If it's missing here, the user needs
    // to revoke and re-authorize.
    throw new HttpError(400, 'no refresh_token in response — user may need to revoke and re-authorize')
  }

  // Upsert the connector_accounts row. The refresh_token column is
  // encrypted at rest via the migration's pgsodium policy.
  const { error } = await adminSupabase.from('connector_accounts').upsert(
    {
      user_id: userId,
      provider: 'gmail',
      refresh_token: tokens.refresh_token,
      scopes: tokens.scope ?? 'https://www.googleapis.com/auth/gmail.readonly',
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
