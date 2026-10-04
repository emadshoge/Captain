import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages are shipped as TypeScript source.
  transpilePackages: ['@captain/contracts'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Container images use the standalone server (docker/web.Dockerfile).
  ...(process.env.NEXT_STANDALONE === '1'
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
      }
    : {}),
};

export default nextConfig;
