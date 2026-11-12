import { readFileSync } from 'node:fs';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contracts, getMusdc, makeReader, mezo } from '../src/mezo.js';

const key = process.env.MEZO_TESTNET_DEPLOYER_KEY;
if (!key || !/^0x[\da-f]{64}$/i.test(key)) {
  throw new Error('Set MEZO_TESTNET_DEPLOYER_KEY to the private key of a dedicated testnet wallet.');
}
const account = privateKeyToAccount(key);
const reader = makeReader();
const chainId = await reader.getChainId();
if (chainId !== mezo.id) throw new Error(`Expected testnet chain ${mezo.id}, received ${chainId}.`);
const balance = await reader.getBalance({ address: account.address });
if (!balance) throw new Error('Fund the deployer with testnet BTC at https://faucet.test.mezo.org/.');

const artifact = JSON.parse(readFileSync(new URL('../src/generated/Tranche.json', import.meta.url), 'utf8'));
const wallet = createWalletClient({ account, chain: mezo, transport: http() });
const hash = await wallet.deployContract({
  ...artifact, args: [contracts.musd, await getMusdc(reader), contracts.router, contracts.factory],
});
const explorer = mezo.blockExplorers.default.url;
console.log(`Deployment transaction ${explorer}/tx/${hash}`);
const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Testnet deployment reverted.');
console.log(`Escrow ${explorer}/address/${receipt.contractAddress}`);
