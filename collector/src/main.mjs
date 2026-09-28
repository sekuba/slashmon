import { AztecAdminClient } from './admin-client.mjs';
import { CaseApiServer } from './case-api-server.mjs';
import {
  WebPushChannel,
  TelegramChannel,
  TelegramClient,
  TelegramSendScheduler,
} from './channels.mjs';
import { OffenseCollector } from './collector.mjs';
import { loadConfig } from './config.mjs';
import { CaseRepository } from './case-repository.mjs';
import { DeliveryWorker } from './delivery-worker.mjs';
import { L1Collector } from './l1-collector.mjs';
import { L1Scanner } from './l1-scanner.mjs';
import { Logger, errorMessage } from './logger.mjs';
import { SentinelCollector } from './sentinel-collector.mjs';
import { TelegramBot } from './telegram-bot.mjs';

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const repository = new CaseRepository(config.databasePath);
  if (repository.pruneResult?.pruned > 0) {
    logger.info('Pruned superseded L1 round observations', repository.pruneResult);
  }
  if (repository.clockResult?.changed > 0) {
    logger.info('Reprojected open cases against the protocol clock', repository.clockResult);
  }
  try {
    repository.bindRuntimeIdentity({
      network: config.network,
      chainId: config.l1ChainId,
      registryAddress: config.l1RegistryAddress,
    });
  } catch (error) {
    repository.close();
    throw error;
  }

  const adminClient = new AztecAdminClient({
    url: config.adminUrl,
    nodeUrl: config.nodeUrl,
    apiKey: config.adminApiKey,
    nodeApiKey: config.nodeApiKey,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxSingleValidatorStatsResponseBytes: config.maxSingleValidatorStatsResponseBytes,
    maxOffenses: config.maxOffensesPerPoll,
  });
  const offenseCollector = new OffenseCollector({
    client: adminClient,
    repository,
    network: config.network,
    expectedChainId: config.l1ChainId,
    expectedRegistryAddress: config.l1RegistryAddress,
    syncMaxL1AgeMs: config.syncMaxL1AgeMs,
    syncMaxL2StallMs: config.syncMaxL2StallMs,
    syncMaxFutureSkewMs: config.l1MaxFutureSkewMs,
    pollIntervalMs: config.pollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    withdrawAfterMissedPolls: config.withdrawAfterMissedPolls,
    logger,
  });
  const l1Scanner = new L1Scanner({
    rpcUrls: config.l1RpcUrls,
    chainId: config.l1ChainId,
    registryAddress: config.l1RegistryAddress,
    confirmations: config.l1Confirmations,
    requestTimeoutMs: config.l1RequestTimeoutMs,
    snapshotTimeoutMs: config.l1SnapshotTimeoutMs,
    maxHeadAgeMs: config.l1MaxHeadAgeMs,
    maxHeadStallMs: config.l1MaxHeadStallMs,
    maxFutureSkewMs: config.l1MaxFutureSkewMs,
    slashLogStartBlock: config.l1SlashLogStartBlock,
    slashLogLookbackBlocks: config.l1SlashLogLookbackBlocks,
    slashLogChunkSize: config.l1SlashLogChunkSize,
    slashLogOverlapBlocks: config.l1SlashLogOverlapBlocks,
    slashLogReorgRewindBlocks: config.l1SlashLogReorgRewindBlocks,
    slashLogProviderTimeoutMs: config.l1SlashLogProviderTimeoutMs,
  });
  const sentinelCollector = new SentinelCollector({
    client: adminClient,
    committeeScanner: l1Scanner,
    repository,
    network: config.network,
    expectedChainId: config.l1ChainId,
    expectedRegistryAddress: config.l1RegistryAddress,
    pollIntervalMs: config.sentinelPollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    lookbackEpochs: config.sentinelLookbackEpochs,
    epochEndBufferSlots: config.sentinelEpochEndBufferSlots,
    validatorConcurrency: config.sentinelValidatorConcurrency,
    maxStallMs: config.syncMaxL2StallMs,
    logger,
  });

  const l1Collector = new L1Collector({
    scanner: l1Scanner,
    repository,
    network: config.network,
    pollIntervalMs: config.l1PollIntervalMs,
    maxBackoffMs: config.l1MaxBackoffMs,
    maxSlashLogChunksPerPoll: config.l1SlashLogMaxChunksPerPoll,
    maxSlashLogRunMs: config.l1SlashLogMaxRunMs,
    logger,
  });

  const channels = {};
  if (config.vapid) {
    channels.web_push = new WebPushChannel({
      vapid: config.vapid,
      timeoutMs: config.deliveryRequestTimeoutMs,
    });
  }
  let telegramBot;
  let telegramReady = false;
  if (config.telegram) {
    const telegramClient = new TelegramClient({
      token: config.telegram.token,
      timeoutMs: config.deliveryRequestTimeoutMs,
      sendScheduler: new TelegramSendScheduler({
        maxPerSecond: config.telegramSendMaxPerSecond,
        lowPriorityMaxPerSecond: config.telegramLowPrioritySendMaxPerSecond,
        perChatIntervalMs: config.telegramChatSendIntervalMs,
      }),
    });
    channels.telegram = new TelegramChannel({
      client: telegramClient,
      publicUrl: config.publicUrl,
      isReady: () => telegramReady,
    });
    telegramBot = new TelegramBot({
      client: telegramClient,
      repository,
      expectedUsername: config.telegram.username,
      pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
      onReadinessChange: (ready) => { telegramReady = ready; },
      logger,
    });
  }

  const deliveryWorker = new DeliveryWorker({
    repository,
    channels,
    pollIntervalMs: config.deliveryPollIntervalMs,
    batchSize: config.deliveryBatchSize,
    concurrency: config.deliveryConcurrency,
    maxAttempts: config.deliveryMaxAttempts,
    leaseMs: config.deliveryLeaseMs,
    requestTimeoutMs: config.deliveryRequestTimeoutMs,
    logger,
  });
  const api = new CaseApiServer({
    repository,
    host: config.bindHost,
    port: config.port,
    corsOrigin: config.corsOrigin,
    staleAfterMs: config.staleAfterMs,
    l1StaleAfterMs: config.l1StaleAfterMs,
    network: config.network,
    vapidPublicKey: config.vapid?.publicKey,
    telegramBotUsername: config.telegram?.username,
    isTelegramReady: () => telegramReady,
    maxSequencers: config.maxWatchedSequencers,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    requestRateLimitWindowMs: config.requestRateLimitWindowMs,
    requestRateLimitMaxRequests: config.requestRateLimitMaxRequests,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxMutations: config.rateLimitMaxMutations,
    watchCreationRateLimitWindowMs: config.watchCreationRateLimitWindowMs,
    watchCreationRateLimitMaxPerClient: config.watchCreationRateLimitMaxPerClient,
    watchCreationRateLimitMaxGlobal: config.watchCreationRateLimitMaxGlobal,
    trustLoopbackProxy: config.trustLoopbackProxy,
    linkTokenTtlMs: config.linkTokenTtlMs,
    logger,
  });

  const workers = [
    ['aztec', offenseCollector],
    ['aztec-sentinel', sentinelCollector],
    ['l1', l1Collector],
    ['delivery', deliveryWorker],
    ...(telegramBot ? [['telegram', telegramBot]] : []),
  ];
  let shuttingDown = false;
  let fatal = false;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('slashveto.me backend shutting down', { reason });
    await Promise.allSettled([
      ...workers.map(([, worker]) => worker.stop()),
      api.close(),
    ]);
    repository.close();
  };

  const fail = async (name, error) => {
    if (shuttingDown || fatal) return;
    fatal = true;
    logger.error('A supervised backend loop exited', { worker: name, error: errorMessage(error) });
    await shutdown(`${name}-failed`);
    process.exitCode = 1;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => void fail('unhandled-rejection', error));

  try {
    await api.listen();
    for (const [name, worker] of workers) {
      worker.start().then(
        () => {
          if (!shuttingDown) void fail(name, new Error('worker stopped unexpectedly'));
        },
        (error) => void fail(name, error),
      );
    }
  } catch (error) {
    await shutdown('startup-error');
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    message: 'slashveto.me backend failed',
    data: { error: errorMessage(error) },
  })}\n`);
  process.exitCode = 1;
});
