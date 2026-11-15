import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import ganache from 'ganache';
import {
  createPublicClient, createWalletClient, custom, decodeErrorResult, defineChain,
  encodeFunctionData, keccak256, parseEther, parseUnits, stringToHex, zeroAddress, zeroHash,
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
const mockToken = json('./generated/MockToken.json');
const mockRouter = json('./generated/MockRouter.json');

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

// Milestone creation and funding

test('creates an unfunded milestone with item budgets and addresses', async () => {
  const id = await createMilestone();
  const [milestone, lines] = await milestoneState(id);
  assert.deepEqual(milestone, {
    owner: owner.address, reviewer: reviewer.address, title, budget: sampleBudget, held: 0n, funded: false,
  });
  assert.deepEqual(lines.map(({ label, recipient, budget }) => ({ label, recipient, budget })), workItems);
  assert.deepEqual(lines.map(line => line.status), workItems.map(() => Status.pending));
});

test('rejects milestone titles and line counts outside their bounds', async () => {
  for (const args of [
    ['', reviewer.address, workItems],
    ['a'.repeat(121), reviewer.address, workItems],
    [title, reviewer.address, []],
    [title, reviewer.address, Array(13).fill(workItems[0])],
  ]) {
    await expectRevert(owner, escrow, 'createMilestone', args, 'InvalidMilestone');
  }
  assert.equal(await read(escrow, 'nextId'), 1n);
});

test('requires a reviewer distinct from the owner', async () => {
  for (const address of [zeroAddress, owner.address]) {
    await expectRevert(owner, escrow, 'createMilestone', [title, address, workItems], 'InvalidMilestone');
  }
});

test('rejects the reviewer, escrow and zero address as payees', async () => {
  for (const recipient of [reviewer.address, escrow.address, zeroAddress]) {
    const line = { ...workItems[0], recipient };
    await expectRevert(owner, escrow, 'createMilestone', [title, reviewer.address, [line]], 'InvalidLine');
  }
});

test('requires positive budgets and valid work item labels', async () => {
  for (const fields of [{ budget: 0n }, { label: '' }, { label: 'a'.repeat(121) }]) {
    const line = { ...workItems[0], ...fields };
    await expectRevert(owner, escrow, 'createMilestone', [title, reviewer.address, [line]], 'InvalidLine');
  }
});

test('funds the exact milestone budget from the owner balance', async () => {
  const beforeFunding = await balance(owner.address);
  const id = await createFunded();
  const [milestone] = await milestoneState(id);
  assert.equal(milestone.funded, true);
  assert.equal(milestone.held, sampleBudget);
  assert.equal(await balance(escrow.address), sampleBudget);
  assert.equal(await balance(owner.address), beforeFunding - sampleBudget);
});

test('blocks another wallet from funding an unfunded milestone', async () => {
  const id = await createMilestone();
  await expectRevert(outsider, escrow, 'fund', [id], 'Unauthorized');
  const [milestone] = await milestoneState(id);
  assert.equal(milestone.funded, false);
});

test('a failed funding transfer leaves the milestone unfunded', async () => {
  const id = await createMilestone();
  const beforeFunding = await balance(owner.address);
  await approveEscrow(sampleBudget - 1n);
  const receipt = await send(owner, escrow, 'fund', [id]);
  assert.equal(receipt.status, 'reverted');
  const [milestone] = await milestoneState(id);
  assert.equal(milestone.funded, false);
  assert.equal(milestone.held, 0n);
  assert.equal(await balance(escrow.address), 0n);
  assert.equal(await balance(owner.address), beforeFunding);
});

test('blocks a second deposit even after the owner renews the allowance', async () => {
  const id = await createFunded();
  await approveEscrow(sampleBudget);
  await expectRevert(owner, escrow, 'fund', [id], 'InvalidState');
  assert.equal(await balance(escrow.address), sampleBudget);
});

// Signed reviewer decisions

test('records the decision and evidence from a certificate relayed by another wallet', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  const [, [line]] = await milestoneState(id);
  assert.equal(line.status, Status.approved);
  assert.equal(line.revision, 1n);
  assert.equal(line.evidenceHash, evidenceHash);
});

