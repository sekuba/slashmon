import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

import { L1Scanner, deduplicateStacks } from '../src/l1-scanner.mjs';
import { roundExecutedEvent } from '../src/l1-abis.mjs';
import { protocolFromL1Snapshot } from '../src/observations.mjs';

const REGISTRY = '0x35b22e09Ee0390539439E24f06Da43D83f90e298';
const ROLLUP = '0x1000000000000000000000000000000000000001';
const SECOND_ROLLUP = '0x1000000000000000000000000000000000000002';
const SLASHER = '0x2000000000000000000000000000000000000002';
const PROPOSER = '0x3000000000000000000000000000000000000003';
const PENDING_SLASHER = '0x4000000000000000000000000000000000000004';
const TARGET = '0x5000000000000000000000000000000000000005';
const PAYLOAD = '0x6000000000000000000000000000000000000006';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

test('L1Scanner rejects stale and implausibly future heads at configured boundaries', () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    maxHeadAgeMs: 1_000,
    maxFutureSkewMs: 1_000,
    now: () => 1_000_000,
  });

  assert.doesNotThrow(() => scanner.assertFreshTimestamp(999n));
  assert.doesNotThrow(() => scanner.assertFreshTimestamp(1_001n));
  assert.throws(() => scanner.assertFreshTimestamp(998n), /L1 head is 2000ms old/);
  assert.throws(() => scanner.assertFreshTimestamp(1_002n), /L1 head timestamp is 2000ms in the future/);
});

test('L1Scanner rejects a repeated confirmed head after a missed-slot grace window', () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 1,
    maxHeadAgeMs: 15 * 60_000,
    maxHeadStallMs: 120_000,
    now: () => 1_000_000,
  });
  const previous = { lastBlockNumber: '100' };

  assert.doesNotThrow(() => scanner.assertHeadProgress(
    { number: 101n, timestamp: 880n },
    previous,
    100n,
  ));
  assert.throws(() => scanner.assertHeadProgress(
    { number: 101n, timestamp: 879n },
    previous,
    100n,
  ), /confirmed head 100 has not advanced for 121000ms/);
  assert.doesNotThrow(() => scanner.assertHeadProgress(
    { number: 101n, timestamp: 800n },
    { lastBlockNumber: '99' },
    100n,
  ), 'an advancing head is not confused with a provider stall');
});

test('deduplicateStacks keeps an authorized legacy role when that Slasher is also pending', () => {
  assert.deepEqual(deduplicateStacks([
    { role: 'active', slasherAddress: SLASHER },
    { role: 'pending', slasherAddress: PENDING_SLASHER, readyAt: '1200' },
    { role: 'legacy', slasherAddress: PENDING_SLASHER, authorizedUntil: '1100' },
  ]), [
    { role: 'active', slasherAddress: SLASHER },
    {
      role: 'legacy',
      slasherAddress: PENDING_SLASHER,
      readyAt: '1200',
      authorizedUntil: '1100',
    },
  ]);
});

test('scanWithClient publishes one coherent pinned-block snapshot', async () => {
  const scanner = createScanner();
  const client = fakeL1Client();

  const snapshot = await scanner.scanWithClient(client);

  assert.equal(snapshot.blockNumber, '100');
  assert.equal(snapshot.blockHash, BLOCK_HASH);
  assert.equal(snapshot.rollupAddress, ROLLUP);
  assert.equal(snapshot.l1GenesisTime, '100');
  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.stacks.length, 1);
  assert.equal(snapshot.stacks[0].role, 'active');
  assert.equal(snapshot.stacks[0].proposerAddress, PROPOSER);
  assert.deepEqual(snapshot.stackErrors, []);
  assert.equal(client.confirmedBlockReads(), 2, 'the pinned block is re-read after every contract call');
  assert.deepEqual(snapshot.staking, {
    activationThreshold: '200',
    localEjectionThreshold: '190',
    exitDelay: '4',
  });
  assert.deepEqual(snapshot.stacks[0].parameters.slashAmounts, ['2', '5', '5']);

  const protocol = protocolFromL1Snapshot('mainnet', snapshot, null);
  assert.deepEqual(protocol.staking, {
    activationThreshold: '200',
    localEjectionThreshold: '190',
    exitDelaySeconds: 4,
  });
  assert.deepEqual(protocol.lineages[0].parameters.slashAmounts, ['2', '5', '5']);
});

