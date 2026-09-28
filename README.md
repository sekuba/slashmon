# slashveto.me

slashveto.me tracks an Aztec sequencer from the first observed duty miss to an
L1 slash and ejection:

```text
duty miss → node offense → L1 vote → quorum → execution delay
          → executable → executed → stake removed → ejection
```

A path can stop at any step. The product keeps candidate amounts, executed
rounds, and actual stake deductions separate. L1 votes do not encode an
offense reason; a displayed reason is always labelled as evidence from the
attached Aztec node.

## Surfaces

| Surface | Source | Purpose |
| --- | --- | --- |
| **Monitor** | Ethereum RPC queried in the browser | Independent view of canonical contracts, votes, candidates, execution, and slash logs. |
| **PINGME** | Backend using one Aztec node and Ethereum RPC | Earlier Sentinel/offense evidence, durable cases, and Telegram or Web Push alerts. |

Monitor never calls the backend. PINGME keeps the last known state when one
source fails and reports that source as stale. Neither surface is an oracle:
node evidence is one observer's report, while L1 establishes contract state
without revealing the reason behind a vote.

The primary object is a slashing case: network, contract lineage, sequencer,
and target epoch with its source observations and state transitions. Linking is
exact and conservative. An actual slash joins through its execution transaction
and action order, never by address and approximate time.

## Repository

- `shared/protocol/` contains the pure case projection, vote tallying, round
  lifecycle, transitions, and notification wording shared by frontend and
  backend.
- `src/` contains the React PWA and independent browser L1 collector.
- `collector/` contains the Node backend, SQLite repository, three evidence
  collectors, API, durable outbox, Telegram, and Web Push.
- `scripts/deploy-backend.sh` installs an immutable backend release under
  systemd.

The backend API is rooted at `/api`. `/live` reports process liveness and
`/health` reports whether the required evidence sources are current.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/config`, `/api/status`, `/api/network` | Capabilities; freshness and protocol state; open cases, latest execution outcomes, and a network summary (ETag-revalidatable) |
| `GET` | `/api/sequencers?addresses=a,b` | Every retained case of up to the watch limit of sequencers, for the watchlist (ETag-revalidatable) |
| `GET` | `/api/sequencers/:address`, `/api/cases/:id` | Public sequencer and exact-case views, including closed history |
| `POST` | `/api/watches` | Create a private watch and return its management token once |
| `GET/PATCH/DELETE` | `/api/watches/:id` | Bearer-authenticated watch management |
| `PUT/DELETE` | `/api/watches/:id/channels/web_push` | Web Push enrollment |
| `POST` | `/api/watches/:id/channels/telegram-link` | One-time Telegram enrollment link |
| `POST` | `/api/watches/:id/channels/test` | Queue a test alert |

## Development

Node 24 and the pinned pnpm version are required; `.npmrc` makes pnpm refuse
other Node versions:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
cp collector/.env.example collector/.env
pnpm dev
pnpm dev:backend
```

Run the release gate with:

```bash
pnpm check
```

Every `VITE_*` value is public. RPC credentials, Aztec admin credentials,
Telegram tokens, VAPID private keys, and the SQLite database belong only in the
backend environment. The ignored `apiReference.md` and `onchainSources.md` are
local research inputs, not runtime dependencies or published documentation.

## Documentation

- [Protocol and correctness model](docs/protocol.md)
- [Notification contract](docs/notifications.md)
- [Production runbook](docs/runbook.md)

The protocol model was checked against the active Aztec mainnet deployment and
[`aztec-packages` commit `def7152a`](https://github.com/AztecProtocol/aztec-packages/tree/def7152aa13dc0f880f24e45ce39442908170878)
on 2026-07-29. Contracts and parameters are upgradeable; runtime code discovers
the responsible lineage and reads its values.
