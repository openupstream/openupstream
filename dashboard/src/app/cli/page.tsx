import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliPage } from '../../components/cli';
import { docsSection, nodeVersion, parseDocs } from '../../lib/docs';

/**
 * `/cli`: how to use `oup`. The text is the CLI's README and the Node.js
 * version its package.json's, read here when the dashboard is built (it
 * runs in `dashboard/`), so they cannot differ.
 */
export default function Cli() {
    const engines: unknown = (JSON.parse(readFileSync(join(process.cwd(), '..', 'cli', 'package.json'), 'utf8')) as { engines?: { node?: unknown } }).engines?.node;
    if (typeof engines !== 'string') {
        throw new Error('cli/package.json names no Node.js version');
    }
    const section = docsSection(readFileSync(join(process.cwd(), '..', 'cli', 'README.md'), 'utf8'));
    if (section === undefined) {
        // Fails the build: a page without its text must not ship.
        throw new Error('cli/README.md has no part between the docs markers');
    }
    return <CliPage blocks={parseDocs(section)} node={nodeVersion(engines)} />;
}