test('scanWithClient publishes no stake rules when the deployment lacks their getters', async () => {
  const snapshot = await createScanner().scanWithClient(fakeL1Client({ stakeRules: false }));

  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.staking, null);
  assert.equal(snapshot.stacks[0].parameters.slashAmounts, null);
  const protocol = protocolFromL1Snapshot('mainnet', snapshot, null);
  assert.equal(protocol.staking, null);
  assert.equal(protocol.lineages[0].parameters.slashAmounts, null);
});

test('scanWithClient rejects a block replaced while its snapshot is being assembled', async () => {
  const replacementHash = `0x${'cd'.repeat(32)}`;
  await assert.rejects(
    createScanner().scanWithClient(fakeL1Client({ replacementHash })),
    /confirmed L1 block 100 changed during snapshot/,
  );
});

test('epoch committee lookup is pinned to the accepted confirmed L1 block', async () => {
  const scanner = createScanner();
  let blockReads = 0;
  const client = {
    async getChainId() {
      return 1;
    },
    async getBlock({ blockNumber }) {
      assert.equal(blockNumber, 100n);
      blockReads += 1;
      return { number: blockNumber, hash: BLOCK_HASH, timestamp: 988n };
    },
    async getBytecode({ address, blockNumber }) {
      assert.equal(address, ROLLUP);
      assert.equal(blockNumber, 100n);
      return '0x01';
    },
    async readContract({ address, functionName, args, blockNumber }) {
      assert.equal(address, ROLLUP);
      assert.equal(functionName, 'getEpochCommittee');
      assert.deepEqual(args, [42n]);
      assert.equal(blockNumber, 100n);
      return [TARGET, PROPOSER];
    },
  };

  assert.deepEqual(await scanner.getEpochCommitteeWithClient(client, {
    epoch: '42',
    rollupAddress: ROLLUP,
    blockNumber: '100',
    blockHash: BLOCK_HASH,
  }), {
    epoch: '42',
    committee: [TARGET.toLowerCase(), PROPOSER.toLowerCase()],
    rollupAddress: ROLLUP.toLowerCase(),
    blockNumber: '100',
    blockHash: BLOCK_HASH,
  });
  assert.equal(blockReads, 2);
});

test('scanWithClient isolates a broken pending stack and marks source coverage degraded', async () => {
  const snapshot = await createScanner().scanWithClient(fakeL1Client({ brokenPendingStack: true }));

  assert.equal(snapshot.stacks.length, 1);
  assert.equal(snapshot.stacks[0].role, 'active');
  assert.equal(snapshot.degraded, true);
  assert.deepEqual(snapshot.stackErrors.map(({ role, slasherAddress }) => ({ role, slasherAddress })), [
    { role: 'pending', slasherAddress: PENDING_SLASHER },
  ]);
  assert.match(snapshot.stackErrors[0].error, /no contract code at pending Slasher/);
});

test('scanWithClient distinguishes pause protection from a round that survives resume', async () => {
  const protectedSnapshot = await createScanner().scanWithClient(fakeL1Client({ pausedExecutableRound: 'protected' }));
  const protectedRound = protectedSnapshot.stacks[0].rounds[0];
  assert.equal(protectedRound.status, 'newly-executable');
  assert.equal(protectedRound.isExecutionPaused, true);
  assert.equal(protectedRound.isProtected, true);
  assert.equal(protectedSnapshot.stacks[0].pauseEndsAtSlot, '80');

  const survivingSnapshot = await createScanner().scanWithClient(fakeL1Client({ pausedExecutableRound: 'survives' }));
  const survivingRound = survivingSnapshot.stacks[0].rounds[0];
  assert.equal(survivingRound.isExecutionPaused, true);
  assert.equal(survivingRound.isProtected, false);
  assert.equal(survivingSnapshot.stacks[0].pauseEndsAtSlot, '75');
});

