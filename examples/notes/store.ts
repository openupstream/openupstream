/** The notes in Postgres, through the Project's Pooler (DATABASE_URL). */
import pg from 'pg';
import type { Note, NotesStore } from './notes.js';

const SCHEMA = `create table if not exists notes (
    id bigint generated always as identity primary key,
    body text not null check (length(body) <= 1000),
    created_at timestamptz not null default now()
)`;

interface Row {
    id: string;
    body: string;
    created_at: Date;
}

const toNote = (row: Row): Note => ({ id: row.id, body: row.body, createdAt: row.created_at.toISOString() });

/** Any number shared by every replica: they create the table one at a time. */
const SCHEMA_LOCK = 4_242_001;

/**
 * Creates the table once; replicas that start together would otherwise race
 * in `create table if not exists`. A transaction-level lock, since PgBouncer
 * in transaction mode gives no session to hold one across statements.
 */
async function migrate(pool: pg.Pool): Promise<void> {
    const client = await pool.connect();
    await client
        .query('begin')
        .then(() => client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK]))
        .then(() => client.query(SCHEMA))
        .then(() => client.query('commit'))
        .finally(() => client.release());
}

export async function postgresStore(pool: pg.Pool): Promise<NotesStore> {
    await migrate(pool);
    return {
        list: async (limit) =>
            (await pool.query<Row>('select id, body, created_at from notes order by id desc limit $1', [limit])).rows.map(toNote),
        add: async (body) => {
            const { rows } = await pool.query<Row>('insert into notes (body) values ($1) returning id, body, created_at', [body]);
            return toNote(rows[0] as Row);
        },
        ping: () => pool.query('select 1').then(
            () => true,
            () => false,
        ),
    };
}
