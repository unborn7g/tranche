import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressInput, escrowEntry, milestoneId, positiveAmount, reviewNote } from '../src/inputs.js';

const acceptedAmounts = [
  ['a whole MUSD deposit', '1200', 18, false, 1_200_000_000_000_000_000_000n],
  ['a trimmed budget with decimals', ' \t12.3\n', 18, false, 12_300_000_000_000_000_000n],
  ['the smallest MUSD unit', '0.000000000000000001', 18, false, 1n],
  ['the smallest mUSDC unit', '0.000001', 6, false, 1n],
  ['a budget with leading and trailing zeros', '0004.2500', 18, false, 4_250_000_000_000_000_000n],
  ['a full precision MUSD amount', '1.234567890123456789', 18, false, 1_234_567_890_123_456_789n],
  ['zero for an optional owner top-up', '0', 18, true, 0n],
  ['an mUSDC payout quote', '300.49', 6, false, 300_490_000n],
  ['a token with zero decimal places', '7', 0, false, 7n],
  ['a budget above the safe JavaScript integer limit', '9007199254740993', 18, false, 9_007_199_254_740_993_000_000_000_000_000_000n],
  ['a string at the input length limit', '7'.repeat(44), 0, false, BigInt('7'.repeat(44))],
];

for (const [label, input, decimals, allowZero, expected] of acceptedAmounts) {
  test('amount accepts ' + label, () => {
    assert.equal(positiveAmount(input, decimals, allowZero), expected);
  });
}

const rejectedAmounts = [
  ['an empty field', '', 18],
  ['a missing field', null, 18],
  ['only whitespace', ' \n\t ', 18],
  ['a negative budget', '-12', 18],
  ['an explicitly signed budget', '+12', 18],
  ['exponent notation', '1e3', 18],
  ['a grouping separator', '1,200', 18],
  ['an omitted whole part', '.5', 18],
  ['an incomplete decimal', '5.', 18],
  ['digits beyond MUSD precision', '0.0000000000000000001', 18],
  ['digits beyond mUSDC precision', '0.0000001', 6],
  ['a fraction for a whole-unit token', '1.2', 0],
  ['a string beyond the input length limit', '7'.repeat(45), 0],
  ['a hex amount', '0x12', 18],
];

for (const [label, input, decimals] of rejectedAmounts) {
  test('amount rejects ' + label, () => {
    assert.throws(() => positiveAmount(input, decimals), /Enter a valid amount/);
  });
}

test('required budgets and payout minimums reject zero', () => {
  for (const input of ['0', '0.000000']) {
    assert.throws(() => positiveAmount(input, 6), /greater than zero/);
  }
});

const parsedIds = [
  ['the first milestone', '1', 1n],
  ['an ID pasted with whitespace', ' 42\n', 42n],
  ['an ID above the JavaScript safe integer range', '9007199254740993', 9007199254740993n],
  ['a 32-digit milestone ID', '9'.repeat(32), BigInt('9'.repeat(32))],
];

for (const [label, input, expected] of parsedIds) {
  test('milestone ID accepts ' + label, () => {
    assert.equal(milestoneId(input), expected);
  });
}

for (const [label, input] of [
  ['a missing ID', null],
  ['a blank ID', ''],
  ['zero', '0'],
  ['a negative ID', '-1'],
  ['a fractional ID', '1.5'],
  ['an exponent', '2e3'],
  ['an ambiguous leading zero', '01'],
  ['an oversized ID', '9'.repeat(33)],
]) {
  test('milestone ID rejects ' + label, () => {
    assert.throws(() => milestoneId(input), /positive milestone ID/);
  });
}

const savedEscrow = '0x52908400098527886E0F7030069857D2E4169EE7';
const sharedEscrow = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
const zeroAddress = '0x' + '0'.repeat(40);

test('address input checksums a lowercase wallet', () => {
  assert.equal(addressInput(savedEscrow.toLowerCase()), savedEscrow);
});

test('address input trims a pasted contract address', () => {
  assert.equal(addressInput(' ' + sharedEscrow + '\n'), sharedEscrow);
});

for (const [label, input] of [
  ['a missing address', undefined],
  ['a zero address', zeroAddress],
  ['a truncated address', savedEscrow.slice(0, -1)],
  ['an address with a nonhex character', savedEscrow.slice(0, -1) + 'g'],
  ['an address without a prefix', savedEscrow.slice(2)],
]) {
  test('address input rejects ' + label, () => {
    assert.throws(() => addressInput(input), /valid, nonzero wallet or contract address/);
  });
}

const routes = [
  ['a clean Demo visit', '', null, 'demo', null, null],
  ['an ordinary visit with a saved escrow', '', savedEscrow, 'demo', savedEscrow, null],
  ['an unrelated query on a Demo visit', '?ref=buildathon', savedEscrow, 'demo', savedEscrow, null],
  ['an invalid saved escrow', '', { address: savedEscrow }, 'demo', null, null],
  ['a valid shared milestone with a different saved escrow', '?escrow=' + sharedEscrow + '&milestone=8', savedEscrow, 'testnet', sharedEscrow, '8'],
  ['a shared deployment without a milestone ID', '?escrow=' + sharedEscrow, savedEscrow, 'testnet', sharedEscrow, null],
  ['a shared ID with no escrow address', '?milestone=8', savedEscrow, 'testnet', null, '8'],
  ['a shared ID with an empty escrow address', '?escrow=&milestone=8', savedEscrow, 'testnet', null, '8'],
  ['a malformed shared escrow with a valid saved deployment', '?escrow=bad&milestone=8', savedEscrow, 'testnet', null, '8'],
  ['the zero address in a shared link', '?escrow=' + zeroAddress + '&milestone=8', savedEscrow, 'testnet', null, '8'],
  ['different escrow addresses in one shared link', '?escrow=' + savedEscrow + '&escrow=' + sharedEscrow, savedEscrow, 'testnet', null, null],
  ['different milestone IDs in one shared link', '?escrow=' + sharedEscrow + '&milestone=8&milestone=9', savedEscrow, 'testnet', null, '8'],
];

for (const [label, query, stored, mode, address, sharedMilestone] of routes) {
  test('route handles ' + label, () => {
    assert.deepEqual(escrowEntry(new URLSearchParams(query), stored), { mode, address, sharedMilestone });
  });
}

test('review evidence trims the outer whitespace while preserving Unicode text', () => {
  assert.equal(reviewNote(' \n  Étape 1 — approved.\nApartment 2 needs work. \n'), 'Étape 1 — approved.\nApartment 2 needs work.');
});

test('review evidence rejects an omitted note', () => {
  assert.throws(() => reviewNote(null), /Enter an evidence or review note/);
});

test('review evidence rejects a note made only of whitespace', () => {
  assert.throws(() => reviewNote(' \n\t '), /Enter an evidence or review note/);
});

test('review evidence accepts the full 2,000-character limit', () => {
  const note = 'a'.repeat(2_000);
  assert.equal(reviewNote(note), note);
});

test('review evidence rejects a note beyond its field limit', () => {
  assert.throws(() => reviewNote('a'.repeat(2_001)), /2,000 characters/);
});
