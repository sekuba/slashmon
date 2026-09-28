# Notification contract

PINGME alerts describe one state transition in one sequencer's slashing case.
The heading is `short sequencer address · topic`. The body states what
happened, the full sequencer address, the relevant slot, epoch or round, the
UTC time, the reason, and the next deterministic transition.

## Claims

| Event | Direct claim |
| --- | --- |
| Duty miss | This node observed a missed duty or qualifying inactive epoch. Progress such as `1 of 2` is not a node offense. |
| Node offense | This node registered the named offense and local penalty. |
| First L1 vote | An onchain ballot mentions the address and target epoch. L1 does not supply a reason. |
| Quorum | The current tally produces the stated candidate action and amount. |
| Voting close | The tally and predicted payload address are stable. |
| Executable | The delay ended and the candidate is inside its execution window. |
| Veto / expiry | The exact candidate was vetoed or its execution window ended. |
| Closed without slash | A node offense's voting round ended without an L1 ballot, or an L1 vote closed below quorum. |
| Executed | `RoundExecuted` confirms the round was executed. It does not prove a deduction for this address. |
| Stake removed | A canonical Rollup `Slashed` log confirms the actual amount deducted. |
| Ejection | Canonical stake state confirms removal from the active set or entry into the exit flow. |
| Reorg | Prior L1 evidence left the canonical chain and the case was reprojected. |

Before execution, use `candidate action` and `predicted payload address`, never
`deployed payload`. Candidate, executed round, requested amount, and actual
deduction are separate facts.

## Reason

L1 votes do not encode an offense type. A reason can be attached only from node
evidence with the same sequencer and exact target epoch or slot that predates
the L1 transition:

```text
Event: Quorum reached for a 2,000 AZTEC slash
Epoch: 123
Reason: Inactivity (node evidence)
```

With no exact match, use `Reason: Not encoded on L1`. If several node offenses
match, list all of them. Never claim that L1 confirmed an offense reason.

## Noise control

Alerts are emitted for:

- the first missed duty and changed qualifying-epoch progress;
- offense registration or withdrawal, but not the voting round opening for a
  recorded offense;
- a node offense or L1 vote closing without a slash when its voting round
  ends. Duty misses close silently, and a closed case does not alert again for
  another closing reason;
- the first L1 vote and quorum, with no intermediate ballot-count alerts;
- candidate addition, removal, amount change, or address change;
- voting close, execution start, veto, material pause protection, or expiry;
- execution, actual deduction, ejection, or a canonical reorg correction.

Repeated polls update freshness without creating another transition. A
transition caused by protocol time alone, such as an expiry, is dated by the L1
snapshot that observed the round boundary. Delivery
is at-least-once; a crash after provider acceptance can repeat an alert, and
the stable transition ID identifies the duplicate.

## Channel presentation

Telegram includes:

- the exact slashveto.me case link;
- the Dashtec sequencer link; and
- the Etherscan transaction link when a transaction hash exists.

Web Push contains no links in its copy and opens the exact case when selected.
Both channels use the same transition wording. AZTEC amounts are formatted from
18-decimal token units, and timing includes absolute protocol coordinates and
UTC time.
