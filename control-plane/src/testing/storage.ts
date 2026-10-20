/** Garage as the tests see it: buckets by name, keys with their secrets, in memory. */
import type { GarageBucket, ObjectStorage } from '../garage.js';
import { err, ok } from '../result.js';

export interface FakeStorage extends ObjectStorage {
    /** Live buckets: alias → ids and object count. */
    readonly buckets: Map<string, GarageBucket & { objects: number }>;
    /** Keys deleted. */
    readonly deletedKeys: string[];
    /** Every call, e.g. `create shop-assets`. */
    readonly calls: string[];
    /** Make every call fail, as when Garage is down. */
    down: boolean;
}

export function fakeStorage(): FakeStorage {
    let next = 0;
    const findById = (bucketId: string) => [...fake.buckets].find(([, bucket]) => bucket.bucketId === bucketId);
    const fake: FakeStorage = {
        buckets: new Map(),
        deletedKeys: [],
        calls: [],
        down: false,
        createBucket: async (name) => {
            fake.calls.push(`create ${name}`);
            if (fake.down) return err({ kind: 'unavailable', reason: 'Garage unreachable' });
            if (fake.buckets.has(name)) return err({ kind: 'name-taken' });
            next += 1;
            const bucket = { bucketId: `b${next}`, accessKeyId: `GK${next}`, objects: 0 };
            fake.buckets.set(name, bucket);
            return ok({ bucketId: bucket.bucketId, accessKeyId: bucket.accessKeyId });
        },
        secretOf: async (accessKeyId) => {
            if (fake.down) return err('Garage unreachable');
            return ok(`secret-of-${accessKeyId}`);
        },
        deleteKey: async (accessKeyId) => {
            if (fake.down) return err('Garage unreachable');
            fake.deletedKeys.push(accessKeyId);
            return ok(undefined);
        },
        deleteBucket: async ({ bucketId }) => {
            fake.calls.push(`delete ${bucketId}`);
            if (fake.down) return err('Garage unreachable');
            const found = findById(bucketId);
            if (found === undefined) return ok(0);
            fake.buckets.delete(found[0]);
            return ok(found[1].objects);
        },
    };
    return fake;
}