test('rejects a certificate signed by an unassigned reviewer', async () => {
  const id = await createFunded();
  const cert = review(id, 0);
  const signature = await sign(cert, { signer: outsider });
  await expectRevert(outsider, escrow, 'applyReviews', [[cert], [signature]], 'InvalidCertificate');
});

test('rejects changes to a signed decision, item index, evidence or expiry', async () => {
  const id = await createFunded();
  const cert = review(id, 0);
  const signature = await sign(cert);
  for (const fields of [
    { decision: Decision.dispute },
    { lineIndex: 1n },
    { evidenceHash: keccak256(stringToHex('Different evidence')) },
    { deadline: cert.deadline + 1n },
  ]) {
    await expectRevert(outsider, escrow, 'applyReviews', [[{ ...cert, ...fields }], [signature]], 'InvalidCertificate');
  }
});

test('rejects a valid signature for a certificate that has expired', async () => {
  const id = await createFunded();
  const cert = { ...review(id, 0), deadline: 1n };
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(cert), 'Expired');
});

test('blocks review before the milestone is funded', async () => {
  const id = await createMilestone();
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(review(id, 0)), 'InvalidState');
});

test('blocks replay of an already accepted certificate', async () => {
  const id = await createFunded();
  const args = await reviewArgs(review(id, 0));
  await write(outsider, escrow, 'applyReviews', args);
  await expectRevert(outsider, escrow, 'applyReviews', args, 'InvalidCertificate');
  const [, [line]] = await milestoneState(id);
  assert.equal(line.revision, 1n);
});

test('requires the next consecutive review revision', async () => {
  const id = await createFunded();
  const cert = review(id, 0, Decision.approve, 2n);
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(cert), 'InvalidCertificate');
});

test('requires evidence on a signed review', async () => {
  const id = await createFunded();
  const cert = { ...review(id, 0), evidenceHash: zeroHash };
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(cert), 'InvalidCertificate');
});

test('rejects signatures intended for another chain or escrow contract', async () => {
  const id = await createFunded();
  const cert = review(id, 0);
  for (const domain of [{ chainId: chain.id + 1 }, { verifyingContract: router.address }]) {
    await expectRevert(outsider, escrow, 'applyReviews', [[cert], [await sign(cert, domain)]], 'InvalidCertificate');
  }
});

test('rejects reuse of a signature on another funded milestone', async () => {
  const original = await createFunded();
  const other = await createFunded();
  const cert = review(original, 0);
  const moved = { ...cert, milestoneId: other };
  await expectRevert(outsider, escrow, 'applyReviews', [[moved], [await sign(cert)]], 'InvalidCertificate');
});

test('rejects empty, oversized or mismatched review batches', async () => {
  const id = await createFunded();
  const cert = review(id, 0);
  const signature = await sign(cert);
  for (const args of [[[], []], [[cert], []], [Array(13).fill(cert), Array(13).fill(signature)]]) {
    await expectRevert(outsider, escrow, 'applyReviews', args, 'InvalidCertificate');
  }
});

test('a mined review batch rolls back earlier decisions when a later certificate fails', async () => {
  const id = await createFunded();
  const first = review(id, 0);
  const second = review(id, 1);
  const args = [[first, second], [await sign(first), await sign(second, { signer: outsider })]];
  await expectRevert(outsider, escrow, 'applyReviews', args, 'InvalidCertificate');
  assert.equal((await send(outsider, escrow, 'applyReviews', args)).status, 'reverted');
  const [, lines] = await milestoneState(id);
  assert.deepEqual(lines.map(line => line.status), workItems.map(() => Status.pending));
  assert.deepEqual(lines.map(line => line.revision), workItems.map(() => 0n));
});

// Settling work and selecting currencies

test('only the milestone owner can release approved payments', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  await expectRevert(outsider, escrow, 'settle', [id, [payment(0)], deadline()], 'Unauthorized');
});

