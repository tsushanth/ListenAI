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
