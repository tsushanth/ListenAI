import { handleVoiceCloneRest } from '@/lib/mcp/voiceCloneRest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export const DELETE = (req: Request, ctx: { params: { id: string } }) => handleVoiceCloneRest(req, { op: 'delete', id: ctx.params.id })
