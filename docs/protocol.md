# Protocol and correctness model

slashveto.me combines local Aztec-node evidence with canonical Ethereum state
without flattening their certainty:

```text
Sentinel duty → node offense → L1 vote and tally → execution → stake outcome
```

Sentinel and the admin offense feed can provide an early warning and a reason.
L1 establishes contract identity, votes, timing, vetoes, execution, and actual
stake deductions. No single source establishes the entire path.

## Time and duties

A staked validator can propose the blocks and checkpoint for a slot or attest
to a checkpoint as a committee member. Committee members sign the complete
checkpoint, not individual blocks.

| Unit | Meaning | Mainnet snapshot on 2026-07-29 |
| --- | --- | --- |
| Slot | Fixed interval with one selected proposer | 72 seconds |
| Epoch | Committee and proving interval | 32 slots |
| Slashing round | Window for selected proposers to cast slash votes | 128 slots / 4 epochs |

The active deployment, not this table, is authoritative. Runtime views read the
current values from the responsible canonical contracts.

## Slashing lifecycle

### Node evidence

Sentinel records proposer and committee duty results. A first missed duty or
one qualifying inactive epoch is an early warning, not an offense. The node
applies its configured missed-duty ratio, consecutive-epoch threshold,
processing buffer, grace period, penalties, exemptions, and allow/deny policy
before registering an offense.

Inactivity is calculated only across duty-bearing epochs. Non-committee epochs
are skipped, and an unknown coverage gap starts a new streak generation. The
UI therefore distinguishes `1 of 2 qualifying inactive epochs` from an
inactivity offense.

The node can report ten offense types:

| Offense | Attributed to |
| --- | --- |
| Inactivity | Proposer or committee member |
| Data withholding | Checkpoint attester |
| Broadcast invalid block proposal | Block proposer |
| Broadcast invalid checkpoint proposal | Checkpoint proposer |
| Proposed insufficient attestations | L1 checkpoint proposer |
| Proposed incorrect attestations | L1 checkpoint proposer |
| Proposed descendant of checkpoint with invalid attestations | L1 checkpoint proposer |
| Attested invalid checkpoint proposal | Committee member |
| Duplicate proposal | Proposer |
| Duplicate attestation | Committee member |

Detection and penalty are node policy. A zero-penalty detection is valid, and
another node can reach a different conclusion.

### L1 voting and quorum

During slashing round `R`, each selected checkpoint proposer can cast one
ballot per slot for committee positions in older target epochs:

```text
first target epoch = (R - slash offset) × epochs per slashing round
```

Each position receives a two-bit penalty unit. At the researched mainnet
deployment, units 1, 2, and 3 map to 2,000, 5,000, and 5,000 AZTEC. The ballot
contains no offense type, evidence hash, or text reason.

Tallying is cumulative: a unit-3 ballot supports levels 3, 2, and 1. The
contract chooses the highest level whose support reaches the validator-action
quorum. Total round participation and support for one validator action are
different counts. slashveto.me alerts on the first vote and quorum, not
intermediate ballot counts.

### Candidate and execution

The live tally produces a candidate action set and deterministic predicted
payload address. No payload is deployed while voting is open, and later ballots
can change the action set, amount, or address.

For voting round `R`:

```text
first executable slot = (R + execution delay + 1) × round size
expiry slot           = (R + lifetime + 1) × round size
```

After voting closes, the tally is stable. Execution can still be prevented by
the delay, an exact-address veto, a global Slasher pause, expiry, or the absence
of a caller. A pause protects a candidate only when it covers the complete
remaining execution window.

`RoundExecuted` confirms that the round was executed. For a nonempty action
list, the transaction deploys and calls the payload, but an individual action
can still deduct nothing. The canonical Rollup `Slashed(attester, amount)` log
is the source of truth for the address and amount actually removed.

### Ejection

The slash is capped by the validator's current balance. The active Rollup
ejects the validator when:

```text
remaining balance < local ejection threshold
```

Equality does not eject. Ejection removes the validator from the active set and
places the remaining stake in the delayed exit flow. Requested amount, actual
deduction, current stake, ejection state, and withdrawal eligibility remain
separate facts.

## Case linking

A case is a slashveto.me projection, not an onchain object. Its key is network,
SlashingProposer lineage, sequencer, and target epoch. Raw observations remain
independently inspectable.

The projector enforces these joins:

1. Duty records form an inactivity progression only for the same address,
   epoch, node policy, and uninterrupted coverage generation.
