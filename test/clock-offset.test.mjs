import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_REFRESH_MS,
  CLOCK_STALE_MS,
  clockOffsetTracker,
  medianOffset,
  offsetFromResponse,
} from '../src/clock-offset.mjs';

function ntpResponse({ receivedMs, sentMs, mode = 4, stratum = 2 }) {
  const buffer = Buffer.alloc(48);
  buffer[0] = (4 << 3) | mode;
  buffer[1] = stratum;
  const write = (offset, ms) => {
    const seconds = Math.floor(ms / 1000) + 2_208_988_800;
    buffer.writeUInt32BE(seconds, offset);
    buffer.writeUInt32BE(Math.round(((ms % 1000) / 1000) * 2 ** 32), offset + 4);
  };
  write(32, receivedMs);
  write(40, sentMs);
  return buffer;
}

test('an SNTP reply yields the host offset with the network delay removed', () => {
  const local = Date.parse('2026-09-23T10:00:00.000Z');
  const reply = ntpResponse({ receivedMs: local + 1200 + 50, sentMs: local + 1200 + 51 });
  const result = offsetFromResponse(reply, local, local + 101);
  assert.ok(Math.abs(result.offsetMs - 1200) < 1, 'a host 1.2 s behind reads a +1200 ms offset');
  assert.ok(Math.abs(result.rttMs - 100) < 1);
});

test('malformed, non-server or slow replies are rejected', () => {
  const local = Date.parse('2026-09-23T10:00:00.000Z');
  assert.equal(offsetFromResponse(Buffer.alloc(10), local, local + 10), null);
  assert.equal(offsetFromResponse(ntpResponse({ receivedMs: local, sentMs: local, mode: 3 }), local, local + 10), null);
  assert.equal(
    offsetFromResponse(ntpResponse({ receivedMs: local, sentMs: local, stratum: 0 }), local, local + 10),
    null,
    'kiss-of-death replies carry stratum 0',
  );
  assert.equal(
    offsetFromResponse(ntpResponse({ receivedMs: local, sentMs: local }), local, local + 900),
    null,
    'a round trip over 500 ms is too imprecise',
  );
});

test('the offset is the median of at least two servers', () => {
  assert.equal(
    medianOffset([{ offsetMs: 30 }, { offsetMs: 1200 }, { offsetMs: 35 }]),
    35,
    'one bad server cannot move the result',
  );
  assert.equal(medianOffset([{ offsetMs: 30 }, { offsetMs: 40 }]), 35);
  assert.equal(medianOffset([{ offsetMs: 30 }, null, null]), null, 'a single server is not enough');
});

test('the tracker refreshes every 5 minutes and stops vouching for an offset after 15', async () => {
  let mono = 0;
  let replies = [{ offsetMs: 1200 }, { offsetMs: 1210 }, { offsetMs: 1190 }];
  const tracker = clockOffsetTracker({
    query: async () => replies.shift() ?? null,
    monotonic: () => mono,
    wall: () => mono,
  });
  assert.equal(tracker.current(), null);
  assert.equal(tracker.due(), true);
  assert.deepEqual(await tracker.refresh(), { offsetMs: 1200, servers: 3, atMono: 0, atWall: 0 });
  assert.equal(tracker.due(), false);
  mono = CLOCK_REFRESH_MS + 1;
  assert.equal(tracker.due(), true);
  assert.equal(tracker.current().offsetMs, 1200, 'still usable between refresh and staleness');
  replies = [null, null, null];
  await tracker.refresh();
  assert.equal(tracker.current().offsetMs, 1200, 'a failed refresh keeps the last good offset');
  mono = CLOCK_STALE_MS + 1;
  assert.equal(tracker.current(), null, 'a stale offset is never applied');
});

test('a wall-clock step since the last measurement voids the offset until it is measured again', async () => {
  let mono = 0;
  let wallShift = 0;
  const tracker = clockOffsetTracker({
    query: async () => ({ offsetMs: 1200 }),
    monotonic: () => mono,
    wall: () => mono + wallShift,
  });
  await tracker.refresh();
  mono = 30_000;
  assert.equal(tracker.current().offsetMs, 1200);
  wallShift = 1200;
  assert.equal(tracker.current(), null, 'the host clock jumped, so the old correction no longer applies');
  assert.equal(tracker.due(), true, 'a jump forces a fresh measurement');
  await tracker.refresh();
  assert.equal(tracker.current().offsetMs, 1200);
});

test('replies from servers that admit an unsynchronized clock are ignored', () => {
  const local = Date.parse('2026-09-23T10:00:00.000Z');
  const alarm = ntpResponse({ receivedMs: local + 5000, sentMs: local + 5001 });
  alarm[0] |= 3 << 6;
  assert.equal(
    offsetFromResponse(alarm, local, local + 10),
    null,
    'leap indicator 3 means the server clock is not set',
  );
  const zeroed = ntpResponse({ receivedMs: local, sentMs: local });
  zeroed.fill(0, 32, 40);
  assert.equal(offsetFromResponse(zeroed, local, local + 10), null, 'a zero receive timestamp is not a real reading');
});
