import { generateWallet } from '../src/wallet.mjs';
try {
  const { address, keyPath } = await generateWallet();
  console.log(JSON.stringify({ address, keyPath }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
