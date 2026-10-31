/**
 * The TXT lookup behind a custom domain's ownership proof (ARCHITECTURE.md,
 * "Routing and domains"), through the cluster's resolver.
 */
import { Resolver } from 'node:dns/promises';
import { type Result, err, ok } from '../result.js';

/** The name's TXT records, each one's strings joined; none when the name or its TXT records do not exist. */
export type TxtLookup = (name: string) => Promise<Result<string[], string>>;

/** What the resolver answers for a name without TXT records; anything else is an outage. */
const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA']);

/** Short, since the verify request waits for it: a slow answer is retried by the Account, not by us. */
export const txtLookup = (resolver: Resolver = new Resolver({ timeout: 2000, tries: 2 })): TxtLookup => (name) =>
    resolver.resolveTxt(name).then(
        (records) => ok(records.map((strings) => strings.join(''))),
        (error: NodeJS.ErrnoException) => (NO_RECORDS.has(error.code ?? '') ? ok([]) : err(error.code ?? String(error))),
    );
