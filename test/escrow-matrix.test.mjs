import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, parseEventLogs, stringToHex } from 'viem';
import {
  owner, reviewer, supplier, contractor, outsider, Decision, Status,
  token, escrow, sampleBudget, workItems, musd, usdc, deadline,
  write, expectRevert, read, milestoneState, balance, approveEscrow,
  createMilestone, createFunded, review, reviewArgs, apply, payment, settle,
} from '../test-support/escrow-fixture.mjs';

const firstBudget = workItems[0].budget;
const states = Object.entries(Status);
const roles = [
  ['owner', owner],
  ['reviewer', reviewer],
  ['item recipient', supplier],
  ['recipient on another item', contractor],
  ['unrelated wallet', outsider],
];

async function lineInState(status) {
  const id = await createFunded();
  if (status === Status.approved || status === Status.paid) await apply(review(id, 0));
  if (status === Status.disputed || status === Status.refunded) await apply(review(id, 0, Decision.dispute));
  if (status === Status.paid) await settle(id, payment(0));
  if (status === Status.refunded) await apply(review(id, 0, Decision.refund, 2n));
  return id;
}

for (const [label, status] of states) {
  for (const [decisionName, decision] of Object.entries(Decision)) {
    test('review ' + label + ' item with ' + decisionName, async () => {
      const id = await lineInState(status);
      const [before, [lineBefore]] = await milestoneState(id);
      const ownerBefore = await balance(owner.address);
      const evidence = keccak256(stringToHex('Updated inspection notes'));
      const certificate = {
        ...review(id, 0, decision, lineBefore.revision + 1n),
        evidenceHash: evidence,
      };
      const allowed = status < Status.paid && (decision !== Decision.refund || status === Status.disputed);

      if (!allowed) {
        await expectRevert(outsider, escrow, 'applyReviews', await reviewArgs(certificate), 'InvalidState');
        const [after, [lineAfter]] = await milestoneState(id);
        assert.equal(after.held, before.held);
        assert.deepEqual(lineAfter, lineBefore);
        return;
      }

      await apply(certificate);
      const [after, [lineAfter]] = await milestoneState(id);
      const expectedStatus = { approve: Status.approved, dispute: Status.disputed, refund: Status.refunded }[decisionName];
      const refund = decision === Decision.refund ? firstBudget : 0n;
      assert.equal(lineAfter.status, expectedStatus);
      assert.equal(lineAfter.revision, lineBefore.revision + 1n);
      assert.equal(lineAfter.evidenceHash, evidence);
      assert.equal(after.held, before.held - refund);
      assert.equal(await balance(owner.address), ownerBefore + refund);
    });
  }

  for (const [role, account] of roles) {
    test(role + ' settling a ' + label + ' item', async () => {
      const id = await lineInState(status);
      const [before, [lineBefore]] = await milestoneState(id);
      const recipientBefore = await balance(supplier.address);
      const args = [id, [payment(0)], deadline()];

      if (account !== owner || status !== Status.approved) {
        const reason = account === owner ? 'InvalidState' : 'Unauthorized';
        await expectRevert(account, escrow, 'settle', args, reason);
        assert.deepEqual((await milestoneState(id))[1][0], lineBefore);
        assert.equal(await balance(supplier.address), recipientBefore);
        return;
      }

      await write(owner, escrow, 'settle', args);
      const [after, [lineAfter]] = await milestoneState(id);
      assert.equal(after.held, before.held - firstBudget);
      assert.equal(lineAfter.status, Status.paid);
      assert.equal(lineAfter.amountPaid, firstBudget);
      assert.equal(lineAfter.revision, lineBefore.revision);
      assert.equal(await balance(supplier.address), recipientBefore + firstBudget);
    });

    test(role + ' choosing the payout token for a ' + label + ' item', async () => {
      const id = await lineInState(status);
      const [before, [lineBefore]] = await milestoneState(id);
      const minimum = usdc('598.5');
      const args = [id, 0n, minimum];

      if (account !== supplier || status >= Status.paid) {
        const reason = account === supplier ? 'InvalidState' : 'Unauthorized';
        await expectRevert(account, escrow, 'setPayout', args, reason);
        assert.deepEqual((await milestoneState(id))[1][0], lineBefore);
        return;
      }

      await write(supplier, escrow, 'setPayout', args);
      const [after, [lineAfter]] = await milestoneState(id);
      assert.equal(after.held, before.held);
      assert.deepEqual(lineAfter, { ...lineBefore, minMusdc: minimum });
    });
  }
}

function escrowEvent(receipt, eventName) {
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === escrow.address.toLowerCase());
  const events = parseEventLogs({ abi: escrow.abi, logs, eventName });
  assert.equal(events.length, 1);
  return events[0].args;
}

test('publishes the new milestone ID, owner, reviewer and budget', async () => {
  const id = await read(escrow, 'nextId');
  const receipt = await write(owner, escrow, 'createMilestone', ['Proof example', reviewer.address, workItems]);
  assert.deepEqual(escrowEvent(receipt, 'MilestoneCreated'), {
    id, owner: owner.address, reviewer: reviewer.address, budget: sampleBudget,
  });
});

test('the funding receipt records exactly the escrow deposit', async () => {
  const id = await createMilestone();
  await approveEscrow(sampleBudget);
  const receipt = await write(owner, escrow, 'fund', [id]);
  assert.deepEqual(escrowEvent(receipt, 'Funded'), { id, amount: sampleBudget });
});

test('the signed review receipt identifies the changed item and evidence', async () => {
  const id = await createFunded();
  const cert = review(id, 2, Decision.dispute);
  const receipt = await apply(cert);
  assert.deepEqual(escrowEvent(receipt, 'Reviewed'), {
    id, lineIndex: 2n, decision: Decision.dispute, evidenceHash: cert.evidenceHash,
  });
});

test('the payout preference receipt records the payee’s exact minimum', async () => {
  const id = await createFunded();
  const minMusdc = usdc('598.500001');
  const receipt = await write(supplier, escrow, 'setPayout', [id, 0n, minMusdc]);
  assert.deepEqual(escrowEvent(receipt, 'PayoutSelected'), { id, lineIndex: 0n, minMusdc });
});

test('the MUSD payout receipt identifies the recipient, token, and exact amount', async () => {
  const id = await createFunded();
  await apply(review(id, 0));
  const receipt = await settle(id, payment(0));
  const actual = escrowEvent(receipt, 'Paid');
  assert.equal(actual.id, id);
  assert.equal(actual.lineIndex, 0n);
  assert.equal(actual.recipient, supplier.address);
  assert.equal(actual.token.toLowerCase(), token.address.toLowerCase());
  assert.equal(actual.amount, firstBudget);
  assert.equal(actual.extraMusd, 0n);
});

test('the refund receipt identifies the disputed item and only its budget', async () => {
  const id = await createFunded();
  await apply(review(id, 2, Decision.dispute));
  const receipt = await apply(review(id, 2, Decision.refund, 2n));
  assert.deepEqual(escrowEvent(receipt, 'Refunded'), { id, lineIndex: 2n, amount: musd(300) });
});
