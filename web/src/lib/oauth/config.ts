// Public URLs. Overridable so the integration test can run on localhost; production uses the defaults.
export function baseUrl(): string {
  return (process.env.OAUTH_PUBLIC_BASE_URL || 'https://readaloudai.org').replace(/\/+$/, '')
}
export const issuer = baseUrl
export const resourceUrl = () => `${baseUrl()}/mcp`
export const resourceMetadataUrl = () => `${baseUrl()}/.well-known/oauth-protected-resource/mcp`

export const ACCESS_TTL_SEC = 3600
export const REFRESH_TTL_SEC = 30 * 24 * 3600
export const CODE_TTL_SEC = 60
export const CONNECTOR_LABEL_PREFIX = 'MCP connector ('
