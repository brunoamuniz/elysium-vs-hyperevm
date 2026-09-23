import dgram from 'node:dgram';
import dns from 'node:dns';

export const NTP_SERVERS = ['time.google.com', 'time.cloudflare.com', 'pool.ntp.org'];
export const NTP_TIMEOUT_MS = 2_000;
export const NTP_MAX_RTT_MS = 500;
export const CLOCK_REFRESH_MS = 300_000;
export const CLOCK_STALE_MS = 900_000;
export const CLOCK_MIN_SERVERS = 2;
export const CLOCK_STEP_TOLERANCE_MS = 100;
const NTP_EPOCH_OFFSET_S = 2_208_988_800;

function ntpTimeMs(buffer, offset) {
  return (buffer.readUInt32BE(offset) - NTP_EPOCH_OFFSET_S) * 1000 + (buffer.readUInt32BE(offset + 4) * 1000) / 2 ** 32;
}

export function offsetFromResponse(response, sentMs, receivedMs) {
  if (!Buffer.isBuffer(response) || response.length < 48) return null;
  const mode = response[0] & 0x07;
  const stratum = response[1];
  if (response[0] >> 6 === 3 || mode !== 4 || stratum < 1 || stratum > 15) return null;
  if (response.readUInt32BE(32) === 0 || response.readUInt32BE(40) === 0) return null;
  const serverReceived = ntpTimeMs(response, 32);
  const serverSent = ntpTimeMs(response, 40);
  const rttMs = receivedMs - sentMs - (serverSent - serverReceived);
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > NTP_MAX_RTT_MS) return null;
  return { offsetMs: (serverReceived - sentMs + (serverSent - receivedMs)) / 2, rttMs };
}

export function queryNtp(host, { now = () => Date.now(), timeoutMs = NTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(48);
    request[0] = 0x1b;
    let sentMs = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (response) => finish(offsetFromResponse(response, sentMs, now())));
    dns.lookup(host, { family: 4 }, (lookupError, address) => {
      if (done) return;
      if (lookupError) return finish(null);
      sentMs = now();
      socket.send(request, 123, address, (error) => {
        if (error) finish(null);
      });
    });
  });
}

export function medianOffset(samples) {
  const offsets = samples
    .filter((sample) => sample && Number.isFinite(sample.offsetMs))
    .map((sample) => sample.offsetMs)
    .sort((a, b) => a - b);
  if (offsets.length < CLOCK_MIN_SERVERS) return null;
  const middle = Math.floor(offsets.length / 2);
  return offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
}

export function clockOffsetTracker({
  query = queryNtp,
  servers = NTP_SERVERS,
  monotonic = () => performance.now(),
  wall = () => Date.now(),
} = {}) {
  let latest = null;
  const stepped = () => Math.abs(wall() - latest.atWall - (monotonic() - latest.atMono)) > CLOCK_STEP_TOLERANCE_MS;
  return {
    async refresh() {
      const samples = await Promise.all(servers.map((host) => query(host)));
      const offsetMs = medianOffset(samples);
      if (offsetMs === null) return null;
      latest = {
        offsetMs: Math.round(offsetMs),
        servers: samples.filter(Boolean).length,
        atMono: monotonic(),
        atWall: wall(),
      };
      return latest;
    },
    current() {
      if (!latest || monotonic() - latest.atMono > CLOCK_STALE_MS || stepped()) return null;
      return latest;
    },
    due() {
      return !latest || monotonic() - latest.atMono > CLOCK_REFRESH_MS || stepped();
    },
  };
}
