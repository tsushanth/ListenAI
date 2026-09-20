/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: ['ws'] },
  images: {
    domains: ['readaloudai.org'],
  },
}

module.exports = nextConfig
