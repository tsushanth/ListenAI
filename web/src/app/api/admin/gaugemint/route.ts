// GET /api/admin/gaugemint?period=7d|30d|12mo: website numbers of this site from Gaugemint, for the "Web" tab of /admin.
// Same admin check as /api/admin/overview (404 unless the bearer token is the allowlisted Google account). Separate route on purpose:
// a slow or broken Gaugemint can only affect this card, never the overview. The key (GAUGEMINT_READ_KEY) stays on the server and the
// domain is fixed by GAUGEMINT_DOMAIN, never taken from the request.
import { NextResponse } from 'next/server';
import { isAdminToken } from '@/lib/adminAuth';
import { adminGaugemint } from '@/lib/adminGaugemint';
import { getGaugemintStats } from '@/lib/gaugemintRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await isAdminToken(request.headers.get('authorization')))) return new NextResponse('Not found', { status: 404 });

  const r = await adminGaugemint({ isAdmin: true, period: new URL(request.url).searchParams.get('period'), getStats: getGaugemintStats });
  return new NextResponse(r.body, { status: r.status, headers: { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' } });
}
