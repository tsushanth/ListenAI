import { handleVoiceCloneRest } from '@/lib/mcp/voiceCloneRest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 300

export const POST = (req: Request, ctx: { params: { id: string } }) => handleVoiceCloneRest(req, { op: 'speech', id: ctx.params.id })
