// The voice studio's test mock (fake session, local mock backend) must never ship: building with it needs an
// explicit opt-in that a production pipeline never sets.
if (process.env.NEXT_PUBLIC_VOICE_STUDIO_MOCK === '1' && process.env.RA_ALLOW_MOCK_BUILD !== '1') {
  throw new Error('NEXT_PUBLIC_VOICE_STUDIO_MOCK is a test-only flag; refusing to build without RA_ALLOW_MOCK_BUILD=1')
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: ['ws'] },
  poweredByHeader: false,
  async headers() {
    // Baseline hardening for every page except /oauth (which gets the stricter frame rules below).
    // No includeSubDomains on HSTS: api.readaloudai.org and tts.readaloudai.org are served separately.
    const baseline = [
      { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ]
    const frame = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ]
    return [
      { source: '/((?!oauth(?:/|$)).*)', headers: baseline },
      { source: '/oauth/:path*', headers: frame },
    ]
  },
  images: {
    domains: ['readaloudai.org'],
  },
}

module.exports = nextConfig
