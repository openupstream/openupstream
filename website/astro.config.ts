import { readFileSync, writeFileSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import type { AstroIntegration } from 'astro';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import { cliReference } from './src/lib/cli-reference.ts';

/**
 * Writes the `oup` reference page from `cli/README.md` before the content
 * is read, for `dev`, `build` and `check` alike. The page is not checked
 * in; a README without the markers fails the build.
 */
const cliReferencePage: AstroIntegration = {
    name: 'cli-reference',
    hooks: {
        'astro:config:setup': () => {
            const page = cliReference(readFileSync(new URL('../cli/README.md', import.meta.url), 'utf8'));
            if (!page.ok) {
                throw new Error(page.error);
            }
            writeFileSync(new URL('./src/content/docs/docs/reference/cli.md', import.meta.url), page.value);
        },
    },
};

export default defineConfig({
    site: 'https://openupstream.com',
    integrations: [
        cliReferencePage,
        starlight({
            title: 'openupstream',
            description: 'Open source cloud infrastructure, hosted in the EU: Postgres, object storage, static sites and containers.',
            social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/openupstream/openupstream' }],
            editLink: { baseUrl: 'https://github.com/openupstream/openupstream/edit/main/website/' },
            plugins: [starlightLinksValidator(), starlightLlmsTxt()],
            sidebar: [
                {
                    label: 'Products',
                    items: [
                        { label: 'Postgres', slug: 'postgres' },
                        { label: 'Object storage', slug: 'object-storage' },
                        { label: 'Static sites', slug: 'static-sites' },
                        { label: 'Containers', slug: 'containers' },
                    ],
                },
                {
                    label: 'Start here',
                    items: [
                        { label: 'Overview', slug: 'docs' },
                        { label: 'Getting started', slug: 'docs/getting-started' },
                        { label: 'Accounts, Projects and Sites', slug: 'docs/concepts' },
                    ],
                },
                {
                    label: 'Guides',
                    items: [
                        { label: 'Databases', slug: 'docs/databases' },
                        { label: 'Buckets', slug: 'docs/buckets' },
                        { label: 'Static sites', slug: 'docs/static-sites' },
                        { label: 'Services', slug: 'docs/services' },
                        { label: 'Jobs', slug: 'docs/jobs' },
                        { label: 'Domains and Routes', slug: 'docs/domains' },
                        { label: 'Secrets', slug: 'docs/secrets' },
                        { label: 'Logs', slug: 'docs/logs' },
                        { label: 'Usage and billing', slug: 'docs/billing' },
                    ],
                },
                {
                    label: 'Reference',
                    items: [
                        { label: 'oup command line', slug: 'docs/reference/cli' },
                        { label: 'TypeScript SDK', slug: 'docs/reference/sdk' },
                        { label: 'Running it yourself', slug: 'docs/self-hosting' },
                    ],
                },
            ],
        }),
    ],
});
