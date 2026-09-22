# Elysium vs HyperEVM

> **Independent project. Not affiliated with, endorsed by, or sponsored by Kinetiq or Hyperliquid.** Testnet data only; nothing here reflects mainnet performance or prices.

A live, reproducible testnet benchmark that answers one question: **is Elysium, an L2 on Hyperliquid, actually faster and cheaper than HyperEVM, the L1 it settles to, for the same transaction?**

The same minimal contract is deployed on both chains. One host sends the same load to both at the same time, with the same code, fee strategy and polling. A read-only web page compares transaction inclusion latency and gas fees side by side, and links every number back to on-chain transactions anyone can check.

## What it measures

| Metric | Meaning |
| --- | --- |
| Chain-side inclusion (headline) | Timestamp of the block that included the transaction minus the moment the client started submitting. Whole-second block timestamps make this accurate to about 1 s. |
| RPC accept | Round trip of `eth_sendRawTransaction` to each chain's public RPC. |
| Observed inclusion (secondary) | When the client saw the including block, polling every 500 ms. Includes RPC round trip and polling delay. |
| Fee per transaction | `gasUsed × effectiveGasPrice` from each receipt, in HYPE on both chains. |
| Execution gas vs posting gas | Elysium (Arbitrum Nitro) receipts report `gasUsedForL1`, the gas charged for posting data to the parent chain. Execution gas is the rest, and it matches HyperEVM exactly because the bytecode is identical. |

Comparisons use only samples from the window in which both chains were running. Recovered or rebroadcast transactions are excluded from percentiles. The latency difference carries a 95% bootstrap interval with 10,000 resamples and a fixed seed. No result is shown until each chain has 200 samples, and results are labelled provisional until the shared window reaches 24 hours. The page's Methodology section covers the caveats. The main ones:
- **Finality differs:** HyperEVM (HyperBFT) is final at inclusion, while Elysium inclusion is a sequencer confirmation.
- **Elysium blocks:** Elysium produces a block per transaction.
- **Gas prices:** testnet gas prices are chain parameters, not market prices.

## How it works

```
                  ┌──────────────────────────┐
  loop ──────────▶│ Elysium testnet (99801)  │   10 pulse() tx per UTC minute
  (benchmark-10)  └──────────────────────────┘
                  ┌──────────────────────────┐
  loop-hyperevm ─▶│ HyperEVM testnet (998)   │   same contract, same load
                  └──────────────────────────┘
        │ journals (state.json + daily NDJSON archives)
        ▼
  dashboard ── /api/compare (sanitized snapshot) ──▶ /  (Elysium vs HyperEVM page)
            └─ /api/dashboard ────────────────────▶ /operator (private, tailnet only)
```

- `src/benchmark.mjs`: the per-chain benchmark engine. It prepares and signs a batch of 10 fixed-nonce transactions and journals them before any broadcast. It sends them within a per-chain RPC request budget and watches new blocks every 500 ms to time inclusion. It reconciles after crashes and settles cost from each receipt.
- `src/compare-snapshot.mjs`: the only path from journals to the public page. It allowlists fields and never includes the benchmark account, balances, spend, nonces or operator holds. Tests enforce this with a recursive schema check and a canary for the account address.
- `public/compare.*`: the static comparison page. There is no framework, and charts are plain SVG. Every asset path is relative, so it can be hosted as static files.
- `contracts/MinutePulse.sol`: a counter that only its deployer's address may call.

## Safety model

- **Pinned chains.** The chains are pinned in `src/config.mjs`: RPC URL, chain ID and an anchor block hash. Nothing in the environment can change them, and `--chain` selects one.
- **One journal per chain.** Each journal records its chain ID, and a journal for another chain is refused.
- **Live gates.** No write happens unless `ELYSIUM_LIVE_ENABLED=true` and `--live` are both set. Benchmark mode also requires `ELYSIUM_BENCHMARK_ENABLED=true`, `--profile benchmark-10` and the `compose.benchmark.yaml` overlay.
- **Nonce authority.** The journal owns the nonces. Every signed transaction is persisted before broadcast. A nonce consumed by an unknown transaction halts the loop for operator review.
- **Cost limits.** Circuit breakers cap cost, gas and fee per transaction, keep a balance reserve, and enforce a daily budget. Worst-case cost is reserved at prepare time.
- **Stop switch.** A `HALT` file stops all writes immediately.
- **Wallet key.** The key is generated locally at `~/.config/elysium-minute-loop/wallet.json` with `0600` permissions. It is never printed, logged or committed, and it is never mounted into the dashboard container.

## Quick start

Requirements: Node.js 22+, and Docker with Compose for the long-running setup.

```bash
npm ci
npm test
npm run generate:wallet        # prints the public address only
```

Fund that address with testnet HYPE on both chains:

- **HyperEVM testnet:** get HYPE on Hyperliquid testnet (HyperCore), then transfer it to HyperEVM. For example, use the testnet UI to send it to the HYPE system address `0x2222222222222222222222222222222222222222`.
- **Elysium testnet:** bridge HYPE to Elysium with the official Elysium testnet bridge.

Check both chains, then deploy once per chain:

```bash
npm run verify:rpc
npm run verify:rpc -- --chain hyperevm-testnet
ELYSIUM_LIVE_ENABLED=true npm run deploy
ELYSIUM_LIVE_ENABLED=true npm run deploy -- --chain hyperevm-testnet
```

Run the benchmark on both chains and the dashboard with Docker:

```bash
cp .env.example .env           # set DASHBOARD_BIND_IP to the private address the dashboard should bind to
install -d -m 700 ~/.local/state/elysium-minute-loop ~/.local/state/elysium-minute-loop-hyperevm
docker compose build loop
docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up -d
```

The comparison page is served at `http://<DASHBOARD_BIND_IP>:8789/`. Without the overlay, `docker compose up` runs only the conservative one-transaction-per-minute `serial-1` profile on Elysium.

The operator view at `/operator` shows the benchmark account, balance and holds. Keep it on a private network. It is read-only but not authenticated. See [docs/operator-profiles.md](docs/operator-profiles.md) for:
- profiles and budgets;
- holds and stuck-nonce recovery;
- journal rotation;
- the Tailscale ACL for the dashboard.

## Development

```bash
npm test               # node:test, no network
npm run lint           # eslint
npm run format:check   # prettier
```

CI runs all three on Node 22 and 24, plus `npm audit`.

## License

[MIT](LICENSE) © 2026 Bruno Muniz · [GitHub](https://github.com/brunoamuniz) · [X](https://x.com/0xbrunoamuniz) · [LinkedIn](https://www.linkedin.com/in/brunoamuniz/)
