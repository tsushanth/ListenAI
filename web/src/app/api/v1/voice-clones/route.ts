import { handleVoiceCloneRest } from '@/lib/mcp/voiceCloneRest'

// Consent-gated voice cloning REST API (list + create). See src/lib/mcp/voiceCloneRest.ts and /developers#voice-cloning-api.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 300

export const GET = (req: Request) => handleVoiceCloneRest(req, { op: 'list' })
export const POST = (req: Request) => handleVoiceCloneRest(req, { op: 'create' })
