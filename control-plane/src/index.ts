/**
 * openupstream control plane.
 *
 * Owns accounts, tenants, databases, buckets, services, the routing table,
 * secrets, API keys and usage events. Provisions by writing Kubernetes
 * objects and leaving reconciliation to the operators.
 *
 * This is a placeholder entry point; the HTTP server lands with the first
 * product (Postgres). See ARCHITECTURE.md for the build order.
 */
import { createServer } from 'node:http';

const port = Number(process.env['PORT'] ?? 8080);

export function startServer(): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
        if (req.url === '/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(port);
    return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    startServer();
    console.log(`control plane listening on :${port}`);
}
