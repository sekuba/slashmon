import assert from 'node:assert/strict';
import test from 'node:test';

import { CaseApiServer } from '../src/case-api-server.mjs';
import { CaseRepository } from '../src/case-repository.mjs';
import { SEQUENCER_A, SEQUENCER_B, silentLogger } from './helpers.mjs';
import {
  REGISTRY,
  protocolSnapshot,
  targetRound,
} from './case-fixtures.mjs';

test('API exposes current cases and capability-authenticated watches only', async (t) => {
  const apiLogs = [];
  const repository = new CaseRepository(':memory:');
  repository.bindRuntimeIdentity({
    network: 'mainnet',
    chainId: 1,
    registryAddress: REGISTRY,
  });
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    rounds: [targetRound({ sequencer: SEQUENCER_A, targetEpoch: '24' })],
  }), { observedAt: 1_700_000_200_000 });
  repository.recordSourceSuccess('aztec_node', {}, 1_700_000_200_000);
  repository.recordSourceSuccess('aztec_sentinel', {}, 1_700_000_200_000);
  repository.recordSourceSuccess('l1_slash_logs', {}, 1_700_000_200_000);

  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    maxSequencers: 2,
    logger: {
      debug(message, data) {
        apiLogs.push({ level: 'debug', message, data });
      },
      error(message, data) {
        apiLogs.push({ level: 'error', message, data });
      },
    },
    now: () => 1_700_000_201_000,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  const status = await json(base, '/api/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.status, 'healthy');
  assert.deepEqual(
    status.body.sources.map((source) => source.source),
    ['ethereum_l1', 'aztec_node', 'aztec_sentinel'],
  );

  const config = await json(base, '/api/config');
  assert.equal(config.response.status, 200);
  assert.equal(config.body.network, 'mainnet');
  assert.equal('apiVersion' in config.body, false);

  const network = await json(base, '/api/network');
  assert.equal(network.body.cases.length, 1);
  assert.equal(network.body.cases[0].targetEpoch, '24');
  assert.equal(network.body.summary.candidates, 1);

  const created = await json(base, '/api/watches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      network: 'mainnet',
      addresses: [SEQUENCER_A],
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal('cases' in created.body.watch, false);

  const watched = await json(base, `/api/sequencers?addresses=${SEQUENCER_A},${SEQUENCER_A.toUpperCase().replace('0X', '0x')}`);
  assert.equal(watched.response.status, 200);
  assert.equal(watched.response.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(watched.body.cases.map((item) => item.targetEpoch), ['24']);
  assert.equal((await json(base, '/api/sequencers')).body.error.code, 'empty_addresses');
  assert.equal(
    (await json(base, `/api/sequencers?addresses=${SEQUENCER_A},${SEQUENCER_B},0x${'7'.repeat(40)}`))
      .body.error.code,
    'too_many_addresses',
  );
  assert.match(created.body.managementToken, /^[A-Za-z0-9_-]+$/);

  const watchPath = `/api/watches/${created.body.watch.id}`;
  assert.equal((await json(base, watchPath)).response.status, 401);
  const updated = await json(base, watchPath, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${created.body.managementToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ addresses: [SEQUENCER_A, SEQUENCER_B] }),
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.body.addresses, [SEQUENCER_A, SEQUENCER_B]);
  assert.equal(updated.response.headers.get('access-control-allow-origin'), 'https://slashveto.example');

  const versionedApi = await json(base, '/api/v3/network');
  assert.equal(versionedApi.response.status, 404);
  assert.equal(versionedApi.body.error.code, 'not_found');
  assert.deepEqual(apiLogs.at(-1), {
    level: 'debug',
    message: 'API request rejected',
    data: {
      method: 'GET',
      path: '/api/v3/network',
      status: 404,
      code: 'not_found',
      error: 'Route not found',
    },
  });
});

test('API links an encoded case id without an event-feed lookup', async (t) => {
  const repository = new CaseRepository(':memory:');
  repository.bindRuntimeIdentity({
    network: 'mainnet',
    chainId: 1,
    registryAddress: REGISTRY,
  });
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    rounds: [targetRound({ sequencer: SEQUENCER_A, targetEpoch: '24' })],
  }));
  const [item] = repository.listCases({ network: 'mainnet' });
  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    logger: silentLogger,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  const found = await json(base, `/api/cases/${encodeURIComponent(item.id)}`);
  assert.equal(found.response.status, 200);
  assert.equal(found.body.id, item.id);
  assert.ok(found.body.transitions.length >= 1);
});

