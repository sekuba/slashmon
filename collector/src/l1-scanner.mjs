import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  zeroAddress,
} from 'viem';

import {
  canonicalRollupUpdatedEvent,
  escapeHatchAbi,
  registryAbi,
  roundExecutedEvent,
  rollupAbi,
  slashedEvent,
  slasherAbi,
  slashingProposerAbi,
} from './l1-abis.mjs';
import {
  decodeVoteTargets,
  executableSlot,
  expirySlot,
  isRoundProtectedByPause,
  matchVoteActions,
  mergeVoteTargets,
  roundStatus,
  targetEpochs as roundTargetEpochs,
} from '../../shared/protocol/index.ts';

const MAX_RESOLVED_ROLLUPS = 256;
const MAX_EPOCH_COMMITTEE_SIZE = 4_096;

export class L1Scanner {
  constructor({
    rpcUrls,
    chainId,
    registryAddress,
    confirmations = 2,
    requestTimeoutMs = 15_000,
    snapshotTimeoutMs = 120_000,
    maxHeadAgeMs = 15 * 60_000,
    maxHeadStallMs = 2 * 60_000,
    maxFutureSkewMs = 2 * 60_000,
    slashLogStartBlock,
    slashLogLookbackBlocks = 600,
    slashLogChunkSize = 1_000,
    slashLogOverlapBlocks = 12,
    slashLogReorgRewindBlocks = 128,
    slashLogProviderTimeoutMs = 30_000,
    clientFactory,
    now = Date.now,
  }) {
    this.rpcUrls = rpcUrls;
    this.chainId = chainId;
    this.registryAddress = getAddress(registryAddress);
    this.confirmations = BigInt(confirmations);
    this.requestTimeoutMs = requestTimeoutMs;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.maxHeadAgeMs = maxHeadAgeMs;
    this.maxHeadStallMs = maxHeadStallMs;
    this.maxFutureSkewMs = maxFutureSkewMs;
    this.slashLogStartBlock = slashLogStartBlock === undefined
      ? undefined
      : BigInt(slashLogStartBlock);
    this.slashLogLookbackBlocks = BigInt(slashLogLookbackBlocks);
    this.slashLogChunkSize = BigInt(slashLogChunkSize);
    this.slashLogOverlapBlocks = BigInt(slashLogOverlapBlocks);
    this.slashLogReorgRewindBlocks = BigInt(slashLogReorgRewindBlocks);
    this.slashLogProviderTimeoutMs = slashLogProviderTimeoutMs;
    if (!Number.isSafeInteger(this.slashLogProviderTimeoutMs) || this.slashLogProviderTimeoutMs < 1) {
      throw new RangeError('slash log provider timeout must be a positive integer');
    }
    this.clientFactory = clientFactory ?? ((rpcUrl, signal) => createPublicClient({
      transport: http(rpcUrl, {
        timeout: this.requestTimeoutMs,
        retryCount: 0,
        fetchOptions: { signal },
      }),
    }));
    if (this.slashLogStartBlock !== undefined && this.slashLogStartBlock < 0n) {
      throw new RangeError('slash log start block must be non-negative');
    }
    if (this.slashLogLookbackBlocks < 1n) throw new RangeError('slash log lookback must be positive');
    if (this.slashLogChunkSize < 2n) throw new RangeError('slash log chunk size must be at least 2');
    if (this.slashLogOverlapBlocks < 1n || this.slashLogOverlapBlocks >= this.slashLogChunkSize) {
      throw new RangeError('slash log overlap must be positive and smaller than the chunk size');
    }
    if (this.slashLogReorgRewindBlocks < this.slashLogOverlapBlocks) {
      throw new RangeError('slash log reorg rewind must be at least the overlap');
    }
    this.now = now;
    this.nextProviderIndex = 0;
    this.nextLogProviderIndex = 0;
    this.nextCommitteeProviderIndex = 0;
  }

  /**
   * Resolve one historical committee against the exact confirmed L1 checkpoint
   * already accepted by the normal L1 collector. The before/after hash checks
   * prevent a provider from mixing a replacement block into the result.
   */
  getEpochCommittee(checkpoint, signal) {
    return this.withProviderFailover({
      cursorField: 'nextCommitteeProviderIndex',
      timeoutMs: this.requestTimeoutMs,
      timeoutLabel: 'committee lookup timed out',
      failureLabel: 'the epoch committee lookup',
      signal,
      attempt: (client) => this.getEpochCommitteeWithClient(client, checkpoint),
    });
  }

  async getEpochCommitteeWithClient(client, checkpoint = {}) {
    const epoch = requireUnsignedBigInt(checkpoint.epoch, 'committee epoch');
    const blockNumber = requireUnsignedBigInt(checkpoint.blockNumber, 'committee L1 block number');
    if (typeof checkpoint.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash)) {
      throw new Error('committee L1 block hash must be a 32-byte hex value');
    }
    const blockHash = checkpoint.blockHash.toLowerCase();
    const rollupAddress = getAddress(checkpoint.rollupAddress);
    requireNonZero(rollupAddress, 'committee Rollup');

