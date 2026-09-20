// The voice studio's test mock (fake session, local mock backend) must never ship: building with it needs an
// explicit opt-in that a production pipeline never sets.
if (process.env.NEXT_PUBLIC_VOICE_STUDIO_MOCK === '1' && process.env.RA_ALLOW_MOCK_BUILD !== '1') {
  throw new Error('NEXT_PUBLIC_VOICE_STUDIO_MOCK is a test-only flag; refusing to build without RA_ALLOW_MOCK_BUILD=1')
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: ['ws'] },
  async headers() {
    const frame = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ]
    return [{ source: '/oauth/:path*', headers: frame }]
  },
  images: {
    domains: ['readaloudai.org'],
  },
}

module.exports = nextConfig
