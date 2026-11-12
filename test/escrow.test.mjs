import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain, keccak256, parseEther, parseUnits, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { reviewTypes } from '../src/mezo.js';

const chain = defineChain({ id: 1337, name: 'Local test EVM', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const provider = ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true, totalAccounts: 6 } });
const transport = custom(provider);
const reader = createPublicClient({ chain, transport, pollingInterval: 20 });
const accounts = Object.values(provider.getInitialAccounts()).map(entry => privateKeyToAccount(entry.secretKey));
const [owner, reviewer, contractor, supplier, outsider] = accounts;
const wallet = account => createWalletClient({ account, chain, transport });
const json = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const escrowArtifact = json('../src/generated/Tranche.json');
const mockToken = json('./generated/MockToken.json');
const mockRouter = json('./generated/MockRouter.json');
const musd = amount => parseEther(String(amount));
const usdc = amount => parseUnits(String(amount), 6);
const deadline = () => BigInt(Math.floor(Date.now() / 1_000) + 600);
const evidenceHash = keccak256(stringToHex('Inspector certificate: materials and first fix approved'));
const lines = [
  { label: 'Electrical materials', recipient: supplier.address, budget: musd(600) },
  { label: 'First-fix installation', recipient: contractor.address, budget: musd(300) },
  { label: 'Final testing', recipient: contractor.address, budget: musd(300) },
];
let token, payoutToken, router, escrow;

async function deploy(artifact, args = []) {
  const hash = await wallet(owner).deployContract({ ...artifact, args });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return { abi: artifact.abi, address: receipt.contractAddress };
}

async function write(account, contract, functionName, args = []) {
  const { request } = await reader.simulateContract({ ...contract, functionName, args, account: account.address });
  const hash = await wallet(account).writeContract({ ...request, account, gas: 2_000_000n });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}

function read(contract, functionName, args = []) {
  return reader.readContract({ ...contract, functionName, args });
}

async function createFunded() {
  const id = await read(escrow, 'nextId');
  await write(owner, escrow, 'createMilestone', ['Electrical installation', reviewer.address, lines]);
  await write(owner, token, 'approve', [escrow.address, musd(1200)]);
  await write(owner, escrow, 'fund', [id]);
  return id;
}

const review = (id, index, decision, revision = 1n) => ({ milestoneId: id, lineIndex: BigInt(index), decision, evidenceHash, revision, deadline: deadline() });
const signed = (cert, signer = reviewer) => signer.signTypedData({
  domain: { name: 'Tranche', version: '1', chainId: chain.id, verifyingContract: escrow.address },
  types: reviewTypes, primaryType: 'Review', message: cert,
});

async function apply(certs, signer = reviewer) {
  return write(outsider, escrow, 'applyReviews', [certs, await Promise.all(certs.map(cert => signed(cert, signer)))]);
}

const payment = (index, extraMusd = 0n, minOut = 0n) => ({ lineIndex: BigInt(index), extraMusd, minOut });

before(async () => {
  token = await deploy(mockToken, ['MUSD', 18]);
  payoutToken = await deploy(mockToken, ['mUSDC', 6]);
  router = await deploy(mockRouter);
  escrow = await deploy(escrowArtifact, [token.address, payoutToken.address, router.address, owner.address]);
  await write(owner, token, 'mint', [owner.address, musd(20_000)]);
});

after(() => provider.disconnect());

test('owner funds 1,200 MUSD, reviewer certifies 900, two payees are paid and 300 stays held', async () => {
  const id = await createFunded();
  await assert.rejects(write(outsider, escrow, 'fund', [id]));
  await assert.rejects(write(owner, escrow, 'fund', [id]));
  const certs = [review(id, 0, 0), review(id, 1, 0), review(id, 2, 1)];
  const supplierBefore = await read(token, 'balanceOf', [supplier.address]);
  const contractorBefore = await read(token, 'balanceOf', [contractor.address]);
  await apply(certs);
  await assert.rejects(apply(certs));
  await assert.rejects(write(owner, escrow, 'settle', [id, [payment(0), payment(2)], deadline()]));
  assert.equal((await read(escrow, 'getMilestone', [id]))[0].held, musd(1200));
  await write(owner, escrow, 'settle', [id, [payment(0), payment(1)], deadline()]);
  const [milestone, assessed] = await read(escrow, 'getMilestone', [id]);
  assert.equal(milestone.held, musd(300));
  assert.deepEqual(assessed.map(line => line.status), [3, 3, 2]);
  assert.equal(await read(token, 'balanceOf', [supplier.address]), supplierBefore + musd(600));
  assert.equal(await read(token, 'balanceOf', [contractor.address]), contractorBefore + musd(300));
  await assert.rejects(write(owner, escrow, 'settle', [id, [payment(0)], deadline()]));
  await apply([review(id, 2, 2, 2n)]);
  assert.equal((await read(escrow, 'getMilestone', [id]))[0].held, 0n);
});

test('rejects altered, expired and unauthorized reviewer certificates', async () => {
  const id = await createFunded();
  const valid = review(id, 0, 0);
  await assert.rejects(apply([valid], outsider));
  await assert.rejects(write(owner, escrow, 'applyReviews', [[{ ...valid, lineIndex: 1n }], [await signed(valid)]]));
  await assert.rejects(apply([{ ...valid, deadline: 1n }]));
  assert.equal((await read(escrow, 'getMilestone', [id]))[1][0].status, 0);
});

test('mUSDC payout protects the recipient minimum and uses a separate MUSD top-up', async () => {
  const id = await createFunded();
  await apply([review(id, 0, 0), review(id, 1, 0), review(id, 2, 1)]);
  await assert.rejects(write(owner, escrow, 'setPayout', [id, 1n, usdc(300)]));
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  assert.equal(await read(escrow, 'quoteMusdc', [musd(300)]), usdc('298.5'));
  await assert.rejects(write(owner, escrow, 'settle', [id, [payment(0), payment(1, 0n, usdc(300))], deadline()]));
  assert.equal((await read(escrow, 'getMilestone', [id]))[0].held, musd(1200));
  await write(owner, token, 'approve', [escrow.address, musd(2)]);
  const prior = await read(payoutToken, 'balanceOf', [contractor.address]);
  await write(owner, escrow, 'settle', [id, [payment(0), payment(1, musd(2), usdc(300))], deadline()]);
  const [milestone, assessed] = await read(escrow, 'getMilestone', [id]);
  assert.equal(milestone.held, musd(300));
  assert.equal(assessed[1].amountPaid, usdc('300.49'));
  assert.equal(await read(payoutToken, 'balanceOf', [contractor.address]), prior + usdc('300.49'));
  assert.equal(await read(token, 'allowance', [escrow.address, router.address]), 0n);
});

test('dispute revision can approve a corrected line while other milestones remain funded', async () => {
  const id = await createFunded();
  await apply([review(id, 2, 1)]);
  await assert.rejects(write(outsider, escrow, 'settle', [id, [payment(2)], deadline()]));
  await apply([review(id, 2, 0, 2n)]);
  await write(owner, escrow, 'settle', [id, [payment(2)], deadline()]);
  const [milestone, assessed] = await read(escrow, 'getMilestone', [id]);
  assert.equal(milestone.held, musd(900));
  assert.equal(assessed[2].status, 3);
});