test('API rate limits public traffic by the Cloudflare client address', async (t) => {
  const repository = new CaseRepository(':memory:');
  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    requestRateLimitMaxRequests: 2,
    trustLoopbackProxy: true,
    logger: silentLogger,
    now: () => 0,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  const firstClient = { headers: { 'cf-connecting-ip': '192.0.2.1' } };
  assert.equal((await json(base, '/api/config', firstClient)).response.status, 200);
  assert.equal((await json(base, '/api/config', firstClient)).response.status, 200);
  const limited = await json(base, '/api/config', firstClient);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '60');
  assert.equal(limited.body.error.code, 'rate_limited');

  assert.equal((await json(base, '/live', firstClient)).response.status, 200);
  assert.equal((await json(base, '/api/config', {
    headers: { 'cf-connecting-ip': '192.0.2.2' },
  })).response.status, 200);
});

test('API limits watch creation per client and across rotating clients', async (t) => {
  let now = 0;
  const repository = new CaseRepository(':memory:');
  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    requestRateLimitMaxRequests: 100,
    rateLimitMaxMutations: 100,
    watchCreationRateLimitMaxPerClient: 2,
    watchCreationRateLimitMaxGlobal: 3,
    trustLoopbackProxy: true,
    logger: silentLogger,
    now: () => now,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  assert.equal((await createWatch(base, '192.0.2.1')).response.status, 201);
  assert.equal((await createWatch(base, '192.0.2.1')).response.status, 201);
  const clientLimited = await createWatch(base, '192.0.2.1');
  assert.equal(clientLimited.response.status, 429);
  assert.equal(clientLimited.response.headers.get('retry-after'), '3600');
  assert.equal(clientLimited.body.error.code, 'rate_limited');

  assert.equal((await createWatch(base, '192.0.2.2')).response.status, 201);
  const globallyLimited = await createWatch(base, '192.0.2.3');
  assert.equal(globallyLimited.response.status, 429);
  assert.equal(globallyLimited.response.headers.get('retry-after'), '3600');
  assert.equal(globallyLimited.body.error.code, 'rate_limited');

  now = 60 * 60_000;
  assert.equal((await createWatch(base, '192.0.2.3')).response.status, 201);
});

test('API keeps a separate per-client mutation limit', async (t) => {
  const repository = new CaseRepository(':memory:');
  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    requestRateLimitMaxRequests: 100,
    rateLimitMaxMutations: 1,
    watchCreationRateLimitMaxPerClient: 10,
    watchCreationRateLimitMaxGlobal: 10,
    trustLoopbackProxy: true,
    logger: silentLogger,
    now: () => 0,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  const created = await createWatch(base, '192.0.2.1');
  assert.equal(created.response.status, 201);
  const limited = await json(base, `/api/watches/${created.body.watch.id}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${created.body.managementToken}`,
      'cf-connecting-ip': '192.0.2.1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ addresses: [SEQUENCER_B] }),
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
});

function createWatch(base, clientAddress) {
  return json(base, '/api/watches', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': clientAddress,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      network: 'mainnet',
      addresses: [SEQUENCER_A],
    }),
  });
}

async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

test('network feed is compact, revalidatable, and gzip-encoded at the origin', async (t) => {
  const repository = new CaseRepository(':memory:');
  repository.bindRuntimeIdentity({
    network: 'mainnet',
    chainId: 1,
    registryAddress: REGISTRY,
  });
  const rounds = ['11', '12', '13', '14'].map((round, index) =>
    targetRound({
      sequencer: index % 2 === 0 ? SEQUENCER_A : SEQUENCER_B,
      targetEpoch: String(20 + index),
      round,
    }));
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({ rounds }));
  let clock = 1_700_000_000_000;
  const api = new CaseApiServer({
    repository,
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'https://slashveto.example',
    network: 'mainnet',
    logger: silentLogger,
    now: () => clock,
  });
  const address = await api.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await api.close();
    repository.close();
  });

  const network = await json(base, '/api/network');
  assert.deepEqual(Object.keys(network.body).sort(), ['cases', 'summary']);
  assert.equal(network.body.cases.length, 4);
  assert.equal(network.response.headers.get('cache-control'), 'no-cache');
  assert.equal(network.response.headers.get('content-encoding'), 'gzip');
  const etag = network.response.headers.get('etag');
  assert.match(etag, /^W\/"/);

  const revalidated = await fetch(`${base}/api/network`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('etag'), etag);
  assert.equal(await revalidated.text(), '');

  // The body is built once per case change and retention hour.
  const cached = api.networkBody();
  assert.equal(api.networkBody(), cached);
  clock += 60 * 60_000;
  const nextHour = api.networkBody();
  assert.notEqual(nextHour, cached);
  assert.equal(nextHour.etag, cached.etag);

  const grown = structuredClone(rounds);
  grown[0].ballotCount = '3';
  grown[0].actionDetails[0].voteCount = 3;
  grown[0].actionDetails[0].support = 3;
  grown[0].actionDetails[0].unitVoteCounts = [3, 0, 0];
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 101,
    rounds: grown,
  }));
  const changed = await fetch(`${base}/api/network`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.notEqual(api.networkBody(), nextHour);

  const status = await json(base, '/api/status');
  assert.equal(status.response.headers.get('cache-control'), 'no-store');
});
