#!/usr/bin/env node
/**
 * oup, the openupstream CLI.
 *
 * Planned commands (see ARCHITECTURE.md build order):
 *   oup login
 *   oup pg create|list|connect|backups
 *   oup bucket create|list|sync
 *   oup site create|deploy
 *   oup deploy          (build + run an HTTP service from the current dir)
 *   oup run <image>     (one-off job)
 *   oup cron ...
 *   oup routes ...
 *   oup secrets ...
 *   oup usage
 */
import { SDK_VERSION } from '@openupstream/sdk';

const [, , command] = process.argv;

switch (command) {
    case 'version':
    case '--version':
    case '-v':
        console.log(`oup ${SDK_VERSION}`);
        break;
    default:
        console.log('oup: nothing here yet. See https://github.com/openupstream/openupstream');
        process.exitCode = command ? 1 : 0;
}
