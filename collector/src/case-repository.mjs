import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  RETAINED_OUTCOME_STAGES,
  STAGE_RANK,
  URGENCY_RANK,
  caseIdFor,
  closedCaseCutoff,
  projectCases,
  selectCaseFeed,
  summarizeNetwork,
  transitionFor,
} from '../../shared/protocol/index.ts';
import {
  assertExecutionMatchesContext,
  canAdvanceOffenseAbsence,
  findExecutionForSlash,
  hasAdvancingAbsence,
  historicalRoundObservation,
  nodeOffenseObservation,
  normalizeAddressList,
  normalizeDutyHistory,
  normalizeObservation,
  observationsFromL1Snapshot,
  protocolFromL1Snapshot,
  sentinelObservation,
  slashObservation,
  stakeStatusObservation,
  summarizeDutyHistory,
  transitionEvent,
} from './observations.mjs';
import { initializeSchema } from './schema.mjs';
import {
  address,
  network,
  parseJson,
  positiveInteger,
  stableId,
  toIso,
  truncate,
  unsignedInteger,
  unsignedString,
} from './validate.mjs';

const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TOKEN_RETENTION_MS = 24 * 60 * 60_000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;

export class CaseRepository {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.statements = new Map();
    // Counts writes to the cases table in this process, the database's only
    // writer, so derived responses can be reused until a case changes.
    this.casesVersion = 0;
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      initializeSchema(this.db);
      this.pruneResult = this.pruneSupersededRoundObservations();
      // Open cases stored by an older projection, or before downtime, are
      // brought up to the stored protocol clock without alerting.
      this.clockResult = this.transaction(() =>
        this.reprojectOpenCases({ notify: false }));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure is the error worth surfacing.
      }
      throw error;
    }
  }

  // Databases written before superseded l1_round rows were deleted on
  // reconcile still carry every historical vote-state progression. Remove the
  // rows whose canonical replacement for the same round exists in the same
  // case, and rebuild the affected case projections. Idempotent: after the
  // first run there is nothing left to match.
  pruneSupersededRoundObservations() {
    return this.transaction(() => {
      const rows = this.prepare(`
        SELECT id, observation_json AS observationJson
        FROM observations AS superseded
        WHERE source = 'ethereum_l1' AND kind = 'l1_round' AND canonical = 0
          AND COALESCE(
            json_extract(observation_json, '$.data.historicalExecution'), 0
          ) != 1
          AND EXISTS (
            SELECT 1 FROM observations AS replacement
            WHERE replacement.canonical = 1
              AND replacement.kind = 'l1_round'
              AND replacement.network = superseded.network
              AND replacement.lineage_id = superseded.lineage_id
              AND replacement.sequencer = superseded.sequencer
              AND replacement.target_epoch = superseded.target_epoch
              AND replacement.round = superseded.round
          )
      `).all();
      const affected = new Set();
      for (const row of rows) {
        this.prepare('DELETE FROM observations WHERE id = ?').run(row.id);
        affected.add(caseIdFor(parseJson(row.observationJson, null)));
      }
      const projection = affected.size > 0
        ? this.reprojectCases([...affected], { notify: false })
        : { changed: 0 };
      return { pruned: rows.length, casesChanged: projection.changed };
    });
  }

  bindRuntimeIdentity(identity) {
    const normalized = {
      network: network(identity?.network),
      chainId: positiveInteger(identity?.chainId, 'chain id'),
      registryAddress: address(identity?.registryAddress, 'Registry'),
    };
    return this.transaction(() => {
      const existing = this.prepare(`
        SELECT network, chain_id AS chainId, registry_address AS registryAddress
        FROM runtime_identity WHERE singleton = 1
      `).get();
      if (!existing) {
        this.prepare(`
          INSERT INTO runtime_identity(singleton, network, chain_id, registry_address)
          VALUES (1, ?, ?, ?)
        `).run(normalized.network, normalized.chainId, normalized.registryAddress);
        return normalized;
      }
      if (
        existing.network !== normalized.network ||
        Number(existing.chainId) !== normalized.chainId ||
        existing.registryAddress !== normalized.registryAddress
      ) {
        throw new Error(
          `slashveto.me database belongs to ${existing.network} chain ${existing.chainId} ` +
          `Registry ${existing.registryAddress}`,
        );
      }
      return normalized;
    });
  }

  ensureSource(source) {
    this.prepare('INSERT OR IGNORE INTO source_state(source) VALUES (?)').run(source);
  }

  recordSourceAttempt(source, at = Date.now()) {
    this.ensureSource(source);
    this.prepare(`
      UPDATE source_state SET last_attempt_at = ? WHERE source = ?
    `).run(at, source);
  }

  recordSourceSuccess(source, metadata = {}, at = Date.now(), checkpoint = {}) {
    this.ensureSource(source);
    this.prepare(`
      UPDATE source_state
      SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0,
        successful_polls = successful_polls + 1, last_error = NULL,
        last_block_number = COALESCE(?, last_block_number),
        last_block_hash = COALESCE(?, last_block_hash),
        metadata_json = ?
      WHERE source = ?
    `).run(
      at,
      at,
      checkpoint.blockNumber ?? null,
      checkpoint.blockHash ?? null,
      JSON.stringify(metadata ?? {}),
      source,
    );
  }

  recordSourceFailure(source, error, at = Date.now()) {
    this.ensureSource(source);
    this.prepare(`
      UPDATE source_state
      SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1,
        last_error = ?
      WHERE source = ?
    `).run(at, truncate(error), source);
  }

  getSourceState(source) {
    const row = this.prepare(`
      SELECT source, last_attempt_at AS lastAttemptAt,
        last_success_at AS lastSuccessAt,
        consecutive_failures AS consecutiveFailures,
        successful_polls AS successfulPolls,
        last_error AS lastError,
        last_block_number AS lastBlockNumber,
        last_block_hash AS lastBlockHash,
        metadata_json AS metadataJson
      FROM source_state WHERE source = ?
    `).get(source);
    if (!row) return undefined;
    return {
      ...row,
      metadata: parseJson(row.metadataJson, {}),
    };
  }

  recordAttempt(at = Date.now()) {
    this.recordSourceAttempt('aztec_node', at);
  }

  recordFailure(error, at = Date.now()) {
    this.recordSourceFailure('aztec_node', error, at);
  }

  getSyncState() {
    const state = this.getSourceState('aztec_node');
    return {
      lastAttemptAt: state?.lastAttemptAt ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      consecutiveFailures: Number(state?.consecutiveFailures ?? 0),
      successfulPolls: Number(state?.successfulPolls ?? 0),
      lastError: state?.lastError ?? null,
    };
  }

  getProtocolSnapshot() {
    const row = this.prepare(`
      SELECT snapshot_json AS snapshotJson FROM protocol_snapshot WHERE singleton = 1
    `).get();
    return row ? parseJson(row.snapshotJson, null) : null;
  }

  setProtocolSnapshot(snapshot, at = Date.now()) {
    this.prepare(`
      INSERT INTO protocol_snapshot(singleton, snapshot_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(snapshot), at);
  }

  recordObservations(observations, {
    protocol,
    notify = true,
  } = {}) {
    return this.transaction(() => {
      if (protocol) this.setProtocolSnapshot(protocol, Date.parse(protocol.observedAt));
      return this.insertObservations(observations, { notify });
    });
  }

  insertObservations(observations, {
    notify = true,
    affectedCaseIds = [],
  } = {}) {
    const insert = this.prepare(`
      INSERT INTO observations (
        id, network, source, kind, sequencer, lineage_id, target_epoch,
        slot, round, observed_at, block_number, block_hash, transaction_hash,
        canonical, observation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_at = excluded.observed_at,
        canonical = excluded.canonical,
        observation_json = excluded.observation_json
      WHERE observations.canonical <> excluded.canonical
    `);
    const affected = new Set(affectedCaseIds);
    let inserted = 0;
    for (const input of observations ?? []) {
      const observation = normalizeObservation(input);
      const at = Date.parse(observation.provenance.observedAt);
      const result = insert.run(
        observation.id,
        observation.network,
        observation.source,
        observation.kind,
        observation.sequencer,
        observation.lineageId,
        observation.targetEpoch,
        observation.slot ?? null,
        observation.round ?? null,
        at,
        observation.provenance.blockNumber ?? null,
        observation.provenance.blockHash ?? null,
        observation.provenance.transactionHash ?? null,
        Number(observation.provenance.canonical),
        JSON.stringify(observation),
      );
      if (Number(result.changes) > 0) {
        inserted += 1;
        affected.add(caseIdFor(observation));
      }
    }
    const projection = this.reprojectCases([...affected], { notify });
    return {
      inserted,
      casesChanged: projection.changed,
      transitions: projection.transitions,
      queued: projection.queued,
    };
  }

  reprojectCases(caseIds, { notify = true } = {}) {
    const protocol = this.getProtocolSnapshot();
    let changed = 0;
    let transitions = 0;
    let queued = 0;
    for (const caseId of caseIds) {
      // caseIdFor produces 'case:<network>:<lineage>:<sequencer>:<epoch>';
      // querying by the decomposed columns keeps observations_case_idx usable.
      const [prefix, caseNetwork, lineageId, sequencer, targetEpoch] =
        String(caseId).split(':');
      if (prefix !== 'case' || targetEpoch === undefined) continue;
      const rows = this.prepare(`
        SELECT observation_json AS observationJson
        FROM observations
        WHERE network = ? AND lineage_id = ? AND sequencer = ? AND target_epoch = ?
        ORDER BY observed_at, id
      `).all(caseNetwork, lineageId, sequencer, targetEpoch);
      if (rows.length === 0) continue;
      const observations = rows.map((row) => parseJson(row.observationJson, null));
      const current = projectCases(observations, protocol)[0];
      if (!current) continue;
      const previousRow = this.prepare(`
        SELECT case_json AS caseJson FROM cases WHERE id = ?
      `).get(caseId);
      const previous = previousRow ? parseJson(previousRow.caseJson, null) : null;
      // Deleting a superseded round row can remove a case's earliest
      // observation; the moment the case was first seen must survive that.
      if (previous && previous.firstObservedAt < current.firstObservedAt) {
        current.firstObservedAt = previous.firstObservedAt;
      }
      const currentJson = JSON.stringify(current);
      if (previousRow?.caseJson === currentJson) continue;
      // Without new evidence the change came from protocol time, which the
      // latest snapshot dates.
      const transitionAt = previous?.lastObservedAt === current.lastObservedAt
        ? protocol?.observedAt
        : undefined;
      this.prepare(`
        INSERT INTO cases (
          id, network, sequencer, lineage_id, target_epoch, stage, urgency,
          active, last_observed_at, case_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          stage = excluded.stage,
          urgency = excluded.urgency,
          active = excluded.active,
          last_observed_at = excluded.last_observed_at,
          case_json = excluded.case_json
      `).run(
        current.id,
        current.network,
        current.sequencer,
        current.lineageId,
        current.targetEpoch,
        current.state.stage,
        current.state.urgency,
        Number(current.state.active),
        Date.parse(current.lastObservedAt),
        currentJson,
      );
      changed += 1;
      this.casesVersion += 1;
      const transition = transitionFor(previous, current, transitionAt);
      if (!transition) continue;
      const insertedTransition = this.prepare(`
        INSERT OR IGNORE INTO case_transitions (
          id, case_id, sequencer, observed_at, severity, transition_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        transition.id,
        transition.caseId,
        transition.sequencer,
        Date.parse(transition.observedAt),
        transition.severity,
        JSON.stringify(transition),
      );
      if (Number(insertedTransition.changes) === 0) continue;
      transitions += 1;
      if (notify) queued += this.enqueueTransition(transition, current);
    }
    return { changed, transitions, queued };
  }

  // A voting round closing finalizes its tally and a lifetime ending expires
  // its candidate. Both happen only at round boundaries, when open cases are
  // reprojected against the new clock.
  reprojectOpenCases({ notify = true } = {}) {
    const ids = this.prepare('SELECT id FROM cases WHERE active = 1').all()
      .map((row) => row.id);
    return this.reprojectCases(ids, { notify });
  }

  listCases({
    network: selectedNetwork,
    sequencers = [],
    active,
    closedSince,
  } = {}) {
    const clauses = [];
    const parameters = [];
    if (selectedNetwork) {
      clauses.push('network = ?');
      parameters.push(network(selectedNetwork));
    }
    if (sequencers.length > 0) {
      clauses.push(`sequencer IN (${sequencers.map(() => '?').join(',')})`);
      parameters.push(...sequencers.map((item) => address(item, 'sequencer')));
    }
    if (active !== undefined) {
      clauses.push('active = ?');
      parameters.push(Number(Boolean(active)));
    }
    if (closedSince !== undefined) {
      const outcomes = RETAINED_OUTCOME_STAGES.map(() => '?').join(',');
      clauses.push(`(active = 1 OR stage IN (${outcomes}) OR last_observed_at >= ?)`);
      parameters.push(...RETAINED_OUTCOME_STAGES, closedSince);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.prepare(`
      SELECT case_json AS caseJson FROM cases ${where}
      ORDER BY active DESC, ${rankSql('urgency', URGENCY_RANK)} DESC,
        ${rankSql('stage', STAGE_RANK)} DESC, last_observed_at DESC
    `).all(...parameters).map((row) => parseJson(row.caseJson, null));
  }

  getCase(id) {
    const row = this.prepare(`
      SELECT case_json AS caseJson FROM cases WHERE id = ?
    `).get(id);
    if (!row) return null;
    const item = parseJson(row.caseJson, null);
    const transitions = this.prepare(`
      SELECT transition_json AS transitionJson FROM case_transitions
      WHERE case_id = ? ORDER BY observed_at, id
    `).all(id).map((entry) => parseJson(entry.transitionJson, null));
    return { ...item, transitions };
  }

  getSequencerRecord(sequencer, selectedNetwork) {
    const normalized = address(sequencer, 'sequencer');
    return {
      sequencer: normalized,
      protocol: this.getProtocolSnapshot(),
      cases: this.listCases({
        network: selectedNetwork,
        sequencers: [normalized],
      }),
    };
  }

  // The network feed carries what the case feed renders: every open case and
  // the latest execution outcomes, with a summary of every retained case.
  // Watched sequencers' history comes from getSequencerCases. The feed omits
  // the protocol snapshot and source health: both change every poll and live
  // in /api/status, while this response only changes when a case does.
  getNetworkSummary(selectedNetwork, {
    closedSince = closedCaseCutoff(Date.now()),
  } = {}) {
    const cases = this.listCases({ network: selectedNetwork, closedSince });
    const feed = selectCaseFeed(cases);
    return {
      summary: summarizeNetwork(cases),
      cases: [...feed.active, ...feed.recentlyExecuted],
    };
  }

  // Closed cases that never reached quorum leave after the retention window;
  // getSequencerRecord and getCase keep them.
  getSequencerCases(selectedNetwork, sequencers, {
    closedSince = closedCaseCutoff(Date.now()),
  } = {}) {
    return this.listCases({ network: selectedNetwork, sequencers, closedSince });
  }

  invalidateObservation(row, invalidatedAt) {
    const observation = parseJson(row.observationJson, null);
    observation.provenance.canonical = false;
    observation.provenance.invalidatedAt = toIso(invalidatedAt);
    this.prepare(`
      UPDATE observations SET canonical = 0, observation_json = ? WHERE id = ?
    `).run(JSON.stringify(observation), row.id);
    return observation;
  }

  markMissingL1ObservationsNonCanonical({
    fromBlock,
    toBlock,
    seenIds,
    invalidatedAt = new Date().toISOString(),
  }) {
    const rows = this.prepare(`
      SELECT id, observation_json AS observationJson
      FROM observations
      WHERE source = 'ethereum_l1'
        AND (
          kind IN ('l1_slash', 'stake_status')
          OR (
            kind = 'l1_round'
            AND json_extract(observation_json, '$.data.historicalExecution') = 1
          )
        )
        AND canonical = 1
        AND CAST(block_number AS INTEGER) BETWEEN ? AND ?
    `).all(Number(fromBlock), Number(toBlock));
    const seen = new Set(seenIds);
    const affected = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const observation = this.invalidateObservation(row, invalidatedAt);
      affected.push(caseIdFor(observation));
    }
    return this.reprojectCases([...new Set(affected)], { notify: true });
  }

  recordSuccessfulPoll(offenses, {
    observedAt = Date.now(),
    withdrawAfterMissedPolls = 3,
    network: selectedNetwork = 'mainnet',
    absenceEvidence,
    syncCursor,
    degradedError,
  } = {}) {
    return this.transaction(() => {
      const source = this.getSourceState('aztec_node');
      const sequence = Number(source?.successfulPolls ?? 0) + 1;
      const protocol = this.getProtocolSnapshot();
      const activeLineage = protocol?.lineages?.find((item) => item.role === 'active');
      if (!protocol || !activeLineage) {
        throw new Error('Cannot record node offenses before the canonical L1 lineage');
      }
      const epochDuration = positiveInteger(protocol.epochDurationSlots, 'epoch duration');
      const observations = [];
      let inserted = 0;
      let updated = 0;
      let reactivated = 0;

      for (const offense of offenses) {
        const existing = this.prepare(`
          SELECT offense_json AS offenseJson, status FROM offense_state WHERE id = ?
        `).get(offense.id);
        const offenseJson = JSON.stringify(offense);
        let changed = false;
        if (!existing) {
          inserted += 1;
          changed = true;
        } else if (existing.status === 'withdrawn') {
          reactivated += 1;
          changed = true;
        } else if (existing.offenseJson !== offenseJson) {
          updated += 1;
          changed = true;
        }
        this.prepare(`
          INSERT INTO offense_state (
            id, offense_json, status, missed_polls, last_seen_sequence, updated_at
          ) VALUES (?, ?, 'active', 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            offense_json = excluded.offense_json,
            status = 'active',
            missed_polls = 0,
            last_seen_sequence = excluded.last_seen_sequence,
            updated_at = excluded.updated_at
        `).run(offense.id, offenseJson, sequence, observedAt);
        if (changed) {
          observations.push(nodeOffenseObservation({
            offense,
            status: 'active',
            protocol,
            lineage: activeLineage,
            epochDuration,
            network: selectedNetwork,
            observedAt,
          }));
        }
      }

      let withdrawn = 0;
      if (hasAdvancingAbsence(absenceEvidence)) {
        const missing = this.prepare(`
          SELECT id, offense_json AS offenseJson, missed_polls AS missedPolls
          FROM offense_state WHERE status = 'active' AND last_seen_sequence < ?
        `).all(sequence);
        for (const row of missing) {
          const offense = parseJson(row.offenseJson, null);
          if (!canAdvanceOffenseAbsence(offense, absenceEvidence)) continue;
          const missedPolls = Number(row.missedPolls) + 1;
          const status = missedPolls >= withdrawAfterMissedPolls ? 'withdrawn' : 'active';
          this.prepare(`
            UPDATE offense_state SET missed_polls = ?, status = ?, updated_at = ?
            WHERE id = ?
          `).run(missedPolls, status, observedAt, row.id);
          if (status === 'withdrawn') {
            withdrawn += 1;
            observations.push(nodeOffenseObservation({
              offense,
              status,
              protocol,
              lineage: activeLineage,
              epochDuration,
              network: selectedNetwork,
              observedAt,
            }));
          }
        }
      }

      if (syncCursor !== undefined) {
        this.recordSourceSuccess('aztec_sync', syncCursor, observedAt);
      }
      const projection = this.insertObservations(observations);
      if (degradedError) {
        this.recordSourceFailure('aztec_node', degradedError, observedAt);
      } else {
        this.recordSourceSuccess('aztec_node', {
          observed: offenses.length,
          sequence,
        }, observedAt);
      }
      return {
        sequence,
        observed: offenses.length,
        inserted,
        updated,
        reactivated,
        withdrawn,
        transitions: projection.transitions,
        queued: projection.queued,
        degraded: Boolean(degradedError),
        ...(degradedError ? { error: truncate(degradedError) } : {}),
      };
    });
  }

  getValidatorIndexCursor() {
    const row = this.prepare(`
      SELECT epoch, coverage_generation AS coverageGeneration
      FROM sentinel_epoch_index ORDER BY epoch DESC LIMIT 1
    `).get();
    return row
      ? { epoch: Number(row.epoch), coverageGeneration: Number(row.coverageGeneration) }
      : undefined;
  }

  recordValidatorEpoch(epochSnapshot, inactivityConfig, {
    epochDuration,
    network: selectedNetwork,
    observedAt = Date.now(),
    bootstrap = false,
    coverageGeneration = 0,
  }) {
    const protocol = this.getProtocolSnapshot();
    const lineage = protocol?.lineages?.find((item) => item.role === 'active');
    if (!protocol || !lineage) throw new Error('Canonical L1 lineage is unavailable');
    const epoch = unsignedInteger(epochSnapshot?.epoch, 'validator epoch');
    const duration = positiveInteger(epochDuration, 'epoch duration');
    const fromSlot = unsignedInteger(epochSnapshot?.fromSlot, 'epoch from slot');
    const toSlot = unsignedInteger(epochSnapshot?.toSlot, 'epoch to slot');
    if (fromSlot !== epoch * duration || toSlot !== fromSlot + duration - 1) {
      throw new Error(`validator epoch ${epoch} does not match its slot range`);
    }
    const committee = (epochSnapshot?.committee ?? []).map((item) => address(item, 'committee member'));
    if (committee.length === 0 || new Set(committee).size !== committee.length) {
      throw new Error(`validator epoch ${epoch} has an invalid committee`);
    }
    const targetPercentage = Number(inactivityConfig?.targetPercentage);
    const threshold = positiveInteger(
      inactivityConfig?.consecutiveEpochThreshold,
      'inactivity threshold',
    );
    if (!Number.isFinite(targetPercentage) || targetPercentage < 0 || targetPercentage > 1) {
      throw new Error('inactivity target percentage must be between 0 and 1');
    }
    const responseByAddress = new Map();
    let minimumProcessedSlot;
    for (const response of epochSnapshot?.validators ?? []) {
      const sequencer = address(response?.sequencer, 'validator response');
      if (!committee.includes(sequencer) || responseByAddress.has(sequencer)) {
        throw new Error(`unexpected validator response for ${sequencer}`);
      }
      const lastProcessed = unsignedInteger(
        response?.lastProcessedSlot,
        `last processed slot for ${sequencer}`,
      );
      if (lastProcessed < toSlot) {
        throw new Error(`Sentinel has not completed epoch ${epoch} for ${sequencer}`);
      }
      minimumProcessedSlot = minimumProcessedSlot === undefined
        ? lastProcessed
        : Math.min(minimumProcessedSlot, lastProcessed);
      const history = normalizeDutyHistory(response?.history, {
        sequencer,
        fromSlot,
        toSlot,
      });
      const summary = summarizeDutyHistory(history);
      const aggregate = (response?.allTimeEpochPerformance ?? []).find(
        (item) => unsignedInteger(item?.epoch, 'performance epoch') === epoch,
      );
      if (
        !aggregate ||
        unsignedInteger(aggregate.missed, 'aggregate missed') !== summary.missed ||
        unsignedInteger(aggregate.total, 'aggregate total') !== summary.total
      ) {
        throw new Error(`Sentinel history disagrees with epoch ${epoch} aggregate for ${sequencer}`);
      }
      responseByAddress.set(sequencer, { history, ...summary });
    }
    if (responseByAddress.size === 0 || minimumProcessedSlot === undefined) {
      throw new Error(`Sentinel returned no evaluated data for epoch ${epoch}`);
    }

    return this.transaction(() => {
      if (this.prepare('SELECT 1 FROM sentinel_epoch_index WHERE epoch = ?').get(epoch)) {
        throw new Error(`validator epoch ${epoch} is already indexed`);
      }
      const observations = [];
      let inactiveEpochs = 0;
      let dutiesInserted = 0;
      for (const sequencer of committee) {
        const performance = responseByAddress.get(sequencer) ?? {
          history: [],
          missed: 0,
          total: 0,
          firstMissedSlot: null,
          lastMissedSlot: null,
        };
        dutiesInserted += performance.history.length;
        const inactive = performance.total > 0 &&
          performance.missed / performance.total >= targetPercentage;
        const prior = this.prepare(`
          SELECT inactive, streak FROM sentinel_performance
          WHERE sequencer = ? AND epoch < ? AND coverage_generation = ?
          ORDER BY epoch DESC LIMIT 1
        `).get(sequencer, epoch, coverageGeneration);
        const streak = inactive ? (Number(prior?.inactive) ? Number(prior.streak) + 1 : 1) : 0;
        this.prepare(`
          INSERT INTO sentinel_performance (
            sequencer, epoch, missed, total, inactive, streak, threshold,
            target_percentage, coverage_generation, first_missed_slot,
            last_missed_slot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sequencer,
          epoch,
          performance.missed,
          performance.total,
          Number(inactive),
          streak,
          threshold,
          targetPercentage,
          coverageGeneration,
          performance.firstMissedSlot,
          performance.lastMissedSlot,
        );
        if (performance.firstMissedSlot !== null) {
          observations.push(sentinelObservation({
            kind: 'duty_miss',
            network: selectedNetwork,
            lineage,
            sequencer,
            epoch,
            observedAt,
            l1BlockNumber: epochSnapshot.l1BlockNumber,
            l1BlockHash: epochSnapshot.l1BlockHash,
            data: {
              epoch,
              slot: String(performance.firstMissedSlot),
              status: performance.history.find((item) =>
                item.slot === performance.firstMissedSlot)?.status ?? 'missed',
            },
          }));
        }
        if (inactive) {
          inactiveEpochs += 1;
          observations.push(sentinelObservation({
            kind: 'inactivity_epoch',
            network: selectedNetwork,
            lineage,
            sequencer,
            epoch,
            observedAt,
            l1BlockNumber: epochSnapshot.l1BlockNumber,
            l1BlockHash: epochSnapshot.l1BlockHash,
            data: {
              epoch,
              missed: performance.missed,
              total: performance.total,
              firstMissedSlot: performance.firstMissedSlot === null
                ? null
                : String(performance.firstMissedSlot),
              lastMissedSlot: performance.lastMissedSlot === null
                ? null
                : String(performance.lastMissedSlot),
              streak,
              threshold,
              targetPercentage,
            },
          }));
        }
      }
      this.prepare(`
        INSERT INTO sentinel_epoch_index(epoch, coverage_generation, indexed_at)
        VALUES (?, ?, ?)
      `).run(epoch, coverageGeneration, observedAt);
      const snapshot = {
        ...protocol,
        inactivity: {
          targetPercentage,
          consecutiveEpochs: threshold,
        },
      };
      this.setProtocolSnapshot(snapshot, observedAt);
      const projection = this.insertObservations(observations, { notify: !bootstrap });
      return {
        epoch: String(epoch),
        committeeSize: committee.length,
        validatorsWithHistory: responseByAddress.size,
        dutiesInserted,
        epochsFinalized: committee.length,
        inactiveEpochs,
        transitions: projection.transitions,
        nodeLastProcessedSlot: String(minimumProcessedSlot),
        coverageGeneration,
      };
    });
  }

  recordSuccessfulL1Snapshot(selectedNetwork, snapshot, {
    observedAt = Date.now(),
  } = {}) {
    return this.transaction(() => {
      const previous = this.getProtocolSnapshot();
      const protocol = protocolFromL1Snapshot(
        selectedNetwork,
        snapshot,
        previous?.inactivity ?? null,
      );
      this.setProtocolSnapshot(protocol, observedAt);
      const observations = observationsFromL1Snapshot(selectedNetwork, snapshot, protocol);
      const reconciled = this.reconcileL1RoundObservations(snapshot, observations);
      const projection = this.insertObservations(observations, {
        affectedCaseIds: reconciled,
      });
      const clockProjection = roundClock(previous) === roundClock(protocol)
        ? { changed: 0, transitions: 0, queued: 0 }
        : this.reprojectOpenCases();
      const metadata = {
        rollupAddress: snapshot.rollupAddress,
        currentSlot: snapshot.currentSlot,
        currentEpoch: snapshot.currentEpoch,
        epochDuration: snapshot.epochDuration,
        slotDuration: snapshot.slotDuration,
        protocol,
        roundCursors: snapshot.stacks.flatMap((stack) =>
          stack.rounds.map((round) => ({
            proposerAddress: stack.proposerAddress,
            round: round.round,
            ballotCount: round.ballotCount,
            earlyTargets: round.earlyTargets,
          }))),
      };
      this.recordSourceSuccess('l1', metadata, observedAt, {
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
      });
      return {
        changed: projection.casesChanged + clockProjection.changed,
        transitions: projection.transitions + clockProjection.transitions,
        queued: projection.queued + clockProjection.queued,
      };
    });
  }

  // A fresh snapshot supersedes the stored vote-state row of every covered
  // round it re-reports with different data. Superseded rows are deleted:
  // they are poll-cadence progressions of the same round, not independent
  // chain evidence, and retaining them made cases grow without bound. A row
  // whose target vanished from a covered round is different — that evidence
  // was removed on L1, so it is kept as a non-canonical correction.
  // Historical execution rows come from Slashed logs and are only ever
  // invalidated by the reorg path, never replaced by a newer snapshot.
  reconcileL1RoundObservations(snapshot, current) {
    const seen = new Set(current.map((item) => item.id));
    const replaced = new Set(current.map((item) =>
      `${item.lineageId}:${item.round}:${item.sequencer}:${item.targetEpoch}`));
    const coverage = new Set((snapshot.stacks ?? []).flatMap((stack) =>
      (stack.rounds ?? []).map((round) =>
        `${address(stack.proposerAddress, 'SlashingProposer')}:${unsignedString(round.round, 'round')}`)));
    if (coverage.size === 0) return [];
    const rows = this.prepare(`
      SELECT id, lineage_id AS lineageId, round, sequencer,
        target_epoch AS targetEpoch, observation_json AS observationJson
      FROM observations
      WHERE source = 'ethereum_l1' AND kind = 'l1_round' AND canonical = 1
    `).all();
    const affected = new Set();
    for (const row of rows) {
      if (!coverage.has(`${row.lineageId}:${row.round}`) || seen.has(row.id)) continue;
      const observation = parseJson(row.observationJson, null);
      if (observation?.data?.historicalExecution) continue;
      const key = `${row.lineageId}:${row.round}:${row.sequencer}:${row.targetEpoch}`;
      if (replaced.has(key)) {
        this.prepare('DELETE FROM observations WHERE id = ?').run(row.id);
        affected.add(caseIdFor(observation));
      } else {
        this.invalidateObservation(row, snapshot.blockTimestamp ?? snapshot.observedAt);
        affected.add(caseIdFor(observation));
      }
    }
    return [...affected];
  }

  recordSuccessfulL1SlashLogChunk(selectedNetwork, chunk, {
    observedAt = Date.now(),
  } = {}) {
    return this.transaction(() => {
      const observations = [];
      const seenIds = [];
      for (const log of chunk.logs ?? []) {
        let execution = findExecutionForSlash(this.db, log);
        if (execution) {
          assertExecutionMatchesContext(execution, log);
        } else if (log.executionContext) {
          execution = historicalRoundObservation({
            network: selectedNetwork,
            log,
            observedAt,
          });
          observations.push(execution);
          seenIds.push(execution.id);
        }
        const observation = slashObservation({
          network: selectedNetwork,
          log,
          execution,
          observedAt,
        });
        observations.push(observation);
        seenIds.push(observation.id);
        if (log.ejected) {
          const stakeStatus = stakeStatusObservation({
            slash: observation,
            status: log.attesterStatus,
          });
          observations.push(stakeStatus);
          seenIds.push(stakeStatus.id);
        }
      }
      let corrections = 0;
      if (chunk.reorgDetected) {
        const correction = this.markMissingL1ObservationsNonCanonical({
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
          seenIds,
          invalidatedAt: observedAt,
        });
        corrections = correction.changed;
      }
      const projection = this.insertObservations(observations, {
        notify: !chunk.initialBackfill,
      });
      this.recordSourceSuccess('l1_slash_logs', {
        initialBackfill: Boolean(chunk.initialBackfill && chunk.hasMore),
        backfillStartBlock: chunk.backfillStartBlock ?? null,
        confirmedBlockNumber: chunk.confirmedBlockNumber,
        rollupAddresses: chunk.rollupAddresses,
      }, observedAt, {
        blockNumber: chunk.toBlock,
        blockHash: chunk.toBlockHash,
      });
      return {
        inserted: projection.inserted,
        queued: projection.queued,
        corrections,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
        hasMore: chunk.hasMore,
        reorgDetected: chunk.reorgDetected,
      };
    });
  }

  createWatch({
    id = randomUUID(),
    managementTokenHash,
    network: selectedNetwork,
    addresses,
    now = Date.now(),
  }) {
    const normalizedAddresses = normalizeAddressList(addresses);
    return this.transaction(() => {
      this.prepare(`
        INSERT INTO watches(id, management_token_hash, network, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, managementTokenHash, network(selectedNetwork), now, now);
      this.replaceWatchAddresses(id, normalizedAddresses);
      return this.getWatch(id);
    });
  }

  getWatch(id) {
    const row = this.prepare(`
      SELECT id, management_token_hash AS managementTokenHash, network,
        created_at AS createdAt, updated_at AS updatedAt
      FROM watches WHERE id = ?
    `).get(id);
    if (!row) return null;
    const addresses = this.prepare(`
      SELECT sequencer FROM watch_addresses WHERE watch_id = ? ORDER BY sequencer
    `).all(id).map((item) => item.sequencer);
    const endpoints = this.prepare(`
      SELECT id, kind, enabled, verified, created_at AS createdAt,
        updated_at AS updatedAt
      FROM delivery_endpoints WHERE watch_id = ? ORDER BY kind
    `).all(id).map((item) => ({
      ...item,
      enabled: Boolean(item.enabled),
      verified: Boolean(item.verified),
    }));
    return { ...row, addresses, endpoints };
  }

  updateWatch(id, { addresses, now = Date.now() } = {}) {
    return this.transaction(() => {
      const current = this.getWatch(id);
      if (!current) return null;
      if (addresses !== undefined) {
        this.replaceWatchAddresses(id, normalizeAddressList(addresses));
        this.prepare('UPDATE watches SET updated_at = ? WHERE id = ?').run(now, id);
        this.deleteUnmatchedDeliveries(id);
      }
      return this.getWatch(id);
    });
  }

  deleteWatch(id) {
    return Number(this.prepare('DELETE FROM watches WHERE id = ?').run(id).changes) > 0;
  }

  replaceWatchAddresses(id, addresses) {
    this.prepare('DELETE FROM watch_addresses WHERE watch_id = ?').run(id);
    const insert = this.prepare(`
      INSERT INTO watch_addresses(watch_id, sequencer) VALUES (?, ?)
    `);
    for (const sequencer of addresses) insert.run(id, sequencer);
  }

  deleteUnmatchedDeliveries(watchId) {
    this.prepare(`
      DELETE FROM deliveries
      WHERE status IN ('pending', 'leased')
        AND endpoint_id IN (
          SELECT endpoint.id FROM delivery_endpoints endpoint
          WHERE endpoint.watch_id = ?
        )
        AND json_extract(event_json, '$.source') = 'case'
        AND NOT EXISTS (
          SELECT 1 FROM watch_addresses watched
          WHERE watched.watch_id = ?
            AND watched.sequencer =
              lower(json_extract(deliveries.event_json, '$.data.sequencer'))
        )
    `).run(watchId, watchId);
  }

  upsertEndpoint({
    watchId,
    kind,
    destination = null,
    configJson = null,
    now = Date.now(),
  }) {
    if (!['web_push', 'telegram'].includes(kind)) {
      throw new Error(`Unsupported notification channel: ${kind}`);
    }
    if (!this.getWatch(watchId)) return null;
    const id = stableId('endpoint', watchId, kind);
    this.prepare(`
      INSERT INTO delivery_endpoints(
        id, watch_id, kind, destination, config_json, enabled, verified,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(watch_id, kind) DO UPDATE SET
        destination = excluded.destination,
        config_json = excluded.config_json,
        enabled = 1,
        verified = 1,
        updated_at = excluded.updated_at
    `).run(id, watchId, kind, destination, configJson, now, now);
    return this.getWatch(watchId);
  }

  deleteEndpoint(watchId, kind) {
    return Number(this.prepare(`
      DELETE FROM delivery_endpoints WHERE watch_id = ? AND kind = ?
    `).run(watchId, kind).changes) > 0;
  }

  createTelegramLink({ tokenHash, watchId, expiresAt, now = Date.now() }) {
    return this.transaction(() => {
      this.prepare('DELETE FROM telegram_links WHERE expires_at <= ? OR watch_id = ?')
        .run(now, watchId);
      this.prepare(`
        INSERT INTO telegram_links(token_hash, watch_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, watchId, expiresAt, now);
      return { expiresAt };
    });
  }

  consumeTelegramLink(tokenHash, chatId, now = Date.now()) {
    return this.transaction(() => {
      const link = this.prepare(`
        SELECT watch_id AS watchId FROM telegram_links
        WHERE token_hash = ? AND expires_at > ?
      `).get(tokenHash, now);
      if (!link) return null;
      this.prepare(`
        DELETE FROM delivery_endpoints
        WHERE kind = 'telegram' AND destination = ?
      `).run(String(chatId));
      const endpointId = stableId('endpoint', link.watchId, 'telegram');
      this.prepare(`
        INSERT INTO delivery_endpoints(
          id, watch_id, kind, destination, config_json, enabled, verified,
          created_at, updated_at
        ) VALUES (?, ?, 'telegram', ?, NULL, 1, 1, ?, ?)
        ON CONFLICT(watch_id, kind) DO UPDATE SET
          destination = excluded.destination, enabled = 1, verified = 1,
          updated_at = excluded.updated_at
      `).run(endpointId, link.watchId, String(chatId), now, now);
      this.prepare('DELETE FROM telegram_links WHERE token_hash = ?').run(tokenHash);
      return this.getWatch(link.watchId);
    });
  }

  getWatchByTelegramChat(chatId) {
    const endpoint = this.prepare(`
      SELECT watch_id AS watchId, enabled FROM delivery_endpoints
      WHERE kind = 'telegram' AND destination = ?
    `).get(String(chatId));
    if (!endpoint) return null;
    const watch = this.getWatch(endpoint.watchId);
    return watch ? { ...watch, telegramEnabled: Boolean(endpoint.enabled) } : null;
  }

  setTelegramEndpointEnabled(chatId, enabled, now = Date.now()) {
    const result = this.prepare(`
      UPDATE delivery_endpoints SET enabled = ?, updated_at = ?
      WHERE kind = 'telegram' AND destination = ?
    `).run(Number(Boolean(enabled)), now, String(chatId));
    if (!enabled) {
      this.prepare(`
        DELETE FROM deliveries WHERE status IN ('pending', 'leased')
          AND endpoint_id IN (
            SELECT id FROM delivery_endpoints
            WHERE kind = 'telegram' AND destination = ?
          )
      `).run(String(chatId));
    }
    return Number(result.changes) > 0;
  }

  deleteTelegramEndpoint(chatId) {
    return Number(this.prepare(`
      DELETE FROM delivery_endpoints
      WHERE kind = 'telegram' AND destination = ?
    `).run(String(chatId)).changes) > 0;
  }

  getTelegramOffset() {
    return this.prepare(`
      SELECT update_offset AS offset FROM telegram_state WHERE singleton = 1
    `).get()?.offset ?? undefined;
  }

  setTelegramOffset(offset) {
    this.prepare(`
      UPDATE telegram_state SET update_offset = ? WHERE singleton = 1
    `).run(offset);
  }

  enqueueTransition(transition, currentCase) {
    const endpoints = this.prepare(`
      SELECT endpoint.id
      FROM delivery_endpoints endpoint
      JOIN watch_addresses watched ON watched.watch_id = endpoint.watch_id
      WHERE watched.sequencer = ? AND endpoint.enabled = 1
    `).all(transition.sequencer);
    if (endpoints.length === 0) return 0;
    const event = transitionEvent(transition, currentCase);
    const createdAt = Date.parse(transition.observedAt);
    const insert = this.prepare(`
      INSERT OR IGNORE INTO deliveries(
        id, endpoint_id, transition_id, status, attempts, next_attempt_at,
        event_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `);
    let queued = 0;
    for (const endpoint of endpoints) {
      queued += Number(insert.run(
        stableId('delivery', transition.id, endpoint.id),
        endpoint.id,
        transition.id,
        createdAt,
        JSON.stringify(event),
        createdAt,
        createdAt,
      ).changes);
    }
    return queued;
  }

  enqueueWatchTest(watchId, now = Date.now()) {
    const watch = this.getWatch(watchId);
    if (!watch) return 0;
    const endpoints = this.prepare(`
      SELECT id FROM delivery_endpoints WHERE watch_id = ? AND enabled = 1
    `).all(watchId);
    const event = {
      id: `test:${randomUUID()}`,
      network: watch.network,
      source: 'test',
      type: 'notification_test',
      severity: 'info',
      title: 'slashveto.me notifications are connected',
      body: `Watching ${watch.addresses.length} sequencer${watch.addresses.length === 1 ? '' : 's'}.`,
      targets: watch.addresses,
      data: { watchId },
      observedAt: new Date(now).toISOString(),
    };
    const insert = this.prepare(`
      INSERT INTO deliveries(
        id, endpoint_id, transition_id, status, attempts, next_attempt_at,
        event_json, created_at, updated_at
      ) VALUES (?, ?, NULL, 'pending', 0, ?, ?, ?, ?)
    `);
    for (const endpoint of endpoints) {
      insert.run(
        stableId('delivery-test', event.id, endpoint.id),
        endpoint.id,
        now,
        JSON.stringify(event),
        now,
        now,
      );
    }
    return endpoints.length;
  }

  recoverStuckDeliveries(cutoff) {
    return Number(this.prepare(`
      UPDATE deliveries SET status = 'pending', next_attempt_at = ?,
        leased_until = NULL, updated_at = ? WHERE status = 'leased'
        AND leased_until <= ?
    `).run(cutoff, cutoff, cutoff).changes);
  }

  claimDeliveries({ now = Date.now(), limit = 50, leaseMs = 120_000 } = {}) {
    return this.transaction(() => {
      this.recoverStuckDeliveries(now);
      const rows = this.prepare(`
        WITH due AS (
          SELECT delivery.id, delivery.endpoint_id,
            CASE json_extract(delivery.event_json, '$.severity')
              WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END AS priority,
            ROW_NUMBER() OVER (
              PARTITION BY delivery.endpoint_id
              ORDER BY
                CASE json_extract(delivery.event_json, '$.severity')
                  WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                delivery.next_attempt_at, delivery.created_at
            ) AS endpoint_rank
          FROM deliveries delivery
          JOIN delivery_endpoints endpoint ON endpoint.id = delivery.endpoint_id
          WHERE delivery.status = 'pending' AND delivery.next_attempt_at <= ?
            AND endpoint.enabled = 1
            AND NOT EXISTS (
              SELECT 1 FROM deliveries active
              WHERE active.endpoint_id = delivery.endpoint_id
                AND active.status = 'leased'
            )
        )
        SELECT id FROM due WHERE endpoint_rank = 1
        ORDER BY priority, id LIMIT ?
      `).all(now, limit);
      const lease = this.prepare(`
        UPDATE deliveries SET status = 'leased', attempts = attempts + 1,
          leased_until = ?, updated_at = ? WHERE id = ?
      `);
      for (const row of rows) lease.run(now + leaseMs, now, row.id);
      return rows.map((row) => this.getDelivery(row.id)).filter(Boolean);
    });
  }

  getDelivery(id) {
    const row = this.prepare(`
      SELECT delivery.id, delivery.endpoint_id AS endpointId, delivery.attempts,
        endpoint.kind, endpoint.destination,
        endpoint.config_json AS endpointConfig, delivery.event_json AS eventJson
      FROM deliveries delivery
      JOIN delivery_endpoints endpoint ON endpoint.id = delivery.endpoint_id
      WHERE delivery.id = ?
    `).get(id);
    return row ? { ...row, event: parseJson(row.eventJson, {}) } : null;
  }

  isDeliverySendable(id) {
    return Boolean(this.prepare(`
      SELECT 1 FROM deliveries delivery
      JOIN delivery_endpoints endpoint ON endpoint.id = delivery.endpoint_id
      WHERE delivery.id = ? AND delivery.status = 'leased'
        AND endpoint.enabled = 1
    `).get(id));
  }

  completeDelivery(id, providerMessageId, now = Date.now()) {
    return Number(this.prepare(`
      UPDATE deliveries SET status = 'sent', leased_until = NULL,
        provider_message_id = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased'
    `).run(providerMessageId, now, id).changes) > 0;
  }

  retryDelivery(id, error, nextAttemptAt, now = Date.now()) {
    return Number(this.prepare(`
      UPDATE deliveries SET status = 'pending', next_attempt_at = ?,
        leased_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'leased'
    `).run(nextAttemptAt, truncate(error), now, id).changes) > 0;
  }

  retryDeliveryForChannelFailure(id, channel, error, nextAttemptAt, now = Date.now()) {
    const retried = this.retryDelivery(id, error, nextAttemptAt, now);
    this.recordSourceFailure(channel, error, now);
    return retried;
  }

  failDelivery(id, error, now = Date.now()) {
    return Number(this.prepare(`
      UPDATE deliveries SET status = 'failed', leased_until = NULL,
        last_error = ?, updated_at = ? WHERE id = ? AND status = 'leased'
    `).run(truncate(error), now, id).changes) > 0;
  }

  failDeliveryForChannelFailure(id, channel, error, now = Date.now()) {
    const failed = this.failDelivery(id, error, now);
    this.recordSourceFailure(channel, error, now);
    return failed;
  }

  failDeliveryAndDisableEndpoint(id, endpointId, error, now = Date.now()) {
    return this.transaction(() => {
      const failed = this.failDelivery(id, error, now);
      if (!failed) return false;
      this.prepare(`
        UPDATE delivery_endpoints SET enabled = 0, updated_at = ?
        WHERE id = ?
      `).run(now, endpointId);
      this.prepare(`
        UPDATE deliveries SET status = 'failed', leased_until = NULL,
          last_error = ?, updated_at = ?
        WHERE endpoint_id = ? AND status IN ('pending', 'leased')
      `).run('Endpoint disabled after a permanent delivery failure', now, endpointId);
      return true;
    });
  }

  // Hourly retention maintenance, run by the delivery worker.
  pruneExpiredData({ now = Date.now() } = {}) {
    return {
      ...this.pruneNotificationData({ now }),
      ...this.pruneHistory({ now }),
    };
  }

  // A closed case that never reached quorum leaves the API feeds after a week
  // and is deleted, with its evidence and transitions, after
  // HISTORY_RETENTION_MS. Sentinel duty rows are deleted after the same time,
  // except the newest indexed epoch, which is the Sentinel cursor.
  pruneHistory({ now = Date.now() } = {}) {
    const cutoff = now - HISTORY_RETENTION_MS;
    return this.transaction(() => {
      const outcomes = RETAINED_OUTCOME_STAGES.map(() => '?').join(',');
      const expired = this.prepare(`
        SELECT id, network, lineage_id AS lineageId, sequencer,
          target_epoch AS targetEpoch
        FROM cases
        WHERE active = 0 AND stage NOT IN (${outcomes}) AND last_observed_at < ?
      `).all(...RETAINED_OUTCOME_STAGES, cutoff);
      let observations = 0;
      for (const item of expired) {
        observations += Number(this.prepare(`
          DELETE FROM observations
          WHERE network = ? AND lineage_id = ? AND sequencer = ? AND target_epoch = ?
        `).run(item.network, item.lineageId, item.sequencer, item.targetEpoch).changes);
        this.prepare('DELETE FROM cases WHERE id = ?').run(item.id);
      }
      if (expired.length > 0) this.casesVersion += 1;

      const lastEpoch = this.prepare(`
        SELECT MAX(epoch) AS epoch FROM sentinel_epoch_index
        WHERE indexed_at < ?
          AND epoch < (SELECT MAX(epoch) FROM sentinel_epoch_index)
      `).get(cutoff).epoch;
      const sentinelRows = lastEpoch === null ? 0 : Number(this.prepare(`
        DELETE FROM sentinel_performance WHERE epoch <= ?
      `).run(lastEpoch).changes);
      const sentinelEpochs = lastEpoch === null ? 0 : Number(this.prepare(`
        DELETE FROM sentinel_epoch_index WHERE epoch <= ?
      `).run(lastEpoch).changes);
      return { cases: expired.length, observations, sentinelEpochs, sentinelRows };
    });
  }

  pruneNotificationData({ now = Date.now() } = {}) {
    return this.transaction(() => ({
      deliveries: Number(this.prepare(`
        DELETE FROM deliveries WHERE status IN ('sent', 'failed') AND updated_at < ?
      `).run(now - DELIVERY_RETENTION_MS).changes),
      telegramLinks: Number(this.prepare(`
        DELETE FROM telegram_links WHERE expires_at < ?
      `).run(now - TOKEN_RETENTION_MS).changes),
    }));
  }
}

function roundClock(protocol) {
  return (protocol?.lineages ?? [])
    .map((lineage) => `${lineage.proposerAddress}:${lineage.currentRound}`)
    .join(',');
}

// Renders a shared rank table (URGENCY_RANK / STAGE_RANK) as a SQL CASE
// expression so list ordering can never drift from compareCases.
function rankSql(column, ranks) {
  const whens = Object.entries(ranks)
    .map(([key, rank]) => `WHEN '${key}' THEN ${rank}`)
    .join(' ');
  return `CASE ${column} ${whens} ELSE -1 END`;
}