    await this.assertExpectedChain(client);
    const pinnedBlock = await client.getBlock({ blockNumber });
    if (!pinnedBlock.hash || pinnedBlock.hash.toLowerCase() !== blockHash) {
      throw new Error(`confirmed L1 committee checkpoint ${blockNumber} is no longer canonical`);
    }
    requireCode(
      await client.getBytecode({ address: rollupAddress, blockNumber }),
      'committee Rollup',
      rollupAddress,
    );
    const rawCommittee = await read(
      client,
      rollupAddress,
      rollupAbi,
      'getEpochCommittee',
      blockNumber,
      [epoch],
    );
    if (!Array.isArray(rawCommittee) || rawCommittee.length === 0) {
      throw new Error(`L1 returned an empty committee for epoch ${epoch}`);
    }
    if (rawCommittee.length > MAX_EPOCH_COMMITTEE_SIZE) {
      throw new Error(
        `L1 returned ${rawCommittee.length} committee members; maximum is ${MAX_EPOCH_COMMITTEE_SIZE}`,
      );
    }
    const committee = rawCommittee.map((value) => {
      const address = getAddress(value);
      requireNonZero(address, 'committee member');
      return address.toLowerCase();
    });
    if (new Set(committee).size !== committee.length) {
      throw new Error(`L1 returned duplicate committee members for epoch ${epoch}`);
    }
    const verifiedBlock = await client.getBlock({ blockNumber });
    if (!verifiedBlock.hash || verifiedBlock.hash.toLowerCase() !== blockHash) {
      throw new Error(`confirmed L1 committee checkpoint ${blockNumber} changed during lookup`);
    }
    return {
      epoch: epoch.toString(),
      committee,
      rollupAddress: rollupAddress.toLowerCase(),
      blockNumber: blockNumber.toString(),
      blockHash,
    };
  }

  scan(previous = {}, signal) {
    return this.withProviderFailover({
      cursorField: 'nextProviderIndex',
      timeoutMs: this.snapshotTimeoutMs,
      timeoutLabel: 'complete snapshot timed out',
      failureLabel: 'a complete snapshot',
      signal,
      attempt: (client) => this.scanWithClient(client, previous),
    });
  }

  /**
   * Scan at most one durable range of confirmed Slashed logs. The caller must
   * commit the returned checkpoint together with its events before asking for
   * the next chunk. That makes a crash repeat work instead of skipping it.
   */
  scanSlashLogChunk(previous = {}, signal) {
    return this.withProviderFailover({
      cursorField: 'nextLogProviderIndex',
      timeoutMs: this.slashLogProviderTimeoutMs,
      timeoutLabel: 'slash log chunk timed out',
      failureLabel: 'a slash log chunk',
      signal,
      // When the collector's absolute backfill budget wins the race, do not
      // let the same hanging primary consume every future run; start with the
      // next configured RPC when collection resumes.
      rotateOnAbort: true,
      attempt: (client) => this.scanSlashLogChunkWithClient(client, previous),
    });
  }

  /**
   * Read the block time and post-slash stake of already recorded slashes, for
   * observations stored before these facts were collected. Returns one entry
   * per slash whose block still has the recorded hash.
   */
  readSlashFacts(slashes, signal) {
    return this.withProviderFailover({
      cursorField: 'nextLogProviderIndex',
      timeoutMs: this.slashLogProviderTimeoutMs,
      timeoutLabel: 'slash fact read timed out',
      failureLabel: 'a slash fact read',
      signal,
      attempt: async (client) => {
        await this.assertExpectedChain(client);
        const blocks = new Map();
        const facts = [];
        for (const slash of slashes) {
          const result = await readSlashFacts(client, slash, blocks);
          if (result) facts.push({ id: slash.id, ...result });
        }
        return facts;
      },
    });
  }

  // Tries every configured RPC once, starting at the remembered rotation
  // cursor, with a per-provider timeout. The first success pins the cursor.
  async withProviderFailover({
    cursorField,
    timeoutMs,
    timeoutLabel,
    failureLabel,
    signal,
    rotateOnAbort = false,
    attempt,
  }) {
    const errors = [];
    for (let offset = 0; offset < this.rpcUrls.length; offset += 1) {
      const providerIndex = (this[cursorField] + offset) % this.rpcUrls.length;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const providerSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const client = this.clientFactory(this.rpcUrls[providerIndex], providerSignal, providerIndex);
      try {
        const result = await attempt(client);
        this[cursorField] = providerIndex;
        return result;
      } catch (error) {
        if (signal?.aborted) {
          if (rotateOnAbort) this[cursorField] = (providerIndex + 1) % this.rpcUrls.length;
          throw error;
        }
        if (timeoutSignal.aborted) {
          errors.push(`provider ${providerIndex + 1}: ${timeoutLabel} after ${timeoutMs}ms`);
          continue;
        }
        errors.push(`provider ${providerIndex + 1}: ${sanitizeRpcError(error)}`);
      }
    }
    throw new Error(`Every configured L1 RPC failed ${failureLabel} (${errors.join('; ')})`);
  }

  async scanSlashLogChunkWithClient(client, previous = {}) {
    await this.assertExpectedChain(client);

    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number === null || !head.hash) throw new Error('latest L1 block has no number or hash');
    this.assertFreshTimestamp(head.timestamp);
    if (head.number < this.confirmations) {
      throw new Error(`L1 head ${head.number} is below confirmation depth ${this.confirmations}`);
    }
    const confirmedBlockNumber = head.number - this.confirmations;
    this.assertHeadProgress(head, previous, confirmedBlockNumber);
    const confirmedBlock = this.confirmations === 0n
      ? head
      : await client.getBlock({ blockNumber: confirmedBlockNumber });
    if (!confirmedBlock.hash) {
      throw new Error(`confirmed L1 block ${confirmedBlockNumber} has no hash`);
    }

    const cursorNumber = readOptionalBigInt(previous.lastBlockNumber);
    const cursorHash = previous.lastBlockHash;
    if ((cursorNumber === undefined) !== !cursorHash) {
      throw new Error('persisted slash log checkpoint is incomplete');
    }
    if (
      this.slashLogStartBlock !== undefined &&
      this.slashLogStartBlock > confirmedBlockNumber
    ) {
      throw new Error(
        `configured slash log start block ${this.slashLogStartBlock} is above confirmed L1 head ${confirmedBlockNumber}`,
      );
    }
    const persistedStartBlock = readOptionalBigInt(
      previous.metadata?.backfillStartBlock,
    );
    const restartFromConfiguredStart =
      cursorNumber !== undefined &&
      this.slashLogStartBlock !== undefined &&
      persistedStartBlock !== this.slashLogStartBlock;

    let reorgDetected = false;
    if (cursorNumber !== undefined && !restartFromConfiguredStart) {
      if (cursorNumber > confirmedBlockNumber) {
        reorgDetected = true;
      } else {
        const canonicalCursor = cursorNumber === confirmedBlockNumber
          ? confirmedBlock
          : await client.getBlock({ blockNumber: cursorNumber });
        if (!canonicalCursor.hash || canonicalCursor.hash.toLowerCase() !== String(cursorHash).toLowerCase()) {
          reorgDetected = true;
        }
      }
    }

    let fromBlock;
    if (cursorNumber === undefined || restartFromConfiguredStart) {
      fromBlock = this.slashLogStartBlock ?? (
        confirmedBlockNumber + 1n > this.slashLogLookbackBlocks
          ? confirmedBlockNumber + 1n - this.slashLogLookbackBlocks
          : 0n
      );
    } else if (reorgDetected) {
      fromBlock = cursorNumber + 1n > this.slashLogReorgRewindBlocks
        ? cursorNumber + 1n - this.slashLogReorgRewindBlocks
        : 0n;
      if (fromBlock > confirmedBlockNumber) fromBlock = 0n;
    } else {
      fromBlock = cursorNumber + 1n > this.slashLogOverlapBlocks
        ? cursorNumber + 1n - this.slashLogOverlapBlocks
        : 0n;
    }
    if (
      this.slashLogStartBlock !== undefined &&
      fromBlock < this.slashLogStartBlock
    ) {
      fromBlock = this.slashLogStartBlock;
    }
    const toBlock = minBigInt(confirmedBlockNumber, fromBlock + this.slashLogChunkSize - 1n);
    const checkpointBlock = toBlock === confirmedBlockNumber
      ? confirmedBlock
      : await client.getBlock({ blockNumber: toBlock });
    if (!checkpointBlock.hash) throw new Error(`L1 log checkpoint ${toBlock} has no hash`);

    // Resolve emitters from the canonical Registry view for this exact range.
    // Carrying a flat emitter set across checkpoints would preserve an address
    // introduced only on an orphaned fork and could turn its later logs into
    // false slash confirmations after a reorg.
    const knownRollups = new Set();

    const registryUpdates = await client.getLogs({
      address: this.registryAddress,
      event: canonicalRollupUpdatedEvent,
      fromBlock,
      toBlock,
      strict: true,
    });
    for (const update of registryUpdates) {
      if (!update.args?.instance) throw new Error('Registry update log is missing its Rollup instance');
      addResolvedRollup(knownRollups, update.args.instance);
    }

    // Resolve both ends of the range. The start address covers an upgrade that
    // happened before this bounded scan; update logs cover every change inside
    // it; the end read is a defense-in-depth check for an RPC decoder quirk.
    const registryCodeAtStart = await client.getBytecode({ address: this.registryAddress, blockNumber: fromBlock });
    if (registryCodeAtStart && registryCodeAtStart !== '0x') {
      addResolvedRollup(knownRollups, await read(
        client,
        this.registryAddress,
        registryAbi,
        'getCanonicalRollup',
        fromBlock,
      ));
    }
    const registryCodeAtEnd = await client.getBytecode({ address: this.registryAddress, blockNumber: toBlock });
    if (registryCodeAtEnd && registryCodeAtEnd !== '0x') {
      addResolvedRollup(knownRollups, await read(
        client,
        this.registryAddress,
        registryAbi,
        'getCanonicalRollup',
        toBlock,
      ));
    }
    // A deliberately large first lookback may begin before Registry
    // deployment. Such chunks are valid empty history and must still advance
    // the cursor, or startup would wedge forever on its first range.
    if (knownRollups.size > MAX_RESOLVED_ROLLUPS) {
      throw new Error(`resolved ${knownRollups.size} historical Rollup emitters; maximum is ${MAX_RESOLVED_ROLLUPS}`);
    }

    const logs = [];
    for (const rollupAddress of knownRollups) {
      const emitterLogs = await client.getLogs({
        address: rollupAddress,
        event: slashedEvent,
        fromBlock,
        toBlock,
        strict: true,
      });
      for (const log of emitterLogs) logs.push(normalizeSlashLog(log, rollupAddress));
    }
    logs.sort(compareLogs);
    await attachExecutionContext(client, logs);

    // As with state snapshots, number-pinned calls are followed by a hash
    // check. A provider switching forks mid-range cannot advance the cursor.
    const verifiedCheckpoint = await client.getBlock({ blockNumber: toBlock });
    if (!verifiedCheckpoint.hash || verifiedCheckpoint.hash.toLowerCase() !== checkpointBlock.hash.toLowerCase()) {
      throw new Error(`confirmed L1 log checkpoint ${toBlock} changed during scan`);
    }

    return {
      chainId: this.chainId,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      toBlockHash: checkpointBlock.hash,
      confirmedBlockNumber: confirmedBlockNumber.toString(),
      reorgDetected,
      initial: cursorNumber === undefined || restartFromConfiguredStart,
      initialBackfill:
        cursorNumber === undefined ||
        restartFromConfiguredStart ||
        previous.metadata?.initialBackfill === true,
      backfillStartBlock: this.slashLogStartBlock?.toString() ?? null,
      hasMore: toBlock < confirmedBlockNumber,
      registryAddress: this.registryAddress,
      rollupAddresses: [...knownRollups].sort(),
      logs,
      observedAt: this.now(),
    };
  }

  async scanWithClient(client, previous = {}) {
    await this.assertExpectedChain(client);

    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number === null || !head.hash) {
      throw new Error('latest L1 block has no number or hash');
    }
    this.assertFreshTimestamp(head.timestamp);
    if (head.number < this.confirmations) {
      throw new Error(`L1 head ${head.number} is below confirmation depth ${this.confirmations}`);
    }

    const blockNumber = head.number - this.confirmations;
    this.assertHeadProgress(head, previous, blockNumber);
    const block = this.confirmations === 0n
      ? head
      : await client.getBlock({ blockNumber });
    if (!block.hash) {
      throw new Error(`confirmed L1 block ${blockNumber} has no hash`);
    }

    const previousBlockNumber = readOptionalBigInt(previous.lastBlockNumber ?? previous.blockNumber);
    const previousBlockHash = previous.lastBlockHash ?? previous.blockHash;
    let reorgDetected = false;
    if (previousBlockNumber !== undefined && previousBlockHash) {
      if (blockNumber < previousBlockNumber) {
        throw new Error(`confirmed L1 head moved backwards from ${previousBlockNumber} to ${blockNumber}`);
      }
      const canonicalPrevious = blockNumber === previousBlockNumber
        ? block
        : await client.getBlock({ blockNumber: previousBlockNumber });
      reorgDetected = canonicalPrevious.hash?.toLowerCase() !== String(previousBlockHash).toLowerCase();
    }

    const codeAtRegistry = await client.getBytecode({ address: this.registryAddress, blockNumber });
    requireCode(codeAtRegistry, 'Registry', this.registryAddress);
    const rollupAddress = getAddress(await read(client, this.registryAddress, registryAbi, 'getCanonicalRollup', blockNumber));
    requireNonZero(rollupAddress, 'canonical Rollup');
    requireCode(await client.getBytecode({ address: rollupAddress, blockNumber }), 'Rollup', rollupAddress);

    const [
      rollupVersion,
      activeSlasherValue,
      pendingSlasherValue,
      legacySlasherValue,
      currentSlot,
      currentEpoch,
      l1GenesisTime,
      slotDuration,
      epochDuration,
    ] = await Promise.all([
      read(client, rollupAddress, rollupAbi, 'getVersion', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getSlasher', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getPendingSlasher', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getLegacySlasher', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getCurrentSlot', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getCurrentEpoch', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getGenesisTime', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getSlotDuration', blockNumber),
      read(client, rollupAddress, rollupAbi, 'getEpochDuration', blockNumber),
    ]);
    const staking = await readStaking(client, rollupAddress, blockNumber);

    const activeSlasher = getAddress(activeSlasherValue);
    const pendingSlasher = getAddress(pendingSlasherValue[0]);
    const legacySlasher = getAddress(legacySlasherValue[0]);
    requireNonZero(activeSlasher, 'active Slasher');

    const stackInputs = [{ role: 'active', slasherAddress: activeSlasher }];
    if (pendingSlasher !== zeroAddress) {
      stackInputs.push({
        role: 'pending',
        slasherAddress: pendingSlasher,
        readyAt: pendingSlasherValue[1].toString(),
      });
    }
    if (legacySlasher !== zeroAddress && legacySlasherValue[1] >= block.timestamp) {
      stackInputs.push({
        role: 'legacy',
        slasherAddress: legacySlasher,
        authorizedUntil: legacySlasherValue[1].toString(),
      });
    }

    const uniqueStacks = deduplicateStacks(stackInputs);
    const previousRoundCursors = new Map(
      !reorgDetected && Array.isArray(previous.metadata?.roundCursors)
        ? previous.metadata.roundCursors.map((cursor) => [
          `${String(cursor.proposerAddress).toLowerCase()}:${cursor.round}`,
          cursor,
        ])
        : [],
    );
    const stacks = [];
    const stackErrors = [];
    for (const input of uniqueStacks) {
      try {
        stacks.push(await this.scanStack(client, {
          ...input,
          rollupAddress,
          currentSlot,
          blockNumber,
          previousRoundCursors,
        }));
      } catch (error) {
        // The active stack is the canonical safety signal and must be coherent.
        // A broken queued/legacy stack is isolated and reported as degraded so
        // it cannot freeze active monitoring for its whole authorization window.
        if (input.role === 'active') throw error;
        stackErrors.push({
          role: input.role,
          slasherAddress: input.slasherAddress,
          error: sanitizeRpcError(error),
        });
      }
    }

    // Calls are number-pinned because broad EIP-1898 support is inconsistent.
    // Re-reading the chosen block closes the mixed-fork window: no state from a
    // replacement block is published under the hash captured at scan start.
    const verifiedBlock = await client.getBlock({ blockNumber });
    if (!verifiedBlock.hash || verifiedBlock.hash.toLowerCase() !== block.hash.toLowerCase()) {
      throw new Error(`confirmed L1 block ${blockNumber} changed during snapshot`);
    }

    return {
      chainId: this.chainId,
      blockNumber: blockNumber.toString(),
      blockHash: block.hash,
      blockTimestamp: block.timestamp.toString(),
      observedAt: this.now(),
      reorgDetected,
      registryAddress: this.registryAddress,
      rollupAddress,
      rollupVersion: rollupVersion.toString(),
      l1GenesisTime: l1GenesisTime.toString(),
      currentSlot: currentSlot.toString(),
      currentEpoch: currentEpoch.toString(),
      slotDuration: slotDuration.toString(),
      epochDuration: epochDuration.toString(),
      staking,
      stacks,
      stackErrors,
      degraded: stackErrors.length > 0 || stacks.some((stack) => stack.roundErrors.length > 0),
    };
  }

  async scanStack(client, input) {
    const { role, slasherAddress, rollupAddress, currentSlot, blockNumber, previousRoundCursors } = input;
    requireCode(await client.getBytecode({ address: slasherAddress, blockNumber }), `${role} Slasher`, slasherAddress);
    const proposerAddress = getAddress(await read(client, slasherAddress, slasherAbi, 'PROPOSER', blockNumber));
    requireNonZero(proposerAddress, `${role} SlashingProposer`);
    requireCode(await client.getBytecode({ address: proposerAddress, blockNumber }), `${role} SlashingProposer`, proposerAddress);

    const [
      proposerRollup,
      proposerSlasher,
      currentRound,
      quorum,
      roundSize,
      roundSizeInEpochs,
      executionDelayInRounds,
      lifetimeInRounds,
      slashOffsetInRounds,
      committeeSize,
      isSlashingEnabled,
      slashingDisabledUntil,
      slashingDisableDuration,
    ] = await Promise.all([
      read(client, proposerAddress, slashingProposerAbi, 'INSTANCE', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'SLASHER', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'getCurrentRound', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'QUORUM', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'ROUND_SIZE', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'ROUND_SIZE_IN_EPOCHS', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'EXECUTION_DELAY_IN_ROUNDS', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'LIFETIME_IN_ROUNDS', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'SLASH_OFFSET_IN_ROUNDS', blockNumber),
      read(client, proposerAddress, slashingProposerAbi, 'COMMITTEE_SIZE', blockNumber),
      read(client, slasherAddress, slasherAbi, 'isSlashingEnabled', blockNumber),
      read(client, slasherAddress, slasherAbi, 'slashingDisabledUntil', blockNumber),
      read(client, slasherAddress, slasherAbi, 'SLASHING_DISABLE_DURATION', blockNumber),
    ]);
    const slashAmounts = await readOptionalValues(client, proposerAddress, slashingProposerAbi, [
      'SLASH_AMOUNT_SMALL',
      'SLASH_AMOUNT_MEDIUM',
      'SLASH_AMOUNT_LARGE',
    ], blockNumber);

    if (getAddress(proposerRollup) !== rollupAddress) {
      throw new Error(`${role} proposer INSTANCE does not match the canonical Rollup`);
    }
    if (getAddress(proposerSlasher) !== slasherAddress) {
      throw new Error(`${role} proposer SLASHER does not match its Slasher`);
    }

    const config = {
      quorum,
      roundSize,
      roundSizeInEpochs,
      executionDelayInRounds,
      lifetimeInRounds,
      slashOffsetInRounds,
      committeeSize,
    };
    let pauseStartedAtSlot = null;
    let pauseEndsAtSlot = null;
    if (!isSlashingEnabled && slashingDisabledUntil > 0n) {
      const pauseStartedAt = slashingDisabledUntil - slashingDisableDuration;
      [pauseStartedAtSlot, pauseEndsAtSlot] = await Promise.all([
        read(client, rollupAddress, rollupAbi, 'getSlotAt', blockNumber, [pauseStartedAt]),
        read(client, rollupAddress, rollupAbi, 'getSlotAt', blockNumber, [slashingDisabledUntil]),
      ]);
    }
    const firstRound = currentRound > lifetimeInRounds ? currentRound - lifetimeInRounds : 0n;
    const rounds = [];
    const roundErrors = [];
    for (let round = firstRound; round <= currentRound; round += 1n) {
      try {
        const scanned = await scanRound(client, {
          proposerAddress,
          slasherAddress,
          rollupAddress,
          blockNumber,
          round,
          currentRound,
          currentSlot,
          role,
          config,
          isSlashingEnabled,
          pauseStartedAtSlot,
          pauseEndsAtSlot,
          previousRound: previousRoundCursors?.get(`${proposerAddress.toLowerCase()}:${round}`),
        });
        if (scanned.ballotCount !== '0' || scanned.isExecuted || scanned.actions.length > 0) {
          rounds.push(scanned);
        }
      } catch (error) {
        roundErrors.push({ round: round.toString(), error: sanitizeRpcError(error) });
      }
    }

    return {
      role,
      slasherAddress,
      proposerAddress,
      ...(input.readyAt ? { readyAt: input.readyAt } : {}),
      ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}),
      currentRound: currentRound.toString(),
      isSlashingEnabled,
      slashingDisabledUntil: slashingDisabledUntil.toString(),
      slashingDisableDuration: slashingDisableDuration.toString(),
      pauseStartedAtSlot: pauseStartedAtSlot?.toString() ?? null,
      pauseEndsAtSlot: pauseEndsAtSlot?.toString() ?? null,
      parameters: {
        quorum: quorum.toString(),
        roundSize: roundSize.toString(),
        roundSizeInEpochs: roundSizeInEpochs.toString(),
        executionDelayInRounds: executionDelayInRounds.toString(),
        lifetimeInRounds: lifetimeInRounds.toString(),
        slashOffsetInRounds: slashOffsetInRounds.toString(),
        committeeSize: committeeSize.toString(),
        slashAmounts: slashAmounts?.map((amount) => amount.toString()) ?? null,
      },
      rounds,
      roundErrors,
    };
  }

  async assertExpectedChain(client) {
    const actualChainId = await client.getChainId();
    if (actualChainId !== this.chainId) {
      throw new Error(`chain id ${actualChainId}, expected ${this.chainId}`);
    }
  }

  assertFreshTimestamp(timestamp) {
    const blockMs = Number(timestamp) * 1_000;
    const now = this.now();
    if (blockMs + this.maxHeadAgeMs < now) {
      throw new Error(`L1 head is ${now - blockMs}ms old`);
    }
    if (blockMs > now + this.maxFutureSkewMs) {
      throw new Error(`L1 head timestamp is ${blockMs - now}ms in the future`);
    }
  }

  assertHeadProgress(head, previous, confirmedBlockNumber) {
    const previousBlockNumber = readOptionalBigInt(previous?.lastBlockNumber ?? previous?.blockNumber);
    if (previousBlockNumber === undefined || previousBlockNumber !== confirmedBlockNumber) return;
    const stalledForMs = this.now() - Number(head.timestamp) * 1_000;
    if (stalledForMs > this.maxHeadStallMs) {
      throw new Error(
        `L1 confirmed head ${confirmedBlockNumber} has not advanced for ${stalledForMs}ms ` +
        `(limit ${this.maxHeadStallMs}ms)`,
      );
    }
  }
}

