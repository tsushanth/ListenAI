import { NextResponse } from 'next/server'
import { forwardAdminDashboard } from '@/lib/adminProxy'

export const dynamic = 'force-dynamic'
// Deliberately not NEXT_PUBLIC_API_URL: that secret still points at the retired Cloud Run backend (404 on everything).
const BACKEND = process.env.ADMIN_BACKEND_URL || 'https://listenai-backend.fly.dev'

export async function GET(request: Request) {
  const r = await forwardAdminDashboard({
    backendBase: BACKEND,
    authorization: request.headers.get('authorization'),
    range: new URL(request.url).searchParams.get('range'),
  })
  return new NextResponse(r.body, { status: r.status, headers: { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' } })
}