test('confirmed Slashed log scan uses bounded chunks and Registry-resolved historical emitters', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 25,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });
  const client = fakeSlashLogClient();

  const first = await scanner.scanSlashLogChunkWithClient(client);
  assert.equal(first.fromBlock, '76');
  assert.equal(first.toBlock, '85');
  assert.equal(first.hasMore, true);
  assert.equal(first.initialBackfill, true);
  assert.deepEqual(first.rollupAddresses, [ROLLUP.toLowerCase(), SECOND_ROLLUP.toLowerCase()]);
  assert.deepEqual(first.logs.map((log) => [log.blockNumber, log.rollupAddress, log.sequencer, log.amount]), [
    ['78', ROLLUP.toLowerCase(), TARGET.toLowerCase(), '10'],
    ['84', SECOND_ROLLUP.toLowerCase(), TARGET.toLowerCase(), '20'],
  ]);
  assert.deepEqual(first.logs.map((log) => log.executionContext), [
    historicalExecutionContext({ amount: '10' }),
    historicalExecutionContext({ amount: '20' }),
  ]);
  assert.deepEqual(
    first.logs.map((log) => [log.blockTimestamp, log.stakeAfter, log.ejectionThreshold]),
    [['1000', '188', '190'], ['1000', '188', '190']],
    'each slash carries its block time and what it left of the stake',
  );

  const second = await scanner.scanSlashLogChunkWithClient(client, {
    lastBlockNumber: first.toBlock,
    lastBlockHash: first.toBlockHash,
    metadata: {
      rollupAddresses: first.rollupAddresses,
      initialBackfill: true,
    },
  });
  assert.equal(second.fromBlock, '84', 'the overlap is rescanned deliberately');
  assert.equal(second.toBlock, '93', 'the range remains bounded to one chunk');
  assert.equal(second.initialBackfill, true);
});

test('readSlashFacts reads recorded slashes and skips a block that changed', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 1,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
    clientFactory: () => fakeSlashLogClient(),
  });
  const slash = {
    id: 'slash',
    blockNumber: '78',
    blockHash: blockHash(78n),
    rollupAddress: ROLLUP,
    sequencer: TARGET,
  };

  assert.deepEqual(await scanner.readSlashFacts([
    slash,
    { ...slash, id: 'orphaned', blockHash: blockHash(79n) },
  ]), [{
    id: 'slash',
    blockTimestamp: '1000',
    stakeAfter: '188',
    ejectionThreshold: '190',
  }]);
});

test('historical execution reconstruction separates repeated sequencers by action and epoch', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 10,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });

  const result = await scanner.scanSlashLogChunkWithClient(
    fakeSlashLogClient({ repeatedSequencer: true }),
  );
  assert.deepEqual(result.logs.map((log) => ({
    logIndex: log.logIndex,
    transactionSlashIndex: log.transactionSlashIndex,
    targetEpoch: log.executionContext.targetEpoch,
    actionIndex: log.executionContext.actionIndex,
    requestedAmount: log.executionContext.amount,
    actualAmount: log.amount,
  })), [
    {
      logIndex: 151,
      transactionSlashIndex: 0,
      targetEpoch: '12',
      actionIndex: 0,
      requestedAmount: '100',
      actualAmount: '90',
    },
    {
      logIndex: 152,
      transactionSlashIndex: 1,
      targetEpoch: '13',
      actionIndex: 1,
      requestedAmount: '300',
      actualAmount: '250',
    },
  ]);
});

test('an exact log start block re-anchors an existing durable cursor', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogStartBlock: 20,
    slashLogLookbackBlocks: 5,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });
  const client = fakeSlashLogClient();

  const restarted = await scanner.scanSlashLogChunkWithClient(client, {
    lastBlockNumber: '90',
    lastBlockHash: blockHash(90n),
    metadata: { initialBackfill: false },
  });
  assert.equal(restarted.fromBlock, '20');
  assert.equal(restarted.toBlock, '29');
  assert.equal(restarted.initial, true);
  assert.equal(restarted.initialBackfill, true);
  assert.equal(restarted.backfillStartBlock, '20');

  const continued = await scanner.scanSlashLogChunkWithClient(client, {
    lastBlockNumber: restarted.toBlock,
    lastBlockHash: restarted.toBlockHash,
    metadata: {
      initialBackfill: true,
      backfillStartBlock: restarted.backfillStartBlock,
    },
  });
  assert.equal(continued.fromBlock, '28');
  assert.equal(continued.toBlock, '37');
  assert.equal(continued.initial, false);
  assert.equal(continued.initialBackfill, true);
});

test('an exact log start block cannot silently skip a future range', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogStartBlock: 101,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });

  await assert.rejects(
    scanner.scanSlashLogChunkWithClient(fakeSlashLogClient()),
    /start block 101 is above confirmed L1 head 100/,
  );
});

