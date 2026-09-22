import { pulseOnce } from './run-once.mjs';
import { benchmarkLogRedactor, systemClock, utcMinute } from './benchmark.mjs';
import { buildAggregates } from './benchmark-metrics.mjs';
import { saveAggregates } from './state.mjs';

function utcSlot(date = new Date()) {
  return date.toISOString().slice(0, 16) + 'Z';
}
export function millisecondsToNextMinute(now = new Date()) {
  return 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}

export async function runLoop({
  account,
  config,
  signal = process,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  signal.once?.('SIGINT', stop);
  signal.once?.('SIGTERM', stop);
  while (!stopping) {
    const startedSlot = utcSlot();
    try {
      await pulseOnce(account, config, new Date());
      console.log(JSON.stringify({ type: 'pulse_finalized', slot: startedSlot }));
    } catch (error) {
      console.error(
        JSON.stringify({
          type: error.code === 'HOLD' ? 'pulse_hold' : 'pulse_halt',
          slot: startedSlot,
          error: error.message,
        }),
      );
      break;
    }
    if (!stopping) await sleep(millisecondsToNextMinute());
  }
}

export async function runBenchmarkLoop({
  owner,
  config,
  benchmark,
  clock = systemClock(),
  signal = process,
  log = (entry) => console.log(JSON.stringify(entry)),
  maxSlots = Infinity,
}) {
  const write = log;
  log = (entry) => write(benchmarkLogRedactor(entry));
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  signal.once?.('SIGINT', stop);
  signal.once?.('SIGTERM', stop);
  let slots = 0;
  let running = true;
  const watcher =
    typeof owner.watch === 'function' && benchmark.watchIntervalMs > 0
      ? (async () => {
          while (running && !stopping) {
            try {
              await owner.watch();
            } catch (error) {
              log({ type: 'benchmark_watch_failed', code: error.code ?? 'ERROR' });
            }
            await clock.sleep(benchmark.watchIntervalMs);
          }
        })()
      : null;
  while (!stopping && slots < maxSlots) {
    slots += 1;
    const slot = utcMinute(clock.now());
    try {
      log({ type: 'benchmark_slot', slot, ...(await owner.runSlot(slot)) });
    } catch (error) {
      log({ type: error.code === 'HALT' ? 'benchmark_halt' : 'benchmark_hold', slot, code: error.code ?? 'ERROR' });
      if (error.code === 'HALT') break;
    }
    const deadline = clock.now().getTime() + millisecondsToNextMinute(clock.now());
    while (!stopping && clock.now().getTime() < deadline) {
      await clock.sleep(Math.max(1, Math.min(benchmark.pollIntervalMs, deadline - clock.now().getTime())));
      try {
        await owner.track();
      } catch (error) {
        log({ type: error.code === 'HALT' ? 'benchmark_halt' : 'benchmark_hold', slot, code: error.code ?? 'ERROR' });
        if (error.code === 'HALT') {
          stopping = true;
        }
      }
    }
    try {
      await saveAggregates(config.stateDir, buildAggregates(owner.state, { now: clock.now() }));
      await owner.compact();
    } catch {
      log({ type: 'benchmark_aggregate_failed', slot });
    }
  }
  running = false;
  await watcher;
  return { slots };
}
