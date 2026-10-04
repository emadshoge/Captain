import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages are shipped as TypeScript source.
  transpilePackages: ['@captain/contracts'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