test('confirmed Slashed log scan rewinds a mismatched persisted checkpoint', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 25,
    slashLogChunkSize: 30,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });

  const result = await scanner.scanSlashLogChunkWithClient(fakeSlashLogClient({ headNumber: 110n }), {
    lastBlockNumber: '100',
    lastBlockHash: `0x${'ff'.repeat(32)}`,
    metadata: { rollupAddresses: [SECOND_ROLLUP] },
  });
  assert.equal(result.reorgDetected, true);
  assert.equal(result.fromBlock, '81');
  assert.equal(result.toBlock, '110');
});

test('confirmed Slashed log ranges never trust an emitter carried only in old metadata', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 25,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });

  const result = await scanner.scanSlashLogChunkWithClient(fakeSlashLogClient(), {
    lastBlockNumber: '85',
    lastBlockHash: blockHash(85n),
    metadata: { rollupAddresses: [PENDING_SLASHER] },
  });

  assert.deepEqual(result.rollupAddresses, [SECOND_ROLLUP.toLowerCase()]);
  assert.equal(result.logs.every((log) => log.rollupAddress === SECOND_ROLLUP.toLowerCase()), true);
});

test('confirmed Slashed log scan refuses to checkpoint a range whose tip changes mid-scan', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 10,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });
  await assert.rejects(
    scanner.scanSlashLogChunkWithClient(fakeSlashLogClient({ replaceCheckpoint: true })),
    /confirmed L1 log checkpoint 100 changed during scan/,
  );
});

test('initial Slashed log backfill checkpoints empty ranges before Registry deployment', async () => {
  const scanner = new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 100,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
  });

  const result = await scanner.scanSlashLogChunkWithClient(fakeSlashLogClient({ registryDeploymentBlock: 50n }));
  assert.equal(result.fromBlock, '1');
  assert.equal(result.toBlock, '10');
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.rollupAddresses, []);
  assert.deepEqual(result.logs, []);
});

