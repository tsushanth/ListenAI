import { authorizationServerMetadata } from '@/lib/oauth/metadata'
import { wellKnown } from '@/lib/oauth/wellknown'

export const dynamic = 'force-dynamic'
const h = wellKnown(authorizationServerMetadata)
export const GET = h.GET
export const OPTIONS = h.OPTIONS