2. A node offense joins duty evidence only at the same exact epoch or slot.
3. Node evidence can explain an L1 action only for the same address and target
   epoch and only when it predates that L1 transition.
4. Votes, candidates, and executions join by contract lineage, round, target
   epoch, and address.
5. A `Slashed` log joins through the canonical execution receipt and exact
   action order. Address and approximate time are never sufficient.
6. Reorged L1 evidence becomes noncanonical and the same case is reprojected;
   the correction remains in transition history.

Several local offenses can contribute to one penalty unit, and voters can have
different evidence. The UI retains every exact match and says the reason is not
encoded on L1. An L1-only observation still creates a case; local evidence with
no L1 continuation remains a stopped case.

## Closing and retention

A case stays open only while the protocol still allows it to become a slash:

| Evidence | Open until |
| --- | --- |
| Duty miss, inactive epoch, or node offense without an L1 ballot | The one voting round that targets the epoch closes: `⌊epoch ÷ epochs per round⌋ + slash offset` |
| L1 ballots below quorum | That voting round closes and the tally becomes final |
| Vetoed candidate | Its voting round closes; a veto is permanent and a closed tally cannot move to another payload address |
| Candidate | It executes or its lifetime ends at `(R + lifetime + 1) × round size` |

At the mainnet snapshot, node evidence closes 5.8 to 7.7 hours after its epoch
starts, and an unexecuted candidate expires 35 rounds (about 3.7 days) after
its voting round began. Closing reads the lineage's current round from the last
canonical L1 snapshot, so a stale L1 source closes nothing. The backend
re-evaluates open cases whenever a lineage's round advances, and late L1
evidence reopens a case through the ordinary projection.

Closed cases are final and appear under each watched sequencer's closed cases.
The network feed carries only open cases and the latest execution outcomes,
with a summary of every retained case. The watchlist route drops a closed case
that never reached quorum 7 days after its last evidence, measured in whole
hours; vetoes, expiries, executions, slashes, and ejections stay. The case and
single-sequencer routes keep such a case until the backend deletes it, with its
evidence and transitions, 90 days after its last evidence.

## Collection and contract upgrades

Both collectors start from the configured Registry, resolve the canonical
Rollup, discover its Slasher and SlashingProposer, verify reciprocal links and
bytecode, and pin a coherent L1 block. The scanner follows active, pending, and
still-authorized prior lineages because a replaced Slasher can finish old
rounds.

The backend has independent `aztec_sentinel`, `aztec_node`, and `ethereum_l1`
sources. It verifies that public and admin endpoints identify the same node and
the expected chain, Registry, and Rollup. Outages retain the last known state.
A missing offense is withdrawn only after a fresh, non-regressing node cursor
advances beyond it.

Confirmed slash-log collection uses a durable block/hash checkpoint, bounded
overlap, and reorg rewind. Historical executions are reconstructed at their
archive block and matched by receipt action order. SQLite commits observations,
case projection, transitions, watch matching, and outbox entries atomically.

## Mainnet snapshot

These values were verified on 2026-07-29 and are examples only:

| Parameter | Value |
| --- | --- |
| Committee size | 48 |
| Vote quorum | 65 |
| Target offset | 2 rounds |
| Execution delay | 28 rounds |
| Lifetime | 34 rounds |
| Execution window | 6 rounds |
| Local ejection threshold | 190,000 AZTEC |
| Validator exit delay | 4 days |

## References

- [Aztec slashing and offenses](https://docs.aztec.network/operate/operators/sequencer-management/slashing_and_offenses)
- [`SlashingProposer.sol`](https://github.com/AztecProtocol/aztec-packages/blob/def7152aa13dc0f880f24e45ce39442908170878/l1-contracts/src/core/slashing/SlashingProposer.sol)
- [`Slasher.sol`](https://github.com/AztecProtocol/aztec-packages/blob/def7152aa13dc0f880f24e45ce39442908170878/l1-contracts/src/core/slashing/Slasher.sol)
- [`StakingLib.sol`](https://github.com/AztecProtocol/aztec-packages/blob/def7152aa13dc0f880f24e45ce39442908170878/l1-contracts/src/core/libraries/rollup/StakingLib.sol)
- [Sentinel duty accounting](https://github.com/AztecProtocol/aztec-packages/blob/def7152aa13dc0f880f24e45ce39442908170878/yarn-project/aztec-node/src/sentinel/README.md)
- [Slash Veto Council](https://github.com/aztec-slash-veto/council)
