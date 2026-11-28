/**
 * What the control plane tells Prometheus, on METRICS_PORT and nothing
 * else: the Site checks (ADR-0008). A port of its own, so Prometheus
 * reaches neither the public nor the internal API.
 */
import { Hono } from 'hono';
import { type ReadSites, siteMetrics } from './sites.js';

export function createMetricsApp(readSites: ReadSites): Hono {
    const app = new Hono();
    app.get('/metrics', async (c) => {
        const sites = await readSites();
        c.header('content-type', 'text/plain; version=0.0.4');
        return c.body(siteMetrics(sites.ok ? sites.value : undefined));
    });
    return app;
}