async function scanRound(client, input) {
  const {
    proposerAddress,
    slasherAddress,
    rollupAddress,
    blockNumber,
    round,
    currentRound,
    currentSlot,
    role,
    config,
    isSlashingEnabled,
    pauseStartedAtSlot,
    pauseEndsAtSlot,
    previousRound,
  } = input;
  const roundResult = await read(client, proposerAddress, slashingProposerAbi, 'getRound', blockNumber, [round]);
  const [isExecuted, ballotCount] = roundResult;
  let committees = [];
  let earlyTargets = [];
  let actions = [];
  let actionDetails = [];
  let payloadAddress = null;
  let isVetoed = false;
  const targetEpochs = roundTargetEpochs(round, {
    slashOffsetRounds: config.slashOffsetInRounds,
    roundSizeEpochs: config.roundSizeInEpochs,
  }).map((epoch) => epoch.toString());
  let escapeHatchEpochs = targetEpochs.map(() => false);

  if (isExecuted || ballotCount > 0n) {
    committees = await read(
      client,
      proposerAddress,
      slashingProposerAbi,
      'getSlashTargetCommittees',
      blockNumber,
      [round],
    );
    escapeHatchEpochs = await readEscapeHatchEpochs(
      client,
      rollupAddress,
      blockNumber,
      targetEpochs,
    );
    if (ballotCount > 0n) {
      const previousCount = previousRound && BigInt(previousRound.ballotCount) <= ballotCount
        ? BigInt(previousRound.ballotCount)
        : 0n;
      const encodedVotes = await readVotes(
        client,
        proposerAddress,
        blockNumber,
        round,
        previousCount,
        ballotCount,
      );
      earlyTargets = mergeVoteTargets(
        previousCount > 0n ? previousRound.earlyTargets ?? [] : [],
        decodeVoteTargets(encodedVotes, committees, config.committeeSize),
      );
    }
  }
  if (isExecuted || ballotCount >= config.quorum) {
    const result = await read(client, proposerAddress, slashingProposerAbi, 'getTally', blockNumber, [round, committees]);
    actions = result.map((action) => ({
      sequencer: getAddress(action.validator).toLowerCase(),
      amount: action.slashAmount.toString(),
    }));
    actionDetails = matchVoteActions(
      actions,
      earlyTargets,
      config.quorum,
      escapeHatchEpochs,
    );
    if (actions.length > 0) {
      const contractActions = actions.map((action) => ({ validator: action.sequencer, slashAmount: BigInt(action.amount) }));
      payloadAddress = getAddress(await read(
        client,
        proposerAddress,
        slashingProposerAbi,
        'getPayloadAddress',
        blockNumber,
        [round, contractActions],
      ));
      isVetoed = await read(client, slasherAddress, slasherAbi, 'vetoedPayloads', blockNumber, [payloadAddress]);
    }
  }

  const timing = {
    roundSizeSlots: config.roundSize,
    executionDelayRounds: config.executionDelayInRounds,
    lifetimeRounds: config.lifetimeInRounds,
  };
  const roundExecutableSlot = executableSlot(round, timing);
  const roundExpirySlot = expirySlot(round, timing);
  const proposerStatus = roundStatus({
    round,
    currentRound,
    currentSlot,
    isExecuted,
    hasActions: actions.length > 0,
  }, timing);
  const status = role === 'pending' && !isExecuted && ['newly-executable', 'executable'].includes(proposerStatus)
    ? 'pending-activation'
    : proposerStatus;
  const isExecutionPaused = !isSlashingEnabled && !isExecuted;
  const isProtected = !isExecuted && isRoundProtectedByPause({
    round,
    slashOffsetRounds: config.slashOffsetInRounds,
    isSlashingEnabled,
    pauseStartedAtSlot,
    pauseEndsAtSlot,
  }, timing);

  return {
    round: round.toString(),
    ballotCount: ballotCount.toString(),
    isExecuted,
    status,
    committees: committees.map((committee) => committee.map((address) => getAddress(address).toLowerCase())),
    earlyTargets: earlyTargets.map((target) => ({
      ...target,
      targetEpoch: targetEpochs[target.epochIndex],
      escaped: Boolean(escapeHatchEpochs[target.epochIndex]),
    })),
    actions,
    actionDetails: actionDetails.map((detail, actionIndex) => ({
      ...detail,
      actionIndex,
      targetEpoch: targetEpochs[detail.epochIndex],
    })),
    payloadAddress,
    isVetoed,
    executableSlot: roundExecutableSlot.toString(),
    expirySlot: roundExpirySlot.toString(),
    targetEpochs,
    escapeHatchEpochs,
    isAuthorized: role !== 'pending',
    proposerStatus,
    isExecutionPaused,
    isProtected,
  };
}

