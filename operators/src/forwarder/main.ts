/**
 * Entry point of a Project's database tunnel forwarder (./forwarder.ts), run
 * from the operators' image by the Deployment the Databases operator applies
 * (../databases/tunnel.ts).
 *
 * Environment:
 * - NAMESPACE: the Project's namespace, where its Databases' Services are
 * - PORT: where to listen, default 8080
 */
import { createForwarder, targetOf } from './forwarder.js';

const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const namespace = process.env['NAMESPACE'] ?? '';
const port = Number(process.env['PORT'] ?? 8080);
if (namespace === '' || !Number.isInteger(port)) {
    log({ msg: 'NAMESPACE is required, and PORT must be a number' });
    process.exit(1);
}

const server = createForwarder({ resolve: (path) => targetOf(path, namespace), log });
server.listen(port, () => log({ msg: 'forwarder listening', port, namespace }));
// Open tunnels end with the pod; `oup` opens a new one for the next connection.
process.once('SIGTERM', () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
});
