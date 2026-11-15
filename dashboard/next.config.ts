import type { NextConfig } from 'next';

/**
 * The dashboard is built as static files (ARCHITECTURE.md, decision 116):
 * every page renders in the browser, which calls the API itself. In
 * development `next dev` also passes madAuth's paths on to a madAuth server,
 * as the ingress does in a cluster, so its session cookie is the page's own.
 */
const madauthUrl = process.env['MADAUTH_URL'] ?? 'http://localhost:8787';

const config: NextConfig =
    process.env['NODE_ENV'] === 'production'
        ? { output: 'export' }
        : {
              rewrites: async () => [
                  { source: '/auth/:path*', destination: `${madauthUrl}/auth/:path*` },
                  { source: '/.well-known/:path*', destination: `${madauthUrl}/.well-known/:path*` },
              ],
          };

export default config;