async function readVotes(client, proposerAddress, blockNumber, round, startIndex, ballotCount) {
  const votes = [];
  const batchSize = 32n;
  for (let start = startIndex; start < ballotCount; start += batchSize) {
    const end = start + batchSize > ballotCount ? ballotCount : start + batchSize;
    const requests = [];
    for (let index = start; index < end; index += 1n) {
      requests.push(read(
        client,
        proposerAddress,
        slashingProposerAbi,
        'getVotes',
        blockNumber,
        [round, index],
      ));
    }
    votes.push(...await Promise.all(requests));
  }
  return votes;
}

async function readEscapeHatchEpochs(
  client,
  rollupAddress,
  blockNumber,
  targetEpochs,
) {
  const hatchAddresses = await Promise.all(targetEpochs.map(async (epoch) =>
    getAddress(await read(
      client,
      rollupAddress,
      rollupAbi,
      'getEscapeHatchForEpoch',
      blockNumber,
      [BigInt(epoch)],
    ))));
  return await Promise.all(hatchAddresses.map(async (hatch, index) => {
    if (hatch === zeroAddress) return false;
    const [isOpen] = await read(
      client,
      hatch,
      escapeHatchAbi,
      'isHatchOpen',
      blockNumber,
      [BigInt(targetEpochs[index])],
    );
    return Boolean(isOpen);
  }));
}

