import { parseOffenseSnapshot } from './offenses.mjs';

const VALIDATOR_STATUSES = new Set([
  'checkpoint-mined',
  'checkpoint-valid',
  'checkpoint-invalid',
  'checkpoint-unvalidated',
  'checkpoint-missed',
  'blocks-missed',
  'attestation-sent',
  'attestation-missed',
]);

export class AztecAdminClient {
  constructor({
    url,
    nodeUrl = url,
    apiKey,
    nodeApiKey,
    timeoutMs = 10_000,
    maxResponseBytes = 2 * 1024 * 1024,
    maxSingleValidatorStatsResponseBytes = 2 * 1024 * 1024,
    maxOffenses = 100_000,
    fetchImpl = fetch,
  }) {
    this.url = url;
    this.nodeUrl = nodeUrl;
    this.apiKey = apiKey;
    this.nodeApiKey = nodeApiKey;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxSingleValidatorStatsResponseBytes = maxSingleValidatorStatsResponseBytes;
    this.maxOffenses = maxOffenses;
    this.fetchImpl = fetchImpl;
    this.nextId = 1;
  }

  async getAllSlashOffenses(signal) {
    const result = await this.call('aztecAdmin_getSlashOffenses', ['all'], signal);
    return parseOffenseSnapshot(result, this.maxOffenses);
  }

  async getNodeInfo(signal) {
    const result = await this.call('aztec_getNodeInfo', [], signal);
    return parseNodeInfo(result);
  }

  async getNodeSyncStatus(signal) {
    const [ready, l1Timestamp, l2Slot, l2Epoch] = await Promise.all([
      this.call('aztec_isReady', [], signal),
      this.call('aztec_getSyncedL1Timestamp', [], signal),
      this.call('aztec_getSyncedL2SlotNumber', [], signal),
      this.call('aztec_getSyncedL2EpochNumber', [], signal),
    ]);
    return parseNodeSyncStatus({ ready, l1Timestamp, l2Slot, l2Epoch });
  }

  async getSentinelSyncStatus(signal) {
    const [ready, l2Slot] = await Promise.all([
      this.call('aztec_isReady', [], signal),
      this.call('aztec_getSyncedL2SlotNumber', [], signal),
    ]);
    const parsed = parseNodeSyncStatus({
      ready,
      l1Timestamp: null,
      l2Slot,
      l2Epoch: null,
    });
    return { ready: parsed.ready, l2Slot: parsed.l2Slot };
  }

  async getValidatorStats(address, fromSlot, toSlot, signal) {
    const sequencer = parseAddress(address, 'validator stats address');
    const from = parseUnsignedInteger(fromSlot, 'validator stats fromSlot');
    const to = parseUnsignedInteger(toSlot, 'validator stats toSlot');
    if (BigInt(from) > BigInt(to)) {
      throw new Error('Aztec validator stats fromSlot must not exceed toSlot');
    }
    const result = await this.call('aztec_getValidatorStats', [sequencer, from, to], signal);
    return parseSingleValidatorStats(result, { sequencer, fromSlot: from, toSlot: to });
  }

  async getInactivityConfig(signal) {
    const result = await this.call('aztecAdmin_getConfig', [], signal);
    return parseInactivityConfig(result);
  }

  async call(method, params, signal) {
    let request;
    if (method === 'aztecAdmin_getSlashOffenses' && isExactParams(params, ['all'])) {
      request = { url: this.url, apiKey: this.apiKey, label: 'Aztec admin' };
    } else if (method === 'aztecAdmin_getConfig' && isExactParams(params, [])) {
      request = { url: this.url, apiKey: this.apiKey, label: 'Aztec admin' };
    } else if (
      [
        'aztec_getNodeInfo',
        'aztec_isReady',
        'aztec_getSyncedL1Timestamp',
        'aztec_getSyncedL2SlotNumber',
        'aztec_getSyncedL2EpochNumber',
      ].includes(method) && isExactParams(params, [])
    ) {
      request = { url: this.nodeUrl, apiKey: this.nodeApiKey, label: 'Aztec node' };
    } else if (method === 'aztec_getValidatorStats' && isValidatorStatsParams(params)) {
      request = { url: this.nodeUrl, apiKey: this.nodeApiKey, label: 'Aztec node' };
    } else {
      throw new Error(`Aztec RPC method or parameters are not allowed: ${method}`);
    }

    const id = this.nextId++;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(request.apiKey ? { 'x-api-key': request.apiKey } : {}),
    };

