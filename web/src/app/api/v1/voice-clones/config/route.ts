import { handleVoiceCloneRest } from '@/lib/mcp/voiceCloneRest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export const GET = (req: Request) => handleVoiceCloneRest(req, { op: 'config' })