test('rejects settlement after its deadline', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  await expectRevert(owner, escrow, 'settle', [id, [payment(0)], 1n], 'Expired');
});

test('enforces approval before an item can be paid', async () => {
  const id = await createFunded();
  await expectRevert(owner, escrow, 'settle', [id, [payment(0)], deadline()], 'InvalidState');
  await apply(review(id, 0, Decision.dispute));
  await expectRevert(owner, escrow, 'settle', [id, [payment(0)], deadline()], 'InvalidState');
  assert.equal(await balance(escrow.address), sampleBudget);
});

test('pays two approved recipients and keeps the disputed budget in escrow', async () => {
  const id = await createFunded();
  await apply(review(id, 0), review(id, 1), review(id, 2, Decision.dispute));
  await settle(id, payment(0), payment(1));
  const [milestone, lines] = await milestoneState(id);
  assert.equal(milestone.held, musd(300));
  assert.deepEqual(lines.map(line => line.status), [Status.paid, Status.paid, Status.disputed]);
  assert.equal(await balance(supplier.address), musd(600));
  assert.equal(await balance(contractor.address), musd(300));
  assert.equal(await balance(escrow.address), musd(300));
});

test('a mined payment batch rolls back a transfer when a later item is disputed', async () => {
  const id = await createFunded();
  await apply(review(id, 0), review(id, 2, Decision.dispute));
  const args = [id, [payment(0), payment(2)], deadline()];
  await expectRevert(owner, escrow, 'settle', args, 'InvalidState');
  assert.equal((await send(owner, escrow, 'settle', args)).status, 'reverted');
  const [milestone, [line]] = await milestoneState(id);
  assert.equal(milestone.held, sampleBudget);
  assert.equal(line.status, Status.approved);
  assert.equal(await balance(supplier.address), 0n);
  assert.equal(await balance(escrow.address), sampleBudget);
});

test('prevents paying an item twice within or across batches', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  await expectRevert(owner, escrow, 'settle', [id, [payment(0), payment(0)], deadline()], 'InvalidState');
  await settle(id, payment(0));
  await expectRevert(owner, escrow, 'settle', [id, [payment(0)], deadline()], 'InvalidState');
  assert.equal(await balance(supplier.address), musd(600));
});

test('checks settlement batch size and item indices', async () => {
  const id = await createFunded();
  await expectRevert(owner, escrow, 'settle', [id, [], deadline()], 'InvalidState');
  await expectRevert(owner, escrow, 'settle', [id, Array(4).fill(payment(0)), deadline()], 'InvalidState');
  await expectRevert(owner, escrow, 'settle', [id, [payment(3)], deadline()], 'InvalidLine');
});

test('rejects swap parameters when the recipient selected direct MUSD', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  for (const invalid of [payment(0, 1n), payment(0, 0n, 1n)]) {
    await expectRevert(owner, escrow, 'settle', [id, [invalid], deadline()], 'InvalidState');
  }
});

test('reserves the payout preference for the recipient of that item', async () => {
  const id = await createFunded();
  for (const account of [owner, reviewer, supplier]) {
    await expectRevert(account, escrow, 'setPayout', [id, 1n, usdc(300)], 'Unauthorized');
  }
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  const [, lines] = await milestoneState(id);
  assert.equal(lines[1].minMusdc, usdc(300));
});

test('lets a recipient return to direct MUSD before settlement', async () => {
  const id = await createFunded();
  await apply(review(id, 1));
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  await write(contractor, escrow, 'setPayout', [id, 1n, 0n]);
  await settle(id, payment(1));
  assert.equal(await balance(contractor.address), musd(300));
  assert.equal(await balance(contractor.address, payoutToken), 0n);
});

