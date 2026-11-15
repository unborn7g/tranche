import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach } from 'node:test';
import ganache from 'ganache';
import {
  createPublicClient, createWalletClient, custom, decodeErrorResult, defineChain,
  encodeFunctionData, keccak256, parseEther, parseUnits, stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { reviewTypes } from '../src/mezo.js';

const chain = defineChain({
  id: 1337,
  name: 'Local test EVM',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
const provider = ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true } });
const transport = custom(provider, { retryCount: 0 });
const reader = createPublicClient({ chain, transport, pollingInterval: 20, cacheTime: 0 });
const accounts = Object.values(provider.getInitialAccounts()).map(entry => privateKeyToAccount(entry.secretKey));
const [owner, reviewer, contractor, supplier, outsider] = accounts;
const wallet = account => createWalletClient({ account, chain, transport });
const json = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const escrowArtifact = json('../src/generated/Tranche.json');
const mockToken = json('../test/generated/MockToken.json');
const mockRouter = json('../test/generated/MockRouter.json');

const Decision = { approve: 0, dispute: 1, refund: 2 };
const Status = { pending: 0, approved: 1, disputed: 2, paid: 3, refunded: 4 };
const musd = amount => parseEther(String(amount));
const usdc = amount => parseUnits(String(amount), 6);
const deadline = () => BigInt(Math.floor(Date.now() / 1_000) + 600);
const evidenceHash = keccak256(stringToHex('Inspector certificate'));
const title = 'Electrical installation';
const workItems = [
  { label: 'Electrical materials', recipient: supplier.address, budget: musd(600) },
  { label: 'First-fix installation', recipient: contractor.address, budget: musd(300) },
  { label: 'Final testing', recipient: contractor.address, budget: musd(300) },
];
const totalBudget = items => items.reduce((sum, item) => sum + item.budget, 0n);
const sampleBudget = totalBudget(workItems);
let token, payoutToken, router, escrow, snapshotId;

async function deploy(artifact, args = []) {
  const hash = await wallet(owner).deployContract({ ...artifact, args });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return { abi: artifact.abi, address: receipt.contractAddress };
}

async function send(account, contract, functionName, args) {
  const hash = await wallet(account).writeContract({ ...contract, functionName, args, gas: 2_000_000n });
  return reader.waitForTransactionReceipt({ hash });
}

async function write(account, contract, functionName, args) {
  const receipt = await send(account, contract, functionName, args);
  assert.equal(receipt.status, 'success', functionName);
  return receipt;
}

async function expectRevert(account, contract, functionName, args, expected) {
  const data = encodeFunctionData({ abi: contract.abi, functionName, args });
  await assert.rejects(
    provider.request({ method: 'eth_call', params: [{ from: account.address, to: contract.address, data }, 'latest'] }),
    error => {
      assert.equal(typeof error.data, 'string', error.message);
      const reverted = decodeErrorResult({ abi: contract.abi, data: error.data });
      const reason = reverted.errorName === 'Error' ? reverted.args[0] : reverted.errorName;
      assert.equal(reason, expected);
      return true;
    },
  );
}

const read = (contract, functionName, args = []) => reader.readContract({ ...contract, functionName, args });
const milestoneState = id => read(escrow, 'getMilestone', [id]);
const balance = (address, asset = token) => read(asset, 'balanceOf', [address]);
const approveEscrow = amount => write(owner, token, 'approve', [escrow.address, amount]);

async function createMilestone(items = workItems) {
  const id = await read(escrow, 'nextId');
  await write(owner, escrow, 'createMilestone', [title, reviewer.address, items]);
  return id;
}

async function createFunded(items = workItems) {
  const id = await createMilestone(items);
  await approveEscrow(totalBudget(items));
  await write(owner, escrow, 'fund', [id]);
  return id;
}

function review(id, index, decision = Decision.approve, revision = 1n) {
  return { milestoneId: id, lineIndex: BigInt(index), decision, evidenceHash, revision, deadline: deadline() };
}

function sign(cert, { signer = reviewer, chainId = chain.id, verifyingContract = escrow.address } = {}) {
  return signer.signTypedData({
    domain: { name: 'Tranche', version: '1', chainId, verifyingContract },
    types: reviewTypes, primaryType: 'Review', message: cert,
  });
}

async function reviewArgs(...certificates) {
  return [certificates, await Promise.all(certificates.map(certificate => sign(certificate)))];
}

async function apply(...certificates) {
  return write(outsider, escrow, 'applyReviews', await reviewArgs(...certificates));
}

const payment = (index, extraMusd = 0n, minOut = 0n) => ({ lineIndex: BigInt(index), extraMusd, minOut });
const settle = (id, ...payments) => write(owner, escrow, 'settle', [id, payments, deadline()]);

before(async () => {
  token = await deploy(mockToken, ['MUSD', 18]);
  payoutToken = await deploy(mockToken, ['mUSDC', 6]);
  router = await deploy(mockRouter);
  escrow = await deploy(escrowArtifact, [token.address, payoutToken.address, router.address, owner.address]);
  await write(owner, token, 'mint', [owner.address, musd(20_000)]);
});

beforeEach(async () => {
  snapshotId = await provider.request({ method: 'evm_snapshot', params: [] });
});

afterEach(async () => {
  assert.equal(await provider.request({ method: 'evm_revert', params: [snapshotId] }), true);
});

after(() => provider.disconnect());

export {
  chain, owner, reviewer, contractor, supplier, outsider,
  Decision, Status, musd, usdc, deadline, evidenceHash, title, workItems, totalBudget, sampleBudget,
  token, payoutToken, router, escrow,
  send, write, expectRevert, read, milestoneState, balance, approveEscrow,
  createMilestone, createFunded, review, sign, reviewArgs, apply, payment, settle,
};
