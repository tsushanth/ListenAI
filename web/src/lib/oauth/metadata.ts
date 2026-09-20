import { baseUrl, resourceUrl } from './config.ts'

export const protectedResourceMetadata = () => ({
  resource: resourceUrl(),
  authorization_servers: [baseUrl()],
  bearer_methods_supported: ['header'],
  resource_name: 'ReadAloud AI MCP server',
  resource_documentation: `${baseUrl()}/developers/mcp`,
})

export const authorizationServerMetadata = () => ({
  issuer: baseUrl(),
  authorization_endpoint: `${baseUrl()}/oauth/authorize`,
  token_endpoint: `${baseUrl()}/oauth/token`,
  registration_endpoint: `${baseUrl()}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  service_documentation: `${baseUrl()}/developers/mcp`,
})
