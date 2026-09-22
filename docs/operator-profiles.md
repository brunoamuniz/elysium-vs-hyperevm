# Operator guide: serial-1 and benchmark-10

> **Independent project. Not affiliated with, endorsed by, or sponsored by Kinetiq or Hyperliquid.**

Elysium testnet only. Both profiles keep the pinned RPC, chain ID `99801`, block-1 anchor hash, the immutable authorized-caller `MinutePulse` contract, and the read-only dashboard.

## Profiles

| | `serial-1` (default) | `benchmark-10` |
| --- | --- | --- |
| Activation | `npm run loop` | `npm run loop:benchmark` |
| Gates | `ELYSIUM_LIVE_ENABLED=true` + `--live` | the same two, **plus** `ELYSIUM_BENCHMARK_ENABLED=true` **plus** `--profile benchmark-10` |
| Writes per UTC minute | 1 | at most 10 **new submissions**, not 10 confirmations |
| Confirmation | inline, blocking | asynchronous tracker, polled every `ELYSIUM_BENCHMARK_POLL_MS` |
| In-flight cap | 1 | 20 prepared-or-submitted actions |
| Budget | `ELYSIUM_DAILY_COST_LIMIT` | `ELYSIUM_BENCHMARK_DAILY_COST_LIMIT` |

There is no way to reach `benchmark-10` by accident: the compose overlay, the env gate, and the CLI flag are three independent switches, and the two original live gates still apply.

## Why benchmark mode needs its own budget

The serial default (`ELYSIUM_DAILY_COST_LIMIT=10000000000000000`, 0.01 HYPE) cannot preflight a single worst-case ten-transaction batch at 300000 gas and 5 gwei. Benchmark mode therefore reads `ELYSIUM_BENCHMARK_DAILY_COST_LIMIT` (default 0.06 HYPE) and `ELYSIUM_BENCHMARK_MAX_TX_COST` (default 0.0015 HYPE). The serial limits are untouched.

A batch is preflighted against the full worst-case cost of all its transactions plus the balance reserve. Committed-but-unsettled reservations count against later batches, both in the daily budget and in the balance preflight (`balance >= outstanding reservations + batch worst case + ELYSIUM_MIN_GAS_RESERVE`). On inclusion the reservation is released and replaced by the real `gasUsed * effectiveGasPrice`, whether the transaction succeeded or reverted.

## Running

Serial, the normal state:

```bash
docker compose up -d
```

Benchmark, an explicit operator decision:

```bash
docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up -d loop
```

Return to serial by taking the overlay away:

```bash
docker compose up -d --force-recreate loop
```

## Chains

Two chains are pinned in `CHAINS` in `src/config.mjs`. Nothing in the environment can change a chain's RPC, chain ID or anchor block.

| `--chain` | Chain ID | Anchor | State directory |
| --- | --- | --- | --- |
| `elysium-testnet` (default) | 99801 | block 1 | `~/.local/state/elysium-minute-loop` |
| `hyperevm-testnet` | 998 | block 62,500,000 (the RPC does not serve history before block 18,289,232) | `~/.local/state/elysium-minute-loop-hyperevm` |

`--chain` and `ELYSIUM_CHAIN` must agree when both are set. Each journal records its `chainId`, and a journal for another chain is refused. The existing Elysium journal predates the field; it is stamped on first load, and only on Elysium.

One-time HyperEVM setup:

```bash
install -d -m 700 ~/.local/state/elysium-minute-loop-hyperevm
npm run verify:rpc -- --chain hyperevm-testnet
```

1. Fund the same wallet address with testnet HYPE on HyperEVM. Get it on HyperCore from the testnet faucet, then use the Hyperliquid testnet UI transfer to HyperEVM.
2. Deploy once with `ELYSIUM_LIVE_ENABLED=true npm run deploy -- --chain hyperevm-testnet`.

The benchmark overlay then starts `loop-hyperevm` alongside `loop`. Create the state directory first: otherwise Docker creates it root-owned and the loop refuses it as insecure.

## What the engine guarantees

- The journal is the nonce authority. Nonces are `max(RPC pending, highest journaled nonce + 1)`. If chain `latest` runs past the journal, the run persists a hold and stops writing.
- All ten actions of a batch are signed and journaled with fixed nonces **before** the first broadcast, then broadcast sequentially in nonce order.
- Quota is charged at the real acceptance timestamp. Prepared work left over from a crash is broadcast first and consumes the new minute's quota before a new batch opens.
- Every pulse is verified by its own `Pulsed` event and its assigned counter value, never by a global counter read at a block, because several batch transactions can share a block.
- A missing receipt is not proof of anything. Foreign consumption requires a missing receipt across two polls **and** chain `latest` past the nonce.
- `already known` on an exact-hash submit or rebroadcast is success, including when the provider error is wrapped. `nonce too low` is neither success nor failure: the action stays journaled and the tracker settles it from the receipt of its exact hash, or holds as `foreign_nonce` after two receipt-less polls. Fees are never altered silently.
- Two-block confirmation is labelled `2-conf`. It is not finality.
- Recovered, migrated and clock-drift samples are excluded from primary percentiles.

