import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEW_SERVICE, fieldsOf, serviceInput, serviceNameProblem, servicePatch, serviceWanted, shortDigest } from './services';

const fields = { ...NEW_SERVICE, image: ' ghcr.io/acme/api:v3 ' };
const wanted = { image: 'ghcr.io/acme/api:v3', port: 8080, replicas: 1, memoryMb: 256, cpuMillicores: 250, homeSite: null } as const;

test('a Service form: whole numbers within the limits, an empty port for a worker, no Site for no choice', () => {
    assert.deepEqual(serviceWanted(fields), wanted);
    assert.deepEqual(serviceWanted({ ...fields, port: ' ', homeSite: 'ovh-lim', replicas: '10' }), { ...wanted, port: null, homeSite: 'ovh-lim', replicas: 10 });
    for (const wrong of [{ image: '' }, { image: 'a b' }, { port: '0' }, { port: '65536' }, { port: 'http' }, { replicas: '0' }, { replicas: '11' }, { memoryMb: '63' }, { memoryMb: '1.5' }, { cpuMillicores: '49' }, { cpuMillicores: '8001' }, { homeSite: 'not a site' }]) {
        assert.equal(typeof serviceWanted({ ...fields, ...wrong }), 'string', JSON.stringify(wrong));
    }
});

test('a Service name is a DNS label the Project does not have yet', () => {
    assert.equal(serviceNameProblem('api', [{ name: 'web' }]), undefined);
    assert.match(serviceNameProblem('', []) ?? '', /Enter a name/);
    assert.match(serviceNameProblem('Api', []) ?? '', /Lowercase/);
    assert.match(serviceNameProblem('api', [{ name: 'api' }]) ?? '', /exists/);
});

test('a new Service leaves out the port of a worker and a Site not chosen', () => {
    assert.deepEqual(serviceInput('api', wanted), { name: 'api', image: wanted.image, port: 8080, replicas: 1, memoryMb: 256, cpuMillicores: 250 });
    assert.deepEqual(serviceInput('job', { ...wanted, port: null, homeSite: 'ovh-lim' }), { name: 'job', image: wanted.image, replicas: 1, memoryMb: 256, cpuMillicores: 250, homeSite: 'ovh-lim' });
});

test('a change sends only what differs, null to take the port or the Site away, and says when nothing differs', () => {
    const service = { ...wanted, homeSite: 'ovh-lim' } as const;
    assert.deepEqual(serviceWanted(fieldsOf(service)), service);
    assert.match(String(servicePatch(service, service)), /Nothing is changed/);
    assert.deepEqual(servicePatch(service, { ...service, replicas: 2, memoryMb: 512 }), { replicas: 2, memoryMb: 512 });
    assert.deepEqual(servicePatch(service, { ...service, port: null, homeSite: null, image: 'ghcr.io/acme/api:v4' }), { image: 'ghcr.io/acme/api:v4', port: null, homeSite: null });
});

test('a digest short enough to read', () => {
    assert.equal(shortDigest('sha256:3fb9aafb2dd99225bd36830c8a866981be758a48bbe5f0828c0b2f1353ffd585'), '3fb9aafb2dd9');
});
