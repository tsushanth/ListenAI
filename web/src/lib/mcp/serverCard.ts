import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server.ts'

// Static MCP "server card" (served at /.well-known/mcp/server-card.json) for directories such as Smithery that scan a server's tools. The live
// server needs a login for everything, so a scanner that cannot sign in would see nothing. The card is built from the real server (an in-memory
// client calls tools/list on createMcpServer), so it can never drift from what /mcp actually offers. No credentials are involved: the tool list
// is static metadata, and tool handlers are never called.

export interface ServerCard {
  serverInfo: { name: string; version: string }
  authentication: { required: boolean; schemes: string[] }
  tools: unknown[]
  resources: unknown[]
  prompts: unknown[]
}

export async function buildServerCard(): Promise<ServerCard> {
  const server = createMcpServer({ keyId: 'server-card', apiKey: '' })
  const client = new Client({ name: 'server-card', version: '1.0.0' })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  try {
    const tools: unknown[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    const info = client.getServerVersion()
    return {
      serverInfo: { name: info?.name ?? 'readaloud-ai', version: info?.version ?? '1.0.0' },
      authentication: { required: true, schemes: ['oauth2'] },
      tools,
      resources: [],
      prompts: [],
    }
  } finally {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}