// Stake rules explain an outcome but do not decide one, so a Rollup without
// these getters publishes no staking parameters instead of failing the scan.
async function readStaking(client, rollupAddress, blockNumber) {
  const values = await readOptionalValues(client, rollupAddress, rollupAbi, [
    'getActivationThreshold',
    'getLocalEjectionThreshold',
    'getExitDelay',
  ], blockNumber);
  if (!values) return null;
  const [activationThreshold, localEjectionThreshold, exitDelay] = values;
  return {
    activationThreshold: activationThreshold.toString(),
    localEjectionThreshold: localEjectionThreshold.toString(),
    exitDelay: exitDelay.toString(),
  };
}

async function readOptionalValues(client, address, abi, functionNames, blockNumber) {
  try {
    const values = await Promise.all(functionNames.map((functionName) =>
      read(client, address, abi, functionName, blockNumber)));
    return values.every((value) => typeof value === 'bigint') ? values : null;
  } catch {
    return null;
  }
}

async function read(client, address, abi, functionName, blockNumber, args = []) {
  return client.readContract({ address, abi, functionName, args, blockNumber });
}

export function deduplicateStacks(stacks) {
  const bySlasher = new Map();
  const rolePriority = { active: 3, legacy: 2, pending: 1 };
  for (const stack of stacks) {
    const key = stack.slasherAddress.toLowerCase();
    const existing = bySlasher.get(key);
    if (!existing) {
      bySlasher.set(key, { ...stack });
      continue;
    }

    // The same Slasher can appear in more than one rotation slot. In
    // particular, governance can queue the still-authorized legacy Slasher as
    // the next pending one. Scan it once, but keep the authorized role so its
    // drain-window rounds do not become non-executable merely because the
    // pending tuple was returned first. Preserve both rotation timestamps for
    // operator context.
    const preferred = (rolePriority[stack.role] ?? 0) > (rolePriority[existing.role] ?? 0)
      ? stack
      : existing;
    bySlasher.set(key, { ...existing, ...stack, ...preferred });
  }
  return [...bySlasher.values()];
}

