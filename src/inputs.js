import { getAddress, isAddress, parseUnits } from 'viem';

export function positiveAmount(value, decimals, allowZero = false) {
  const input = String(value ?? '').trim();
  const expression = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!expression.test(input) || input.length > 44) throw new Error('Enter a valid amount with no commas.');
  const amount = parseUnits(input, decimals);
  if (!allowZero && amount <= 0n) throw new Error('Enter an amount greater than zero.');
  return amount;
}

export function addressInput(value) {
  const input = String(value ?? '').trim();
  if (!isAddress(input, { strict: false }) || /^0x0+$/i.test(input)) {
    throw new Error('Enter a valid, nonzero wallet or contract address.');
  }
  return getAddress(input);
}

export function milestoneId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{0,31}$/.test(id)) throw new Error('Enter a positive milestone ID.');
  return BigInt(id);
}

export function escrowEntry(params, savedAddress) {
  const shared = params.has('escrow') || params.has('milestone');
  const sharedMilestone = params.get('milestone');
  const mode = shared ? 'testnet' : 'demo';
  if (params.getAll('escrow').length > 1 || params.getAll('milestone').length > 1) {
    return { mode, address: null, sharedMilestone };
  }
  try {
    const address = addressInput(shared ? params.get('escrow') : savedAddress);
    return { mode, address, sharedMilestone };
  } catch {
    return { mode, address: null, sharedMilestone };
  }
}

export function reviewNote(value) {
  const note = String(value ?? '').trim();
  if (!note) throw new Error('Enter an evidence or review note.');
  if (note.length > 2_000) throw new Error('Keep the review note to 2,000 characters.');
  return note;
}