test('Slashed log scanning gives a hanging RPC a bounded slice before failover', async () => {
  const attempts = [];
  const scanner = new L1Scanner({
    rpcUrls: ['https://slow.example', 'https://healthy.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 10,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    slashLogProviderTimeoutMs: 20,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
    clientFactory(_url, signal, providerIndex) {
      attempts.push(providerIndex);
      return providerIndex === 0
        ? { getChainId: () => rejectWhenAborted(signal) }
        : fakeSlashLogClient();
    },
  });

  const result = await scanner.scanSlashLogChunk();
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(result.toBlock, '100');
  assert.equal(scanner.nextLogProviderIndex, 1);
});

test('a global backfill deadline rotates the next poll away from the hanging RPC', async () => {
  const controller = new AbortController();
  const scanner = new L1Scanner({
    rpcUrls: ['https://slow.example', 'https://healthy.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 0,
    slashLogLookbackBlocks: 10,
    slashLogChunkSize: 10,
    slashLogOverlapBlocks: 2,
    slashLogReorgRewindBlocks: 20,
    slashLogProviderTimeoutMs: 10_000,
    maxHeadAgeMs: 60_000,
    now: () => 1_000_000,
    clientFactory(_url, signal) {
      return { getChainId: () => rejectWhenAborted(signal) };
    },
  });
  setTimeout(() => controller.abort(new Error('backfill budget elapsed')), 10);

  await assert.rejects(scanner.scanSlashLogChunk({}, controller.signal), /backfill budget elapsed/);
  assert.equal(scanner.nextLogProviderIndex, 1);
});

function createScanner() {
  return new L1Scanner({
    rpcUrls: ['https://rpc.example'],
    chainId: 1,
    registryAddress: REGISTRY,
    confirmations: 1,
    maxHeadAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    now: () => 1_000_000,
  });
}

function fakeL1Client({
  replacementHash,
  brokenPendingStack = false,
  pausedExecutableRound = null,
  stakeRules = true,
} = {}) {
  let confirmedBlockReads = 0;
  const head = {
    number: 101n,
    hash: `0x${'ef'.repeat(32)}`,
    timestamp: 1_000n,
  };
  const confirmed = {
    number: 100n,
    hash: BLOCK_HASH,
    timestamp: 988n,
  };
  return {
    confirmedBlockReads: () => confirmedBlockReads,
    async getChainId() {
      return 1;
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'latest') return head;
      assert.equal(blockNumber, 100n);
      confirmedBlockReads += 1;
      return confirmedBlockReads > 1 && replacementHash
        ? { ...confirmed, hash: replacementHash }
        : confirmed;
    },
    async getBytecode({ address }) {
      if (brokenPendingStack && address.toLowerCase() === PENDING_SLASHER.toLowerCase()) return '0x';
      return '0x01';
    },
    async readContract({ address, functionName, args = [] }) {
      const normalized = address.toLowerCase();
      if (normalized === REGISTRY.toLowerCase() && functionName === 'getCanonicalRollup') return ROLLUP;
      if (normalized === ROLLUP.toLowerCase()) {
        if (functionName === 'getSlotAt') {
          return args[0] === 950n ? 50n : pausedExecutableRound === 'protected' ? 80n : 75n;
        }
        return {
          getVersion: 2n,
          getSlasher: SLASHER,
          getPendingSlasher: brokenPendingStack ? [PENDING_SLASHER, 1_100n] : [`0x${'00'.repeat(20)}`, 0n],
          getLegacySlasher: [`0x${'00'.repeat(20)}`, 0n],
          getCurrentSlot: pausedExecutableRound ? 70n : 0n,
          getCurrentEpoch: 0n,
          getGenesisTime: 100n,
          getEscapeHatchForEpoch: `0x${'00'.repeat(20)}`,
          getSlotDuration: 12n,
          getEpochDuration: 32n,
          ...(stakeRules
            ? { getActivationThreshold: 200n, getLocalEjectionThreshold: 190n, getExitDelay: 4n }
            : {}),
        }[functionName];
      }
      if (normalized === SLASHER.toLowerCase()) {
        return {
          PROPOSER,
          isSlashingEnabled: !pausedExecutableRound,
          slashingDisabledUntil: pausedExecutableRound ? 1_050n : 0n,
          SLASHING_DISABLE_DURATION: pausedExecutableRound ? 100n : 300n,
          vetoedPayloads: false,
        }[functionName];
      }
      if (normalized === PROPOSER.toLowerCase()) {
        if (functionName === 'getRound') {
          return pausedExecutableRound && args[0] === 4n ? [false, 3n] : [false, 0n];
        }
        return {
          INSTANCE: ROLLUP,
          SLASHER,
          getCurrentRound: pausedExecutableRound ? 7n : 0n,
          QUORUM: 3n,
          ROUND_SIZE: 10n,
          ROUND_SIZE_IN_EPOCHS: 1n,
          EXECUTION_DELAY_IN_ROUNDS: 2n,
          LIFETIME_IN_ROUNDS: 3n,
          SLASH_OFFSET_IN_ROUNDS: 1n,
          COMMITTEE_SIZE: 4n,
          ...(stakeRules
            ? { SLASH_AMOUNT_SMALL: 2n, SLASH_AMOUNT_MEDIUM: 5n, SLASH_AMOUNT_LARGE: 5n }
            : {}),
          getSlashTargetCommittees: [[TARGET, PROPOSER, SLASHER, ROLLUP]],
          getVotes: '0x01',
          getTally: [{ validator: TARGET, slashAmount: 1_000n }],
          getPayloadAddress: PAYLOAD,
        }[functionName];
      }
      throw new Error(`Unexpected ${functionName} call to ${address}`);
    },
  };
}

function fakeSlashLogClient({
  headNumber = 100n,
  replaceCheckpoint = false,
  registryDeploymentBlock = 0n,
  repeatedSequencer = false,
} = {}) {
  let explicitHeadReads = 0;
  const updates = repeatedSequencer ? [] : [{
    address: REGISTRY,
    blockNumber: 83n,
    blockHash: blockHash(83n),
    transactionHash: transactionHash(83n),
    logIndex: 0,
    args: { instance: SECOND_ROLLUP, version: 2n },
  }];
  const slashes = repeatedSequencer ? [
    {
      address: ROLLUP,
      blockNumber: 98n,
      blockHash: blockHash(98n),
      transactionHash: transactionHash(98n),
      logIndex: 151,
      args: { attester: TARGET, amount: 90n },
    },
    {
      address: ROLLUP,
      blockNumber: 98n,
      blockHash: blockHash(98n),
      transactionHash: transactionHash(98n),
      logIndex: 152,
      args: { attester: TARGET, amount: 250n },
    },
  ] : [
    {
      address: ROLLUP,
      blockNumber: 78n,
      blockHash: blockHash(78n),
      transactionHash: transactionHash(78n),
      logIndex: 1,
      args: { attester: TARGET, amount: 10n },
    },
    {
      address: SECOND_ROLLUP,
      blockNumber: 84n,
      blockHash: blockHash(84n),
      transactionHash: transactionHash(84n),
      logIndex: 2,
      args: { attester: TARGET, amount: 20n },
    },
  ];
  return {
    async getChainId() {
      return 1;
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'latest') {
        return { number: headNumber, hash: blockHash(headNumber), timestamp: 1_000n };
      }
      if (blockNumber === headNumber) {
        explicitHeadReads += 1;
        if (replaceCheckpoint && explicitHeadReads > 0) {
          return { number: blockNumber, hash: `0x${'cd'.repeat(32)}`, timestamp: 1_000n };
        }
      }
      return { number: blockNumber, hash: blockHash(blockNumber), timestamp: 1_000n };
    },
    async getBytecode({ blockNumber }) {
      return blockNumber < registryDeploymentBlock ? '0x' : '0x01';
    },
    async readContract({ address, functionName, blockNumber }) {
      if (functionName === 'getStatus') return 2;
      if (functionName === 'getAttesterView') {
        return {
          status: 2,
          effectiveBalance: 0n,
          exit: { amount: 188n, exitableAt: 2_000n, isRecipient: false, exists: true },
        };
      }
      if (functionName === 'getLocalEjectionThreshold') return 190n;
      if (functionName === 'getCanonicalRollup') {
        return repeatedSequencer || blockNumber < 83n ? ROLLUP : SECOND_ROLLUP;
      }
      if (functionName === 'getEscapeHatchForEpoch') return `0x${'00'.repeat(20)}`;
      assert.equal(address.toLowerCase(), PROPOSER.toLowerCase());
      if (functionName === 'getRound') return [true, 2n];
      return {
        INSTANCE: repeatedSequencer || blockNumber < 83n ? ROLLUP : SECOND_ROLLUP,
        QUORUM: 2n,
        ROUND_SIZE_IN_EPOCHS: repeatedSequencer ? 2n : 1n,
        SLASH_OFFSET_IN_ROUNDS: 1n,
        COMMITTEE_SIZE: 4n,
        getSlashTargetCommittees: repeatedSequencer
          ? [
            [TARGET, PROPOSER, SLASHER, ROLLUP],
            [TARGET, PROPOSER, SLASHER, ROLLUP],
          ]
          : [[TARGET, PROPOSER, SLASHER, ROLLUP]],
        getVotes: repeatedSequencer ? '0x0101' : '0x01',
        getTally: repeatedSequencer ? [
          { validator: TARGET, slashAmount: 100n },
          { validator: TARGET, slashAmount: 300n },
        ] : [{
          validator: TARGET,
          slashAmount: blockNumber < 83n ? 10n : 20n,
        }],
        getPayloadAddress: PAYLOAD,
      }[functionName];
    },
    async getLogs({ address, event, fromBlock, toBlock }) {
      const rows = event.name === 'CanonicalRollupUpdated' ? updates : slashes;
      return rows.filter((log) =>
        log.address.toLowerCase() === address.toLowerCase() &&
        log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock
      );
    },
    async getTransactionReceipt() {
      return {
        logs: [{
          address: PROPOSER,
          topics: encodeEventTopics({
            abi: [roundExecutedEvent],
            eventName: 'RoundExecuted',
            args: { round: 7n },
          }),
          data: encodeAbiParameters(
            [{ type: 'uint256' }],
            [repeatedSequencer ? 2n : 1n],
          ),
        }],
      };
    },
  };
}

function historicalExecutionContext({ amount }) {
  return {
    proposerAddress: PROPOSER.toLowerCase(),
    round: '7',
    targetEpoch: '6',
    actionIndex: 0,
    sequencer: TARGET.toLowerCase(),
    amount,
    support: 2,
    quorum: 2,
    maxSlashUnits: 1,
    unitVoteCounts: [2, 0, 0],
    epochIndex: 0,
    committeeIndex: 0,
    escaped: false,
    payloadAddress: PAYLOAD.toLowerCase(),
  };
}

function blockHash(blockNumber) {
  return `0x${BigInt(blockNumber).toString(16).padStart(64, '0')}`;
}

function transactionHash(blockNumber) {
  return `0x${(BigInt(blockNumber) + 1_000n).toString(16).padStart(64, '0')}`;
}

function rejectWhenAborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