test('uses a separate owner top-up to meet a recipient’s mUSDC minimum', async () => {
  const id = await createFunded();
  await apply(review(id, 0), review(id, 1), review(id, 2, Decision.dispute));
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  assert.equal(await read(escrow, 'quoteMusdc', [musd(300)]), usdc('298.5'));
  await expectRevert(owner, escrow, 'settle', [id, [payment(0), payment(1, 0n, usdc(300))], deadline()], 'quote expired or too low');
  const ownerBefore = await balance(owner.address);
  await approveEscrow(musd(2));
  await settle(id, payment(0), payment(1, musd(2), usdc(300)));
  const [milestone, lines] = await milestoneState(id);
  assert.equal(milestone.held, musd(300));
  assert.equal(lines[1].amountPaid, usdc('300.49'));
  assert.equal(await balance(owner.address), ownerBefore - musd(2));
  assert.equal(await balance(supplier.address), musd(600));
  assert.equal(await balance(contractor.address, payoutToken), usdc('300.49'));
  assert.equal(await read(token, 'allowance', [escrow.address, router.address]), 0n);
});

test('requires a positive settlement minimum and uses the higher mUSDC limit', async () => {
  const id = await createFunded();
  await apply(review(id, 1));
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  await approveEscrow(musd(2));
  await expectRevert(owner, escrow, 'settle', [id, [payment(1)], deadline()], 'InvalidState');
  await expectRevert(owner, escrow, 'settle', [id, [payment(1, musd(2), usdc(301))], deadline()], 'quote expired or too low');
  await expectRevert(owner, escrow, 'settle', [id, [payment(1, 0n, usdc(298))], deadline()], 'quote expired or too low');
});

test('a mined swap underpayment restores the top-up, earlier transfers and escrow balance', async () => {
  const id = await createFunded();
  await apply(review(id, 0), review(id, 1));
  await write(contractor, escrow, 'setPayout', [id, 1n, usdc(300)]);
  await write(owner, router, 'setDeliveryBps', [9_000n]);
  await approveEscrow(musd(2));
  const ownerBefore = await balance(owner.address);
  const args = [id, [payment(0), payment(1, musd(2), usdc(300))], deadline()];
  await expectRevert(owner, escrow, 'settle', args, 'InsufficientPayout');
  assert.equal((await send(owner, escrow, 'settle', args)).status, 'reverted');
  const [milestone, lines] = await milestoneState(id);
  assert.equal(milestone.held, sampleBudget);
  assert.deepEqual(lines.map(line => line.status), [Status.approved, Status.approved, Status.pending]);
  assert.equal(await balance(owner.address), ownerBefore);
  assert.equal(await balance(escrow.address), sampleBudget);
  assert.equal(await balance(supplier.address), 0n);
  assert.equal(await balance(contractor.address, payoutToken), 0n);
  assert.equal(await balance(router.address), 0n);
  assert.equal(await read(token, 'allowance', [escrow.address, router.address]), 0n);
});

// Disputes, refunds and conservation of the budget

test('requires a dispute before a reviewer can authorize a refund', async () => {
  const id = await createFunded();
  const refundPending = review(id, 0, Decision.refund);
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(refundPending), 'InvalidState');
  await apply(review(id, 0));
  const refundApproved = review(id, 0, Decision.refund, 2n);
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(refundApproved), 'InvalidState');
  assert.equal(await balance(escrow.address), sampleBudget);
});

test('refunds only the disputed line budget to the owner', async () => {
  const id = await createFunded();
  await apply(review(id, 2, Decision.dispute));
  const beforeRefund = await balance(owner.address);
  await apply(review(id, 2, Decision.refund, 2n));
  const [milestone, lines] = await milestoneState(id);
  assert.equal(milestone.held, sampleBudget - musd(300));
  assert.deepEqual(lines.map(line => line.status), [Status.pending, Status.pending, Status.refunded]);
  assert.equal(await balance(owner.address), beforeRefund + musd(300));
  assert.equal(await balance(escrow.address), milestone.held);
});

