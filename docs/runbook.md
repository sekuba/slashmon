# Production runbook

Production is one Node 24 process, one SQLite database, one Aztec public/admin
endpoint pair, one archive-capable Ethereum RPC, and an HTTPS reverse proxy or
Cloudflare Tunnel.

## Prepare the environment

Install Node 24 at `/usr/local/bin/node`, enable Corepack, and create the
protected production env:

```bash
/usr/local/bin/node --version
corepack enable
sudo install -m 0600 collector/deploy/slashmon-backend.env.example \
  /etc/slashmon-backend.env
sudoedit /etc/slashmon-backend.env
```

The minimal production file is:

```dotenv
SLASHMON_PUBLIC_URL=https://slashveto.me
BACKEND_CORS_ORIGIN=https://slashveto.me
BACKEND_TRUST_PROXY=true
AZTEC_NODE_URL=http://127.0.0.1:8080
AZTEC_ADMIN_URL=http://127.0.0.1:8880
L1_RPC_URL=https://YOUR-ARCHIVE-ETHEREUM-RPC
L1_SLASH_LOG_START_BLOCK=25533241
```

Change the public origin and three upstream URLs. Keep
`BACKEND_TRUST_PROXY=true` only when a trusted proxy connects directly to the
loopback listener. Add `AZTEC_NODE_API_KEY` or `AZTEC_ADMIN_API_KEY` only when
the corresponding endpoint requires one.

Add a complete Telegram pair and/or VAPID triple to enable notifications:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
VAPID_SUBJECT=mailto:operator@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Generate VAPID keys with:

```bash
pnpm --filter @slashmon/backend exec web-push generate-vapid-keys
```

All omitted collection, retry, request-limit, bind, port, and log settings use
the defaults in `collector/src/config.mjs`. The deployer preserves only
supported settings and removes empty or obsolete entries from the installed
env.

The default API limits are deliberately generous for normal browser polling:
300 requests and 20 changes per client per minute, plus 10 new watches per
client and 100 new watches globally per hour. Local `/live` and `/health`
operator probes are excluded. Leave these settings out of the environment
unless real traffic requires tuning.

`L1_SLASH_LOG_START_BLOCK=25533241` starts the mainnet slash-log journal at the
first Rollup block for the current stack. It requires archive state reads.
Historical chunks advance a durable block/hash checkpoint and do not queue
historical notifications. A failed chunk leaves the checkpoint unchanged.

## Fresh install, wipe, or upgrade

Run the script from a clean checkout as its normal owner:

```bash
# First install, or an intentional irreversible deletion of all backend state
# and retained backend backups:
scripts/deploy-backend.sh --fresh

# Installed service: verify and back up SQLite, then start with a new database:
scripts/deploy-backend.sh --reset-db

# Installed service: verify and back up SQLite, then preserve the database:
scripts/deploy-backend.sh --upgrade
```

For this production cutover, use `--fresh` when
`slashmon-backend.service` has never been installed. Use `--reset-db` when it
is already installed and the current database should be wiped. Both start an
empty schema and backfill from the configured anchor; only `--reset-db` retains
a verified copy of the previous database.

Stop and disable any differently named backend that still owns port 8790 before
`--fresh`. The deployer manages only `slashmon-backend.service` and
`slashmon-backend-testing.service`, and refuses to start when another process
is listening.

The backend creates its current schema only in an empty database. It has no
schema migrations or compatibility API. `--upgrade` is valid only while the
installed database already has the exact current schema.

The script builds an immutable release from the current commit, installs
production dependencies with the frozen lockfile, stops the single writer,
installs the hardened systemd service, and waits for `/live`. The production
database is `/var/lib/slashmon/slashmon.sqlite`; backups are stored under
`/var/backups/slashmon`.

Hourly maintenance bounds the database. It deletes sent and failed deliveries
after 30 days and expired Telegram links after a day. It deletes closed cases
that never reached quorum, with their evidence and transitions, 90 days after
their last evidence, and Sentinel duty rows after 90 days, keeping the newest
indexed epoch. Vetoes, expiries, executions, slashes, and ejections are kept.

An isolated testing deployment uses the same arguments with `--testing` first:

```bash
scripts/deploy-backend.sh --testing --fresh
scripts/deploy-backend.sh --testing --reset-db
scripts/deploy-backend.sh --testing --upgrade
```

Testing requires `/etc/slashmon-backend-testing.env`, an explicit nonproduction
port, separate state, and a different Telegram bot.

## HTTPS and browser boundary

Keep the backend on `127.0.0.1:8790` and expose only `/api/*` over HTTPS.
`/live` and `/health` are local operator probes and must not be included in the
Cloudflare Tunnel route. The PWA origin must exactly match
`BACKEND_CORS_ORIGIN`; `SLASHMON_PUBLIC_URL` is the complete installed PWA URL
used in notifications.

Apply proxy request limits and send HSTS, `X-Content-Type-Options: nosniff`, a
no-referrer policy, and a restrictive Content Security Policy. A starting
policy is:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self'; manifest-src 'self'; worker-src 'self';
connect-src 'self' https://YOUR-L1-RPCS; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

Add the API origin and only the actual browser-selectable Monitor RPC origins
to `connect-src`.

PINGME needs a dedicated browser origin because its management token is stored
as an origin-wide bearer capability. Do not add analytics, ads, tag managers,
or third-party scripts to that origin.

## Verify

```bash
curl --fail http://127.0.0.1:8790/live
curl --fail http://127.0.0.1:8790/health
curl --fail http://127.0.0.1:8790/api/config
journalctl -u slashmon-backend.service --since '10 minutes ago'
```

`/health` remains `503` while the three evidence views are starting or stale.
Before opening watches, confirm:

- the node, Registry, Rollup, chain, and database identities agree;
- Aztec, Sentinel, current L1, and historical slash-log cursors advance;
- slash-log backfill reaches the confirmed head;
- Telegram linking and a test alert work when configured; and
- Web Push enrollment and a test alert work when configured.

An outage must degrade one source without deleting its last good state.
Changing VAPID keys invalidates existing Web Push subscriptions. Web Push
404/410 disables only that endpoint.

## Sensitive data

The database contains public sequencer evidence plus private watch membership,
hashed management/link tokens, Telegram chat IDs, Web Push endpoints and
encryption material, and delivery state. Protect it and its backups as secrets.
The systemd unit uses a private state directory and `UMask=0077`.

The API never exposes watch membership, endpoints, tokens, or delivery state
without the bearer management token. Logs must not contain RPC credentials,
provider tokens, management or link tokens, push key material, Telegram chat
associations, or full secret URLs.

slashveto.me never needs validator keys, seed phrases, wallet signatures, or an
Aztec keystore.
