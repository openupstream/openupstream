/** Postgres errors the API answers with something other than a 500. */
import pg from 'pg';
import { type Result, err, ok } from '../result.js';

export const UNIQUE_VIOLATION = '23505';

/**
 * The query's result, or `onConflict` when it broke a unique constraint.
 * Any other error still rejects: it is a bug or an outage, not an answer.
 */
export const unlessUnique = <T, E>(query: Promise<T>, onConflict: E): Promise<Result<T, E>> =>
    query.then(
        (value) => ok(value),
        (error: unknown) =>
            error instanceof pg.DatabaseError && error.code === UNIQUE_VIOLATION
                ? err(onConflict)
                : Promise.reject(error),
    );
