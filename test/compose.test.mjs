import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BIND = '${DASHBOARD_BIND_IP:?set DASHBOARD_BIND_IP to your Tailscale IP}';
const root = (file) => new URL(`../${file}`, import.meta.url);
const read = (file) => fs.readFile(root(file), 'utf8');

test('the dashboard is published only on the Tailscale address, never on localhost or a wildcard', async () => {
  const compose = await read('compose.yaml');
  const published = [...compose.matchAll(/^\s+-\s+"([^"]+:\d+:\d+)"/gm)].map((match) => match[1]);
  assert.deepEqual(
    published,
    [`${BIND}:8789:8787`],
    'the only published port binds to the operator-supplied Tailscale address, and compose fails if it is unset',
  );
  for (const forbidden of ['0.0.0.0:', '127.0.0.1:8', '"8787:8787"', '"8789:8789"', 'localhost:']) {
    assert.ok(!compose.includes(forbidden), `compose publishes on ${forbidden}`);
  }
  assert.ok(
    compose.includes(`ELYSIUM_DASHBOARD_ALLOWED_HOSTS: "${BIND}:8789"`),
    'container-wide binding requires an explicit allowed host',
  );
  assert.ok(
    !/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/.test(compose.replaceAll('0.0.0.0', '')),
    'no concrete IP address is committed',
  );
  assert.ok(!/\/home\/(?!node\/)[a-z]/.test(compose), 'host paths use ${HOME}, not a committed username');
  assert.match(compose, /ELYSIUM_DASHBOARD_BIND_HOST: "0\.0\.0\.0"/);
});

test('the loop container never publishes a port and the dashboard mounts state read-only', async () => {
  const compose = await read('compose.yaml');
  const [loop, dashboard] = compose.split('  dashboard:');
  assert.ok(!loop.includes('ports:'), 'the writer container must not be reachable over the network');
  assert.match(dashboard, /elysium-minute-loop:ro\n/, 'the dashboard mounts the state directory read-only');
  assert.match(
    dashboard,
    /elysium-minute-loop-hyperevm:\/home\/node\/\.local\/state\/elysium-minute-loop-hyperevm:ro\n/,
    'the dashboard reads the HyperEVM journal read-only',
  );
  assert.match(dashboard, /ELYSIUM_HYPEREVM_STATE_DIR: \/home\/node\/\.local\/state\/elysium-minute-loop-hyperevm\n/);
  assert.ok(!dashboard.includes('.config/elysium-minute-loop'), 'the dashboard must never mount the wallet directory');
});

test('normal compose stays serial and does not enable benchmark writes', async () => {
  const compose = await read('compose.yaml');
  assert.ok(!compose.includes('ELYSIUM_BENCHMARK_ENABLED'), 'benchmark activation belongs in compose.benchmark.yaml');
  assert.ok(!compose.includes('benchmark-10'));
  assert.match(compose, /command: npm run loop\n/);
});

test('benchmark activation requires the overlay file, the env gate, and the explicit profile flag', async () => {
  const overlay = await read('compose.benchmark.yaml');
  assert.match(overlay, /profiles: \["benchmark"\]/, 'the benchmark service must be behind a compose profile');
  assert.match(overlay, /command: npm run loop:benchmark/);
  assert.match(overlay, /ELYSIUM_LIVE_ENABLED: "true"/);
  assert.match(overlay, /ELYSIUM_BENCHMARK_ENABLED: "true"/);
  assert.ok(!overlay.includes('ports:'), 'the benchmark overlay must not publish a port');
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['loop:benchmark'], 'node scripts/loop.mjs --live --profile benchmark-10');
  assert.equal(pkg.scripts.loop, 'node scripts/loop.mjs --live', 'the default loop script stays serial');
});

test('dockerignore excludes local secrets, state and developer artifacts', async () => {
  const ignored = (await read('.dockerignore'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const entry of [
    '.git',
    'node_modules',
    '.env',
    'state',
    'secrets',
    'logs',
    '*.log',
    '.venv',
    'docs',
    'test',
    'coverage',
    '*.md',
  ]) {
    assert.ok(ignored.includes(entry), `.dockerignore is missing ${entry}`);
  }
  for (const kept of ['contracts', 'public', 'src', 'scripts', 'package.json', 'package-lock.json']) {
    assert.ok(!ignored.includes(kept), `.dockerignore would strip the runtime path ${kept}`);
  }
});

test('the image copies only runtime paths instead of the whole working tree', async () => {
  const dockerfile = await read('Dockerfile');
  assert.ok(!/^COPY \. \.$/m.test(dockerfile), 'COPY . . can carry local .env, state and logs into the image');
  for (const copied of [
    'COPY src ./src',
    'COPY scripts ./scripts',
    'COPY contracts ./contracts',
    'COPY public ./public',
  ]) {
    assert.ok(dockerfile.includes(copied), `Dockerfile is missing ${copied}`);
  }
  assert.match(dockerfile, /^USER node$/m);
});

test('the dashboard footer states the real Tailscale exposure, not loopback-only', async () => {
  const html = await read('public/dashboard.html');
  assert.ok(!html.includes('Loopback only'), 'the footer must not claim loopback-only exposure');
  assert.ok(html.includes('Tailscale-only'));
  assert.ok(html.includes('not identity-authenticated'), 'tailnet visibility is not identity authentication');
});

test('the HyperEVM benchmark loop is opt-in, pinned by both chain selectors, and has its own journal', async () => {
  const overlay = await read('compose.benchmark.yaml');
  const [, hyper] = overlay.split('  loop-hyperevm:');
  assert.ok(hyper, 'compose.benchmark.yaml defines loop-hyperevm');
  assert.match(hyper, /profiles: \["benchmark"\]/);
  assert.match(hyper, /command: npm run loop:benchmark -- --chain hyperevm-testnet\n/);
  assert.match(
    hyper,
    /ELYSIUM_CHAIN: hyperevm-testnet\n/,
    'the env selector must agree with the flag or the loop refuses to start',
  );
  assert.match(hyper, /ELYSIUM_STATE_DIR: \/home\/node\/\.local\/state\/elysium-minute-loop-hyperevm\n/);
  assert.match(hyper, /elysium-minute-loop-hyperevm:\/home\/node\/\.local\/state\/elysium-minute-loop-hyperevm\n/);
  assert.ok(!/state\/elysium-minute-loop:/.test(hyper), 'the HyperEVM loop must never mount the Elysium journal');
  assert.match(hyper, /image: elysium-minute-loop:local\n/, 'both loops run the same image');
  assert.ok(!hyper.includes('ports:'));
});
