import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliPage } from '../../components/cli';
import { docsSection, parseDocs } from '../../lib/docs';

/**
 * `/cli`: how to use `oup`. The text is the CLI's README, read here when
 * the dashboard is built (it runs in `dashboard/`), so the two cannot differ.
 */
export default function Cli() {
    const section = docsSection(readFileSync(join(process.cwd(), '..', 'cli', 'README.md'), 'utf8'));
    if (section === undefined) {
        // Fails the build: a page without its text must not ship.
        throw new Error('cli/README.md has no part between the docs markers');
    }
    return <CliPage blocks={parseDocs(section)} />;
}
