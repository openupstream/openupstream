/** Postgres errors the API answers with something other than a 500. */
import pg from 'pg';
import { type Result, err, ok } from '../result.js';

export const UNIQUE_VIOLATION = '23505';

/** Also raised by the triggers that refuse a Resource in a deleted Project (migrations). */
export const FOREIGN_KEY_VIOLATION = '23503';

/** Raised when a Resource is inserted for an Account with a Hold (migrations, account-holds). */
export const ACCOUNT_HELD = 'OUHLD';

/**
 * The query's result, or the answer listed for the error code it failed
 * with. Any other error still rejects: it is a bug or an outage, not an
 * answer.
 */
export const unlessCodes = <T, E>(query: Promise<T>, answers: Readonly<Record<string, E>>): Promise<Result<T, E>> =>
    query.then(
        (value) => ok(value),
        (error: unknown) =>
            error instanceof pg.DatabaseError && error.code !== undefined && Object.hasOwn(answers, error.code)
                ? err(answers[error.code] as E)
                : Promise.reject(error),
    );

/** The query's result, or `onConflict` when it broke a unique constraint. */
export const unlessUnique = <T, E>(query: Promise<T>, onConflict: E): Promise<Result<T, E>> =>
    unlessCodes(query, { [UNIQUE_VIOLATION]: onConflict });