## Halt and recovery

```bash
: > ~/.local/state/elysium-minute-loop/HALT
```

New batches stop being prepared; reconciliation still runs. Actions that were already signed keep going out: the prepared backlog is still broadcast and submitted actions are still rebroadcast with their exact journaled raw bytes. Under a `stuck_nonce` hold this is what lets a never-accepted lowest nonce reach the chain, which `hold:clear` requires. The other hold types halt the process; after a restart the same backlog rule applies unless reconciliation halts again, so create `HALT` first if nothing may be broadcast. Holds are persisted in `state.hold` with `status: "reconcile_required"`, and the dashboard shows the service as `reconcile required` with the hold type and nonce for as long as the hold exists:

| `state.hold.type` | Meaning | Action |
| --- | --- | --- |
| `stuck_nonce` | The lowest unresolved nonce has not been included within `ELYSIUM_BENCHMARK_STUCK_MS` | Operator recovery below. No action is abandoned. |
| `foreign_nonce` | A nonce was consumed by a transaction this journal did not sign | Stop. Inspect the journal and the explorer before any write. |
| `intent_mismatch` | An included transaction did not emit the exact expected `Pulsed` event | Stop. Treat the contract state as untrusted until reviewed. |
| `reorg` | The inclusion block is no longer canonical | Stop. Re-examine inclusion before resuming. |
| `hash_mismatch` | The RPC returned a different hash for a journaled raw transaction | Stop. Treat the RPC as untrusted until reviewed. |
| `reconcile_required` | A journaled action is `reconcile_required` with no more specific hold | Stop. Inspect that action. |

### Clearing a hold

A hold never clears itself. Clearing is an explicit operator step that re-verifies the chain and refuses anything it cannot prove:

```bash
docker compose stop loop
: > ~/.local/state/elysium-minute-loop/HALT
npm run hold:clear -- --type stuck_nonce --nonce 0 --reason "nonce 0 included, checked on explorer"
rm ~/.local/state/elysium-minute-loop/HALT
```

- It takes the state lock, so it fails while the loop is running, and it refuses unless the `HALT` file exists.
- `--type` and `--nonce` must match `state.hold` exactly (omit `--nonce` for a hold without one). `--reason` is required.
- Every `reconcile_required` action must have a canonical receipt for its exact journaled hash that is either reverted or emits the exact expected `Pulsed` event. Verified actions are restored for the tracker to settle, marked `recovered` so they stay out of primary percentiles.
- A `stuck_nonce` clears only once chain `latest` is past the nonce and the journaled hash has a canonical receipt.
- A chain nonce still beyond the journal, a missing receipt, or a genuine intent mismatch is refused. That journal cannot be cleared by the tool; retire the state directory after review.
- The cleared hold, reason, restored action ids and checked block are appended to `state.holdHistory` (last 20 kept), and the dashboard shows the last cleared hold.

### Stuck-nonce recovery

Fee changes are never automatic. Recovery is a deliberate, separate operator procedure: a same-nonce replacement bounded by `ELYSIUM_MAX_FEE_PER_GAS`, decided and executed by an operator after inspecting the stuck nonce and its hash in the journal. Nothing in the loop performs it. A replacement lands under a hash the journal did not sign, so `hold:clear` will refuse it; wait for the original transaction where possible.

## Journal rotation

Active state stays bounded at `ELYSIUM_BENCHMARK_ACTIVE_LIMIT` actions. Resolved actions rotate to `finalized-<YYYY-MM-DD>.ndjson` with `raw` and calldata stripped, fsynced before the journal is rewritten. A truncated final line in an archive is tolerated on read. `aggregates.json` is written atomically each minute so top-line counts survive rotation.

## Dashboard exposure

The dashboard is published only on the Tailscale address you set in `DASHBOARD_BIND_IP` (port 8789), mounts the state directory read-only, and never mounts the wallet directory. It is **tailnet-visible, not identity-authenticated**: anyone on the tailnet who can reach the node can read it.

Restrict it with the tailnet policy file. Tailscale policies are default-deny: once the policy has any `acls` or `grants`, only connections a rule accepts are allowed, so the policy must contain no catch-all rule such as `{"action": "accept", "src": ["*"], "dst": ["*:*"]}`. There is no `deny` action; access is limited by what is left out.

```jsonc
{
  "tagOwners": { "tag:elysium-loop": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:elysium-loop:8789"] }
  ]
}
```

Keep the rest of the policy consistent with that:

- Do not add a `nodeAttrs` entry granting the `funnel` attribute to `tag:elysium-loop` (or to `*`). That attribute is what permits Funnel.
- Do not share this machine with other tailnets (admin console, Machines, Share). Shared-in users are not covered by your own group rules.
- If SSH or other ports on this node are needed, add separate, explicit rules for them rather than widening the rule above.

Apply the tag to this node (`tailscale up --advertise-tags=tag:elysium-loop` plus your usual flags), check it with `tailscale status`, confirm `tailscale funnel status` reports nothing served, and from a tailnet device outside `autogroup:admin` confirm `<DASHBOARD_BIND_IP>:8789` is refused.
