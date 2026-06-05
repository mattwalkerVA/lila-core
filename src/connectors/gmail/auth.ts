// OAuth: connector_accounts refresh_token → access_token.
//
// Multi-user: each user's refresh token lives in connector_accounts,
// encrypted at rest. The caller decrypts before passing it here.
// This contrasts with the single-token-in-env model the dogfood
// calendar connector used; email needs real per-user storage because
// it runs against every user's inbox, not just the developer's.

export interface AccessToken {
  token: string
  expiresAt: number
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export async function exchangeRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AccessToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`gmail oauth ${res.status}: ${text}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  }
}
