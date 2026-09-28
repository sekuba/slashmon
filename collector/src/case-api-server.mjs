import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  createOpaqueToken,
  hashToken,
  InputError,
  normalizeAddresses,
  normalizeNetwork,
  parsePushSubscription,
  readBearerToken,
  safeHashMatches,
} from './security.mjs';
import { errorMessage } from './logger.mjs';
import { closedCaseCutoff } from '../../shared/protocol/index.ts';

const API_PREFIX = '/api';

export class CaseApiServer {
  constructor({
    repository,
    host = '127.0.0.1',
    port = 8_790,
    corsOrigin,
    network,
    staleAfterMs = 60_000,
    l1StaleAfterMs = 120_000,
    vapidPublicKey,
    telegramBotUsername,
    isTelegramReady = () => false,
    maxSequencers = 100,
    maxRequestBodyBytes = 64 * 1024,
    requestRateLimitWindowMs = 60_000,
    requestRateLimitMaxRequests = 300,
    rateLimitWindowMs = 60_000,
    rateLimitMaxMutations = 20,
    watchCreationRateLimitWindowMs = 60 * 60_000,
    watchCreationRateLimitMaxPerClient = 10,
    watchCreationRateLimitMaxGlobal = 100,
    trustLoopbackProxy = false,
    linkTokenTtlMs = 10 * 60_000,
    logger,
    now = Date.now,
  }) {
    this.repository = repository;
    this.host = host;
    this.port = port;
    this.corsOrigin = corsOrigin;
    this.network = network;
    this.staleAfterMs = staleAfterMs;
    this.l1StaleAfterMs = l1StaleAfterMs;
    this.vapidPublicKey = vapidPublicKey;
    this.telegramBotUsername = telegramBotUsername;
    this.isTelegramReady = isTelegramReady;
    this.maxSequencers = maxSequencers;
    this.maxRequestBodyBytes = maxRequestBodyBytes;
    this.trustLoopbackProxy = trustLoopbackProxy;
    this.linkTokenTtlMs = linkTokenTtlMs;
    this.logger = logger;
    this.now = now;
    this.requestRateLimiter = new FixedWindowRateLimiter(
      requestRateLimitWindowMs,
      requestRateLimitMaxRequests,
    );
    this.mutationRateLimiter = new FixedWindowRateLimiter(
      rateLimitWindowMs,
      rateLimitMaxMutations,
    );
    this.watchCreationRateLimiter = new FixedWindowRateLimiter(
      watchCreationRateLimitWindowMs,
      watchCreationRateLimitMaxPerClient,
    );
    this.globalWatchCreationRateLimiter = new FixedWindowRateLimiter(
      watchCreationRateLimitWindowMs,
      watchCreationRateLimitMaxGlobal,
      1,
    );
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const status = errorStatus(error);
        // The query can name watched sequencers; logs carry only the route.
        const details = {
          method: request.method,
          path: String(request.url ?? '').split('?')[0],
          status,
          code: error?.code ?? 'internal_error',
          error: errorMessage(error),
        };
        if (status >= 500) {
          this.logger?.error?.('API request failed', details);
        } else {
          this.logger?.debug?.('API request rejected', details);
        }
        this.sendError(request, response, error);
      });
    });
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        resolve(this.server.address());
      });
    });
  }

  close() {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      // Keep-alive sockets otherwise hold close() open until they idle out.
      this.server.closeIdleConnections();
    });
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://backend.invalid');
    this.setCors(response);
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      this.limitRequest(request);
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/live') {
      return this.send(request, response, 200, { status: 'live' });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const status = this.status();
      return this.send(request, response, status.status === 'healthy' ? 200 : 503, status);
    }
    if (request.method === 'GET' && url.pathname === `${API_PREFIX}/config`) {
      return this.send(request, response, 200, {
        network: this.network,
        maxSequencers: this.maxSequencers,
        notifications: {
          webPush: this.vapidPublicKey
            ? { enabled: true, publicKey: this.vapidPublicKey }
            : { enabled: false, publicKey: null },
          telegram: {
            enabled: Boolean(this.telegramBotUsername && this.isTelegramReady()),
            username: this.telegramBotUsername ?? null,
          },
        },
      });
    }
    if (request.method === 'GET' && url.pathname === `${API_PREFIX}/status`) {
      return this.send(request, response, 200, this.status());
    }
    if (request.method === 'GET' && url.pathname === `${API_PREFIX}/network`) {
      return this.sendBody(request, response, 200, this.networkBody(), {
        revalidate: true,
      });
    }
    if (request.method === 'GET' && url.pathname === `${API_PREFIX}/sequencers`) {
      const addresses = normalizeAddresses(
        (url.searchParams.get('addresses') ?? '').split(',').filter(Boolean),
        this.maxSequencers,
      );
      return this.send(request, response, 200, {
        cases: this.repository.getSequencerCases(this.network, addresses, {
          closedSince: closedCaseCutoff(this.now()),
        }),
      }, { revalidate: true });
    }

    const sequencerMatch = /^\/api\/sequencers\/(0x[0-9a-fA-F]{40})$/.exec(
      url.pathname,
    );
    if (request.method === 'GET' && sequencerMatch) {
      return this.send(
        request,
        response,
        200,
        this.repository.getSequencerRecord(sequencerMatch[1], this.network),
        { revalidate: true },
      );
    }
    const caseMatch = /^\/api\/cases\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && caseMatch) {
      const item = this.repository.getCase(decodeURIComponent(caseMatch[1]));
      if (!item) throw new InputError('case_not_found', 'Slashing case not found', 404);
      return this.send(request, response, 200, item, { revalidate: true });
    }

    if (request.method === 'POST' && url.pathname === `${API_PREFIX}/watches`) {
      this.limitMutation(request);
      const body = await this.readBody(request);
      const selectedNetwork = normalizeNetwork(body.network ?? this.network, this.network);
      const addresses = normalizeAddresses(body.addresses, this.maxSequencers);
      this.limitWatchCreation(request);
      const managementToken = createOpaqueToken();
      const watch = this.repository.createWatch({
        id: randomUUID(),
        managementTokenHash: hashToken(managementToken),
        network: selectedNetwork,
        addresses,
        now: this.now(),
      });
      return this.send(request, response, 201, {
        watch: publicWatch(watch),
        managementToken,
      });
    }

    const watchMatch = /^\/api\/watches\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (watchMatch) {
      const watch = this.authorizeWatch(request, watchMatch[1]);
      if (request.method === 'GET') {
        return this.send(request, response, 200, publicWatch(watch));
      }
      this.limitMutation(request);
      if (request.method === 'PATCH') {
        const body = await this.readBody(request);
        const addresses = body.addresses === undefined
          ? undefined
          : normalizeAddresses(body.addresses, this.maxSequencers);
        const updated = this.repository.updateWatch(watch.id, {
          addresses,
          now: this.now(),
        });
        if (!updated) throw new InputError('watch_not_found', 'Watch not found', 404);
        return this.send(request, response, 200, publicWatch(updated));
      }
      if (request.method === 'DELETE') {
        this.repository.deleteWatch(watch.id);
        response.writeHead(204);
        response.end();
        return;
      }
    }

    const channelMatch =
      /^\/api\/watches\/([0-9a-fA-F-]{36})\/channels\/(web_push)$/.exec(
        url.pathname,
      );
    if (channelMatch) {
      const watch = this.authorizeWatch(request, channelMatch[1]);
      this.limitMutation(request);
      if (request.method === 'PUT') {
        if (!this.vapidPublicKey) {
          throw new InputError(
            'web_push_unavailable',
            'Web Push is not configured',
            503,
          );
        }
        const body = await this.readBody(request);
        const subscription = parsePushSubscription(body.subscription);
        const updated = this.repository.upsertEndpoint({
          watchId: watch.id,
          kind: 'web_push',
          destination: subscription.endpoint,
          configJson: JSON.stringify(subscription),
          now: this.now(),
        });
        return this.send(request, response, 200, publicWatch(updated));
      }
      if (request.method === 'DELETE') {
        this.repository.deleteEndpoint(watch.id, 'web_push');
        response.writeHead(204);
        response.end();
        return;
      }
    }

    const telegramMatch =
      /^\/api\/watches\/([0-9a-fA-F-]{36})\/channels\/telegram-link$/.exec(
        url.pathname,
      );
    if (request.method === 'POST' && telegramMatch) {
      const watch = this.authorizeWatch(request, telegramMatch[1]);
      this.limitMutation(request);
      if (!this.telegramBotUsername || !this.isTelegramReady()) {
        throw new InputError(
          'telegram_unavailable',
          'Telegram notifications are unavailable',
          503,
        );
      }
      const token = createOpaqueToken();
      const expiresAt = this.now() + this.linkTokenTtlMs;
      this.repository.createTelegramLink({
        tokenHash: hashToken(token),
        watchId: watch.id,
        expiresAt,
        now: this.now(),
      });
      return this.send(request, response, 201, {
        url: `https://t.me/${this.telegramBotUsername}?start=${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }

    const testMatch =
      /^\/api\/watches\/([0-9a-fA-F-]{36})\/channels\/test$/.exec(
        url.pathname,
      );
    if (request.method === 'POST' && testMatch) {
      const watch = this.authorizeWatch(request, testMatch[1]);
      this.limitMutation(request);
      const queued = this.repository.enqueueWatchTest(watch.id, this.now());
      if (queued === 0) {
        throw new InputError(
          'no_notification_channel',
          'Connect a notification channel first',
          409,
        );
      }
      return this.send(request, response, 202, { queued });
    }

    throw new InputError('not_found', 'Route not found', 404);
  }

  authorizeWatch(request, id) {
    const watch = this.repository.getWatch(id);
    if (!watch) throw new InputError('watch_not_found', 'Watch not found', 404);
    const token = readBearerToken(request.headers.authorization);
    if (!safeHashMatches(token, watch.managementTokenHash)) {
      throw new InputError('invalid_management_token', 'Management token is invalid', 401);
    }
    return watch;
  }

  status() {
    const now = this.now();
    const required = [
      ['ethereum_l1', ['l1', 'l1_slash_logs'], this.l1StaleAfterMs],
      ['aztec_node', ['aztec_node'], this.staleAfterMs],
      ['aztec_sentinel', ['aztec_sentinel'], this.staleAfterMs * 2],
    ];
    const sources = required.map(([source, keys, staleAfter]) => {
      const states = keys.map((key) => this.repository.getSourceState(key));
      const successes = states.map((state) => Number(state?.lastSuccessAt ?? 0));
      const leastRecentSuccess = Math.min(...successes);
      const age = leastRecentSuccess === 0 ? null : now - leastRecentSuccess;
      const status = successes.some((at) => at === 0)
        ? 'unavailable'
        : states.some((state) => Number(state?.consecutiveFailures ?? 0) > 0) ||
            age > staleAfter
          ? 'stale'
          : 'healthy';
      const failed = states.find((state) =>
        Number(state?.consecutiveFailures ?? 0) > 0 && state?.lastError);
      return {
        source,
        status,
        lastSuccessAt: leastRecentSuccess
          ? new Date(leastRecentSuccess).toISOString()
          : null,
        lastError: failed?.lastError ?? null,
      };
    });
    const protocol = this.repository.getProtocolSnapshot();
    const overall = !protocol
      ? 'starting'
      : sources.every((item) => item.status === 'healthy')
        ? 'healthy'
        : 'degraded';
    return {
      status: overall,
      network: this.network,
      observedAt: new Date(now).toISOString(),
      protocol,
      sources,
    };
  }

  limitRequest(request) {
    const retryAfterMs = this.requestRateLimiter.take(
      clientAddress(request, this.trustLoopbackProxy),
      this.now(),
    );
    if (retryAfterMs > 0) {
      throw rateLimitError('Too many requests; try again shortly', retryAfterMs);
    }
  }

  limitMutation(request) {
    const key = clientAddress(request, this.trustLoopbackProxy);
    const retryAfterMs = this.mutationRateLimiter.take(key, this.now());
    if (retryAfterMs > 0) {
      throw rateLimitError('Too many changes; try again shortly', retryAfterMs);
    }
  }

  limitWatchCreation(request) {
    const now = this.now();
    const clientRetryAfterMs = this.watchCreationRateLimiter.take(
      clientAddress(request, this.trustLoopbackProxy),
      now,
    );
    if (clientRetryAfterMs > 0) {
      throw rateLimitError(
        'Too many watches created; try again later',
        clientRetryAfterMs,
      );
    }
    const globalRetryAfterMs = this.globalWatchCreationRateLimiter.take('global', now);
    if (globalRetryAfterMs > 0) {
      throw rateLimitError(
        'Watch creation is temporarily at capacity; try again later',
        globalRetryAfterMs,
      );
    }
  }

  async readBody(request) {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0];
    if (contentType !== 'application/json') {
      throw new InputError('invalid_content_type', 'Use application/json', 415);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > this.maxRequestBodyBytes) {
        throw new InputError('body_too_large', 'Request body is too large', 413);
      }
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new InputError('invalid_json', 'Request body must be a JSON object');
    }
  }

  setCors(response) {
    response.setHeader('access-control-allow-origin', this.corsOrigin);
    response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    response.setHeader('vary', 'Origin, Accept-Encoding');
  }

  // Every client polls the network feed. Its body depends only on the stored
  // cases and the hourly retention cutoff, so it is serialized, hashed, and
  // compressed once per change instead of once per request.
  networkBody() {
    const closedSince = closedCaseCutoff(this.now());
    const key = `${this.repository.casesVersion}:${closedSince}`;
    if (this.networkCache?.key !== key) {
      this.networkCache = {
        key,
        body: new ResponseBody(
          this.repository.getNetworkSummary(this.network, { closedSince }),
        ),
      };
    }
    return this.networkCache.body;
  }

  send(request, response, status, value, options) {
    this.sendBody(request, response, status, new ResponseBody(value), options);
  }

  // Public data endpoints send `cache-control: no-cache` plus a weak ETag so
  // browsers revalidate every poll and receive a bodyless 304 while nothing
  // changed. Private and mutating responses stay `no-store`. Bodies are
  // gzipped at the origin: the network path to the CDN edge is metered.
  sendBody(request, response, status, body, { revalidate = false } = {}) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': revalidate ? 'no-cache' : 'no-store',
    };
    if (revalidate && status === 200) {
      headers.etag = body.etag;
      const ifNoneMatch = request.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch.includes(body.etag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
    }
    const acceptsGzip = /(?:^|[,\s])gzip(?:$|[;,])/
      .test(String(request.headers['accept-encoding'] ?? ''));
    const payload = acceptsGzip && body.length > 1_024 ? body.gzipped : body.text;
    if (payload !== body.text) headers['content-encoding'] = 'gzip';
    headers['content-length'] = Buffer.byteLength(payload);
    response.writeHead(status, headers);
    response.end(payload);
  }

  sendError(request, response, error) {
    const safeStatus = errorStatus(error);
    if (error?.retryAfterMs) {
      response.setHeader('retry-after', String(Math.ceil(error.retryAfterMs / 1_000)));
    }
    this.send(request, response, safeStatus, {
      error: {
        code: error?.code ?? 'internal_error',
        message: safeStatus === 500
          ? 'The slashveto.me backend could not complete this request'
          : String(error.message),
      },
    });
  }
}

function errorStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : 500;
}

function rateLimitError(message, retryAfterMs) {
  const error = new InputError('rate_limited', message, 429);
  error.retryAfterMs = retryAfterMs;
  return error;
}

// Watched cases are public and come from GET /api/sequencers, where they can
// be revalidated; the private watch carries only its own settings.
function publicWatch(watch) {
  return {
    id: watch.id,
    network: watch.network,
    addresses: watch.addresses,
    endpoints: watch.endpoints,
    createdAt: new Date(Number(watch.createdAt)).toISOString(),
    updatedAt: new Date(Number(watch.updatedAt)).toISOString(),
  };
}

// A serialized JSON body. Its validator and compressed form are computed at
// most once, so a reused body costs nothing further per request.
class ResponseBody {
  constructor(value) {
    this.text = JSON.stringify(value);
    this.length = Buffer.byteLength(this.text);
  }

  get etag() {
    this.cachedEtag ??= `W/"${createHash('sha256').update(this.text).digest('base64url')}"`;
    return this.cachedEtag;
  }

  get gzipped() {
    this.cachedGzip ??= gzipSync(this.text);
    return this.cachedGzip;
  }
}

class FixedWindowRateLimiter {
  constructor(windowMs, max, maxKeys = 10_000) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.lastSweepWindowStart = undefined;
  }

  take(key, now) {
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    if (this.lastSweepWindowStart !== windowStart) {
      for (const [candidate, entry] of this.entries) {
        if (entry.windowStart < windowStart) this.entries.delete(candidate);
      }
      this.lastSweepWindowStart = windowStart;
    }

    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) {
        return windowStart + this.windowMs - now;
      }
      entry = { windowStart, count: 0 };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.max) return windowStart + this.windowMs - now;
    entry.count += 1;
    return 0;
  }
}

function clientAddress(request, trustLoopbackProxy) {
  const remote = request.socket.remoteAddress ?? 'unknown';
  if (!trustLoopbackProxy || !isLoopback(remote)) return remote;
  const cloudflare = request.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare.length < 128) return cloudflare;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',').map((item) => item.trim()).filter(Boolean).at(-1) ?? remote;
  }
  return remote;
}

function isLoopback(value) {
  return value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1';
}
