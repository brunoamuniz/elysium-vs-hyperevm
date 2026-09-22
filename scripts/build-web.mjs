import { fileURLToPath } from 'node:url';
import { SNAPSHOT_URL, writeWeb } from '../src/web-build.mjs';

try {
  const written = await writeWeb({
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    outDir: fileURLToPath(new URL('../web', import.meta.url)),
    snapshotUrl: process.env.WEB_SNAPSHOT_URL ?? SNAPSHOT_URL,
  });
  console.log(JSON.stringify({ type: 'web_built', files: written }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