    let response;
    try {
      response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted && !signal?.aborted) {
        throw new Error(`${request.label} request timed out after ${this.timeoutMs}ms`, { cause: error });
      }
      throw new Error(
        `${request.label} request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const responseLimit = method === 'aztec_getValidatorStats'
      ? this.maxSingleValidatorStatsResponseBytes
      : this.maxResponseBytes;
    const body = await readLimitedBody(response, responseLimit, request.label);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`${request.label} returned invalid JSON with HTTP ${response.status}`);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`${request.label} returned an invalid JSON-RPC response`);
    }
    // JSON-RPC answers with a null id when it rejects a request before reading
    // it, as Aztec does for a missing or wrong API key.
    if (payload.id !== id && !(payload.id === null && payload.error)) {
      throw new Error(`${request.label} response id mismatch: expected ${id}`);
    }
    if (payload.error) {
      const message = typeof payload.error.message === 'string' ? payload.error.message : 'unknown JSON-RPC error';
      const status = response.ok ? '' : ` (HTTP ${response.status})`;
      throw new Error(`${request.label} JSON-RPC error: ${message}${status}`);
    }
    if (!response.ok) {
      throw new Error(`${request.label} returned HTTP ${response.status}`);
    }
    if (!Object.hasOwn(payload, 'result')) {
      throw new Error(`${request.label} response did not include a result`);
    }
    return payload.result;
  }
}

export function parseNodeInfo(value) {
  if (!isPlainObject(value)) {
    throw new Error('Aztec node info must be an object');
  }
  const contracts = value.l1ContractAddresses;
  if (!isPlainObject(contracts)) {
    throw new Error('Aztec node info must include l1ContractAddresses');
  }
  return {
    l1ChainId: parseChainId(value.l1ChainId),
    registryAddress: parseAddress(contracts.registryAddress, 'node info registryAddress'),
    rollupAddress: parseAddress(contracts.rollupAddress, 'node info rollupAddress'),
  };
}

export function parseNodeSyncStatus(value) {
  if (!isPlainObject(value) || typeof value.ready !== 'boolean') {
    throw new Error('Aztec node sync readiness must be a boolean');
  }
  return {
    ready: value.ready,
    l1Timestamp: parseOptionalUnsignedInteger(value.l1Timestamp, 'synced L1 timestamp'),
    l2Slot: parseOptionalUnsignedInteger(value.l2Slot, 'synced L2 slot'),
    l2Epoch: parseOptionalUnsignedInteger(value.l2Epoch, 'synced L2 epoch'),
  };
}

export function parseSingleValidatorStats(value, {
  sequencer: expectedSequencer,
  fromSlot,
  toSlot,
} = {}) {
  // The node returns undefined (JSON null) when this address has no slot-level
  // history. L1 committee membership still lets the collector persist a 0/0
  // epoch row after another committee response proves the epoch was evaluated.
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value) || !isPlainObject(value.validator)) {
    throw new Error('Aztec single-validator stats must include a validator object');
  }
  const expected = parseAddress(expectedSequencer, 'expected validator stats address');
  const sequencer = parseAddress(value.validator.address, 'validator stats address');
  if (sequencer !== expected) {
    throw new Error(`Aztec validator stats address does not match requested address ${expected}`);
  }
  if (!Array.isArray(value.validator.history)) {
    throw new Error(`Aztec validator history for ${sequencer} must be an array`);
  }
  const lowerBound = BigInt(parseUnsignedInteger(fromSlot, 'validator stats fromSlot'));
  const upperBound = BigInt(parseUnsignedInteger(toSlot, 'validator stats toSlot'));
  const seenSlots = new Set();
  let previousSlot;
  const history = value.validator.history.map((observation, index) => {
    if (!isPlainObject(observation) || !VALIDATOR_STATUSES.has(observation.status)) {
      throw new Error(`Aztec validator history status at ${sequencer}[${index}] is invalid`);
    }
    const slot = parseUnsignedInteger(observation.slot, `validator history slot at ${sequencer}[${index}]`);
    const numericSlot = BigInt(slot);
    if (numericSlot < lowerBound || numericSlot > upperBound) {
      throw new Error(`Aztec validator history slot ${slot} is outside the requested range`);
    }
    if (seenSlots.has(slot)) {
      throw new Error(`Aztec validator history contains duplicate slot ${slot} for ${sequencer}`);
    }
    if (previousSlot !== undefined && numericSlot <= previousSlot) {
      throw new Error(`Aztec validator history is not strictly ordered for ${sequencer}`);
    }
    seenSlots.add(slot);
    previousSlot = numericSlot;
    return { slot, status: observation.status };
  });
  if (!Array.isArray(value.allTimeEpochPerformance)) {
    throw new Error(`Aztec all-time epoch performance for ${sequencer} must be an array`);
  }
  const seenEpochs = new Set();
  const allTimeEpochPerformance = value.allTimeEpochPerformance.map((performance, index) => {
    if (!isPlainObject(performance)) {
      throw new Error(`Aztec epoch performance at ${sequencer}[${index}] is invalid`);
    }
    const epoch = parseUnsignedInteger(performance.epoch, `validator epoch at ${sequencer}[${index}]`);
    if (seenEpochs.has(epoch)) {
      throw new Error(`Aztec validator epoch performance contains duplicate epoch ${epoch} for ${sequencer}`);
    }
    seenEpochs.add(epoch);
    const missed = parseSafeInteger(
      performance.missed,
      `validator missed duties at ${sequencer}[${index}]`,
      0,
    );
    const total = parseSafeInteger(
      performance.total,
      `validator total duties at ${sequencer}[${index}]`,
      0,
    );
    if (missed > total) {
      throw new Error(`Aztec validator missed duties exceed total duties at ${sequencer}[${index}]`);
    }
    return {
      epoch,
      missed,
      total,
    };
  });
  const totalSlots = parseSafeInteger(value.validator.totalSlots, 'Aztec validator totalSlots', 0);
  if (totalSlots !== history.length) {
    throw new Error(`Aztec validator totalSlots does not match history length for ${sequencer}`);
  }
  return {
    sequencer,
    history,
    allTimeEpochPerformance,
    lastProcessedSlot: parseOptionalInteger(value.lastProcessedSlot, 'validator stats lastProcessedSlot'),
    initialSlot: parseOptionalInteger(value.initialSlot, 'validator stats initialSlot'),
  };
}

export function parseInactivityConfig(value) {
  if (!isPlainObject(value)) {
    throw new Error('Aztec admin config must be an object');
  }
  const targetPercentage = value.slashInactivityTargetPercentage;
  if (
    typeof targetPercentage !== 'number' ||
    !Number.isFinite(targetPercentage) ||
    targetPercentage < 0 ||
    targetPercentage > 1
  ) {
    throw new Error('Aztec admin slashInactivityTargetPercentage must be between 0 and 1');
  }
  return {
    targetPercentage,
    consecutiveEpochThreshold: parseSafeInteger(
      value.slashInactivityConsecutiveEpochThreshold,
      'Aztec admin slashInactivityConsecutiveEpochThreshold',
      1,
    ),
  };
}

function isExactParams(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function isValidatorStatsParams(params) {
  return Array.isArray(params) &&
    params.length === 3 &&
    /^0x[0-9a-f]{40}$/.test(params[0]) &&
    /^[0-9]+$/.test(params[1]) &&
    /^[0-9]+$/.test(params[2]) &&
    BigInt(params[1]) <= BigInt(params[2]);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseChainId(value) {
  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && (/^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value))) {
    const bigint = BigInt(value);
    if (bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Aztec node info l1ChainId exceeds the safe integer range');
    }
    parsed = Number(bigint);
  } else {
    throw new Error('Aztec node info l1ChainId must be a positive integer');
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Aztec node info l1ChainId must be a positive integer');
  }
  return parsed;
}

function parseAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Aztec ${label} must be a nonzero 20-byte hex address`);
  }
  return value.toLowerCase();
}

function parseOptionalInteger(value, label) {
  if (value === undefined || value === null) return undefined;
  return parseUnsignedInteger(value, label);
}

function parseUnsignedInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && (/^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value))) {
    return BigInt(value).toString();
  }
  throw new Error(`Aztec ${label} must be an unsigned integer`);
}

function parseSafeInteger(value, label, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function parseOptionalUnsignedInteger(value, label) {
  if (value === null) return undefined;
  let parsed;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && (/^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value))) {
    parsed = BigInt(value);
  } else {
    throw new Error(`Aztec node ${label} must be null or an unsigned integer`);
  }
  return parsed.toString();
}

async function readLimitedBody(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} response exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}