test('locks review decisions and payout terms once a line is paid or refunded', async () => {
  const id = await createFunded();
  await apply(review(id, 0), review(id, 1, Decision.dispute));
  await settle(id, payment(0));
  await apply(review(id, 1, Decision.refund, 2n));

  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(review(id, 0, Decision.dispute, 2n)), 'InvalidState');
  await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(review(id, 1, Decision.refund, 3n)), 'InvalidState');
  await expectRevert(supplier, escrow, 'setPayout', [id, 0n, usdc(600)], 'InvalidState');
  await expectRevert(contractor, escrow, 'setPayout', [id, 1n, usdc(300)], 'InvalidState');
});

test('pays a corrected disputed line while preserving a second milestone’s budget', async () => {
  const id = await createFunded();
  const other = await createFunded();
  await apply(review(id, 2, Decision.dispute));
  await apply(review(id, 2, Decision.approve, 2n));
  await settle(id, payment(2));
  const [milestone, lines] = await milestoneState(id);
  const [otherMilestone, otherLines] = await milestoneState(other);
  assert.equal(milestone.held, musd(900));
  assert.equal(lines[2].status, Status.paid);
  assert.equal(otherMilestone.held, sampleBudget);
  assert.deepEqual(otherLines.map(line => line.status), workItems.map(() => Status.pending));
  assert.equal(await balance(escrow.address), milestone.held + otherMilestone.held);
});

test('conserves the funded budget through six settlement and refund sequences', async () => {
  const cases = [
    { budgets: [1n], actions: [{ pay: [0] }] },
    { budgets: [musd('0.01'), musd(99)], actions: [{ refund: [0] }] },
    { budgets: [musd(12), musd('6.5'), musd(3)], actions: [{ pay: [0] }, { refund: [2] }] },
    { budgets: [musd('0.5'), musd(9), musd(1)], actions: [{ refund: [2] }, { pay: [1, 0] }] },
    { budgets: [musd(7), musd(8), musd(9), musd(10)], actions: [{ pay: [3] }, { pay: [1] }, { refund: [2, 0] }] },
    { budgets: Array.from({ length: 12 }, (_, index) => BigInt(index + 1)), actions: [{ pay: Array.from({ length: 12 }, (_, index) => index) }] },
  ];

  for (const [caseIndex, { budgets, actions }] of cases.entries()) {
    const items = budgets.map((budget, index) => ({
      label: 'Work item ' + (index + 1),
      recipient: (index % 2 === 0 ? supplier : contractor).address,
      budget,
    }));
    const payable = new Set(actions.flatMap(action => action.pay ?? []));
    const funded = totalBudget(items);
    const escrowBefore = await balance(escrow.address);
    const ownerBefore = await balance(owner.address);
    const supplierBefore = await balance(supplier.address);
    const contractorBefore = await balance(contractor.address);
    const id = await createFunded(items);
    await apply(...items.map((_, index) => review(id, index, payable.has(index) ? Decision.approve : Decision.dispute)));

    let paidToSupplier = 0n;
    let paidToContractor = 0n;
    let refunded = 0n;
    async function checkBalances() {
      const [milestone] = await milestoneState(id);
      const held = funded - paidToSupplier - paidToContractor - refunded;
      assert.equal(milestone.held, held, 'Account for every budget unit in case ' + (caseIndex + 1));
      assert.equal(await balance(escrow.address), escrowBefore + held);
      assert.equal(await balance(owner.address), ownerBefore - funded + refunded);
      assert.equal(await balance(supplier.address), supplierBefore + paidToSupplier);
      assert.equal(await balance(contractor.address), contractorBefore + paidToContractor);
    }

    await checkBalances();
    for (const action of actions) {
      if (action.pay) {
        await settle(id, ...action.pay.map(index => payment(index)));
        for (const index of action.pay) {
          if (items[index].recipient === supplier.address) paidToSupplier += items[index].budget;
          else paidToContractor += items[index].budget;
        }
      } else {
        await apply(...action.refund.map(index => review(id, index, Decision.refund, 2n)));
        refunded += action.refund.reduce((sum, index) => sum + items[index].budget, 0n);
      }
      await checkBalances();
    }
  }
});