function requireNonZero(address, label) {
  if (address === zeroAddress) throw new Error(`${label} address is zero`);
}

function requireCode(code, label, address) {
  if (!code || code === '0x') throw new Error(`no contract code at ${label} ${address}`);
}

function readOptionalBigInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function requireUnsignedBigInt(value, label) {
  const parsed = readOptionalBigInt(value);
  if (parsed === undefined || parsed < 0n) throw new Error(`${label} must be an unsigned integer`);
  return parsed;
}

function normalizeSlashLog(log, expectedEmitter) {
  const blockNumber = readOptionalBigInt(log.blockNumber);
  const logIndex = typeof log.logIndex === 'bigint' ? Number(log.logIndex) : log.logIndex;
  if (
    blockNumber === undefined ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(String(log.blockHash ?? '')) ||
    !/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash ?? ''))
  ) {
    throw new Error('Slashed log is missing its block/transaction identity');
  }
  if (log.removed) throw new Error('RPC returned a removed Slashed log from a confirmed range');
  const emitter = getAddress(log.address ?? expectedEmitter).toLowerCase();
  if (emitter !== expectedEmitter.toLowerCase()) {
    throw new Error('RPC returned a Slashed log from an unrequested emitter');
  }
  if (!log.args?.attester || log.args.amount === undefined) {
    throw new Error('Slashed log is missing attester or amount');
  }
  const amount = BigInt(log.args.amount);
  if (amount < 0n) throw new Error('Slashed log amount is negative');
  return {
    rollupAddress: emitter,
    blockNumber: blockNumber.toString(),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex,
    sequencer: getAddress(log.args.attester).toLowerCase(),
    amount: amount.toString(),
  };
}

