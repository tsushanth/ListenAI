export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Plain HTML error page for authorization problems (never redirects). */
export function errorPage(message: string, status = 400): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect - ReadAloud AI</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#fff;color:#15171c;max-width:32rem;margin:15vh auto;padding:0 1.25rem}h1{font-size:1.4rem}</style></head><body><h1>We could not start this connection</h1><p>${esc(message)}</p><p>Nothing was connected. Go back to the app you were connecting and try again.</p></body></html>`
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } })
}
