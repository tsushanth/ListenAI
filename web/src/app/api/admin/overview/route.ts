// GET /api/admin/overview: authenticates the signed-in user, then proxies the reporter Worker.
// Requires env: ADMIN_DASH_SECRET (same value as the Worker's DASH_SECRET). Optional: ADMIN_EMAILS.
import { NextResponse } from 'next/server';
import { isAdminToken } from '@/lib/adminAuth';

const APP = 'readaloud';
const WORKER = 'https://app-failure-reporter.t-sushanth.workers.dev';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await isAdminToken(request.headers.get('authorization')))) return new NextResponse('Not found', { status: 404 });

  const secret = process.env.ADMIN_DASH_SECRET;
  if (!secret) return NextResponse.json({ error: 'ADMIN_DASH_SECRET not configured' }, { status: 500 });

  const params = new URL(request.url).searchParams;
  const hours = Math.min(Math.max(Number(params.get('hours')) || 24, 1), 720);
  const sc = params.get('scope');
  const scope = sc === 'app' || sc === 'api' ? `&scope=${sc}` : '';
  const res = await fetch(`${WORKER}/admin/api/overview?app=${APP}&hours=${hours}${scope}`, {
    headers: { 'X-Dash-Secret': secret },
    cache: 'no-store',
  });
  if (!res.ok) return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
  return NextResponse.json(await res.json(), { headers: { 'Cache-Control': 'no-store' } });
}