async function attachExecutionContext(client, logs) {
  const byTransaction = new Map();
  const reconstructedRounds = new Map();
  const blocks = new Map();
  const slashIndex = new Map();
  for (const log of [...logs].sort((left, right) => left.logIndex - right.logIndex)) {
    const next = slashIndex.get(log.transactionHash) ?? 0;
    log.transactionSlashIndex = next;
    slashIndex.set(log.transactionHash, next + 1);
  }
  for (const log of logs) {
    const transactionHash = log.transactionHash;
    if (!byTransaction.has(transactionHash)) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      const candidates = [];
      for (const receiptLog of receipt.logs ?? []) {
        try {
          const decoded = decodeEventLog({
            abi: [roundExecutedEvent],
            data: receiptLog.data,
            topics: receiptLog.topics,
            strict: true,
          });
          candidates.push({
            proposerAddress: getAddress(receiptLog.address).toLowerCase(),
            round: decoded.args.round.toString(),
            slashCount: decoded.args.slashCount.toString(),
          });
        } catch {
          // Other logs in the execution receipt are expected.
        }
      }
      if (candidates.length === 0) {
        throw new Error(`Slashed transaction ${transactionHash} has no RoundExecuted event`);
      }
      byTransaction.set(transactionHash, candidates);
    }
    log.executionCandidates = byTransaction.get(transactionHash);
    const matchingContexts = [];
    for (const candidate of log.executionCandidates) {
      const cacheKey = [
        log.blockNumber,
        log.rollupAddress,
        candidate.proposerAddress,
        candidate.round,
      ].join(':');
      if (!reconstructedRounds.has(cacheKey)) {
        reconstructedRounds.set(
          cacheKey,
          reconstructExecutedRound(client, {
            ...candidate,
            rollupAddress: log.rollupAddress,
            blockNumber: BigInt(log.blockNumber),
          }),
        );
      }
      const reconstructed = await reconstructedRounds.get(cacheKey);
      if (!reconstructed) continue;
      const detail = reconstructed.actionDetails[log.transactionSlashIndex];
      if (detail?.sequencer !== log.sequencer) continue;
      matchingContexts.push({
        proposerAddress: candidate.proposerAddress,
        round: candidate.round,
        targetEpoch: detail.targetEpoch,
        actionIndex: log.transactionSlashIndex,
        sequencer: detail.sequencer,
        amount: detail.amount,
        support: detail.support,
        quorum: reconstructed.quorum,
        maxSlashUnits: detail.maxSlashUnits,
        unitVoteCounts: detail.unitVoteCounts,
        epochIndex: detail.epochIndex,
        committeeIndex: detail.committeeIndex,
        escaped: detail.escaped,
        payloadAddress: reconstructed.payloadAddress,
      });
    }
    if (matchingContexts.length !== 1) {
      throw new Error(
        `Slashed log ${transactionHash}:${log.logIndex} has ${matchingContexts.length} ` +
        'exact historical RoundExecuted links',
      );
    }
    [log.executionContext] = matchingContexts;
    const status = await read(
      client,
      log.rollupAddress,
      rollupAbi,
      'getStatus',
      BigInt(log.blockNumber),
      [log.sequencer],
    );
    log.attesterStatus = Number(status);
    log.ejected = log.attesterStatus === 2 || log.attesterStatus === 3;
    const facts = await readSlashFacts(client, log, blocks);
    if (!facts) throw new Error(`Slashed log block ${log.blockNumber} changed during scan`);
    Object.assign(log, facts);
  }
}

