/** @type {import('next').NextConfig} */
const nextConfig = {
  // ccxt requires these to be excluded from edge runtime
  serverExternalPackages: ['ccxt'],
}

module.exports = nextConfig
