import type { NextConfig } from 'next';

/**
 * The dashboard is built as static files (ARCHITECTURE.md, decision 116):
 * every page renders in the browser, which calls the API itself, under
 * `/api` of its own host (decision 117). In development `next dev` passes
 * madAuth's paths and the API's on to their servers, as the ingress does in
 * a cluster, so the session cookie is the page's own and reaches both.
 */
const madauthUrl = process.env['MADAUTH_URL'] ?? 'http://localhost:8787';
const apiUrl = process.env['API_URL'] ?? 'http://localhost:8080';

const config: NextConfig =
    process.env['NODE_ENV'] === 'production'
        ? { output: 'export' }
        : {
              rewrites: async () => [
                  { source: '/auth/:path*', destination: `${madauthUrl}/auth/:path*` },
                  { source: '/.well-known/:path*', destination: `${madauthUrl}/.well-known/:path*` },
                  // Without the prefix, as the ingress strips it.
                  { source: '/api/:path*', destination: `${apiUrl}/:path*` },
              ],
          };

export default config;