// When a slash happened and what it left: the block time, the attester's stake
// right after the block, and the ejection threshold then in force. Stake and
// threshold reads need archive state, so they are optional; a block whose hash
// no longer matches yields nothing.
async function readSlashFacts(client, slash, blocks) {
  const blockNumber = BigInt(slash.blockNumber);
  const key = blockNumber.toString();
  if (!blocks.has(key)) blocks.set(key, client.getBlock({ blockNumber }));
  const block = await blocks.get(key);
  if (!block?.hash || block.hash.toLowerCase() !== String(slash.blockHash).toLowerCase()) {
    return null;
  }
  const [view, threshold] = await Promise.all([
    readOptional(client, slash.rollupAddress, rollupAbi, 'getAttesterView', blockNumber, [
      slash.sequencer,
    ]),
    readOptional(client, slash.rollupAddress, rollupAbi, 'getLocalEjectionThreshold', blockNumber),
  ]);
  return {
    blockTimestamp: block.timestamp.toString(),
    stakeAfter: stakeFromAttesterView(view),
    ejectionThreshold: typeof threshold === 'bigint' ? threshold.toString() : null,
  };
}

// A validating attester's stake is its effective balance; an ejected or
// exiting one's is the amount waiting in its exit.
function stakeFromAttesterView(view) {
  if (!view || typeof view !== 'object') return null;
  const status = Number(view.status);
  if (status === 1 && typeof view.effectiveBalance === 'bigint') {
    return view.effectiveBalance.toString();
  }
  if ((status === 2 || status === 3) && view.exit?.exists === true && typeof view.exit.amount === 'bigint') {
    return view.exit.amount.toString();
  }
  return status === 0 ? '0' : null;
}

async function readOptional(client, address, abi, functionName, blockNumber, args = []) {
  try {
    return await read(client, address, abi, functionName, blockNumber, args);
  } catch {
    return null;
  }
}

async function reconstructExecutedRound(client, {
  proposerAddress,
  round: roundInput,
  slashCount: slashCountInput,
  rollupAddress,
  blockNumber,
}) {
  const round = BigInt(roundInput);
  const slashCount = BigInt(slashCountInput);
  const [
    instance,
    [isExecuted, ballotCount],
    quorum,
    roundSizeInEpochs,
    slashOffsetInRounds,
    committeeSize,
  ] = await Promise.all([
    read(client, proposerAddress, slashingProposerAbi, 'INSTANCE', blockNumber),
    read(client, proposerAddress, slashingProposerAbi, 'getRound', blockNumber, [round]),
    read(client, proposerAddress, slashingProposerAbi, 'QUORUM', blockNumber),
    read(client, proposerAddress, slashingProposerAbi, 'ROUND_SIZE_IN_EPOCHS', blockNumber),
    read(client, proposerAddress, slashingProposerAbi, 'SLASH_OFFSET_IN_ROUNDS', blockNumber),
    read(client, proposerAddress, slashingProposerAbi, 'COMMITTEE_SIZE', blockNumber),
  ]);
  if (getAddress(instance).toLowerCase() !== rollupAddress) return null;
  if (!isExecuted) {
    throw new Error(`RoundExecuted event for round ${round} is not reflected at block ${blockNumber}`);
  }

  const committees = await read(
    client,
    proposerAddress,
    slashingProposerAbi,
    'getSlashTargetCommittees',
    blockNumber,
    [round],
  );
  const encodedVotes = await readVotes(
    client,
    proposerAddress,
    blockNumber,
    round,
    0n,
    BigInt(ballotCount),
  );
  const targets = decodeVoteTargets(encodedVotes, committees, committeeSize);
  const targetEpochs = roundTargetEpochs(round, {
    slashOffsetRounds: slashOffsetInRounds,
    roundSizeEpochs: roundSizeInEpochs,
  }).map((epoch) => epoch.toString());
  const escapeHatchEpochs = await readEscapeHatchEpochs(
    client,
    rollupAddress,
    blockNumber,
    targetEpochs,
  );
  const tally = await read(
    client,
    proposerAddress,
    slashingProposerAbi,
    'getTally',
    blockNumber,
    [round, committees],
  );
  const actions = tally.map((action) => ({
    sequencer: getAddress(action.validator).toLowerCase(),
    amount: action.slashAmount.toString(),
  }));
  if (BigInt(actions.length) !== slashCount) {
    throw new Error(
      `RoundExecuted event for round ${round} reports ${slashCount} slashes, ` +
      `historical tally returned ${actions.length}`,
    );
  }
  const actionDetails = matchVoteActions(
    actions,
    targets,
    quorum,
    escapeHatchEpochs,
  ).map((detail, actionIndex) => ({
    ...detail,
    actionIndex,
    targetEpoch: targetEpochs[detail.epochIndex],
    escaped: Boolean(escapeHatchEpochs[detail.epochIndex]),
  }));
  const contractActions = actions.map((action) => ({
    validator: action.sequencer,
    slashAmount: BigInt(action.amount),
  }));
  const payloadAddress = getAddress(await read(
    client,
    proposerAddress,
    slashingProposerAbi,
    'getPayloadAddress',
    blockNumber,
    [round, contractActions],
  )).toLowerCase();
  return {
    quorum: Number(quorum),
    actionDetails,
    payloadAddress,
  };
}

function compareLogs(left, right) {
  const blockOrder = BigInt(left.blockNumber) < BigInt(right.blockNumber)
    ? -1
    : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1 : 0;
  return blockOrder || left.logIndex - right.logIndex ||
    left.transactionHash.localeCompare(right.transactionHash);
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function addResolvedRollup(target, value) {
  const address = getAddress(value);
  if (address !== zeroAddress) target.add(address.toLowerCase());
}

function sanitizeRpcError(error) {
  const message = error?.shortMessage ?? error?.message ?? String(error);
  return String(message)
    .replace(/https?:\/\/[^\s)]+/gi, '[rpc]')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}
