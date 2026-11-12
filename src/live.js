import { decodeEventLog, getAddress } from 'viem';
import artifact from './generated/Tranche.json';
import { contracts, getMusdc, mezo, sameAddress, tokenAbi } from './mezo.js';

export const escrowAbi = artifact.abi;

export async function ensureAccount(session) {
  const [chainId, accounts] = await Promise.all([session.wallet.getChainId(), session.wallet.getAddresses()]);
  if (chainId !== mezo.id || !sameAddress(accounts[0], session.account)) {
    throw new Error('The wallet account or network changed. Connect again before continuing.');
  }
}

export async function confirmed(reader, hash, onHash) {
  onHash?.(hash);
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 75_000 });
  if (receipt.status !== 'success') throw new Error('The transaction reverted. Open its explorer record for details.');
  return receipt;
}

export async function deployEscrow(session, onHash) {
  await ensureAccount(session);
  const musdc = await getMusdc(session.reader);
  const hash = await session.wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [contracts.musd, musdc, contracts.router, contracts.factory],
  });
  const receipt = await confirmed(session.reader, hash, onHash);
  if (!receipt.contractAddress) throw new Error('The transaction did not return a contract address.');
  return { address: receipt.contractAddress, hash: receipt.transactionHash };
}

export async function escrowConfig(reader, address) {
  const [musd, musdc, router, factory] = await Promise.all(['musd', 'musdc', 'router', 'factory'].map(functionName => reader.readContract({
    address, abi: escrowAbi, functionName,
  })));
  if (!sameAddress(musd, contracts.musd) || !sameAddress(router, contracts.router) || !sameAddress(factory, contracts.factory) || !sameAddress(musdc, await getMusdc(reader))) {
    throw new Error('This deployment does not match the Mezo Testnet escrow configuration.');
  }
  const payoutDecimals = await reader.readContract({ address: musdc, abi: tokenAbi, functionName: 'decimals' });
  return { musdc, payoutDecimals };
}

export async function getMilestone(reader, address, id) {
  const [milestone, lines] = await reader.readContract({ address, abi: escrowAbi, functionName: 'getMilestone', args: [id] });
  return { ...milestone, id, lines };
}

export function eventArgs(receipt, address, eventName) {
  return receipt.logs.flatMap(log => {
    if (!sameAddress(log.address, address)) return [];
    try {
      const decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      return decoded.eventName === eventName ? [decoded.args] : [];
    } catch {
      return [];
    }
  });
}

export async function escrowWrite(session, address, functionName, args, onHash) {
  await ensureAccount(session);
  const { request } = await session.reader.simulateContract({
    address: getAddress(address), abi: escrowAbi, functionName, args, account: session.account,
  });
  return confirmed(session.reader, await session.wallet.writeContract(request), onHash);
}

export async function approveMusd(session, spender, amount, onHash) {
  if (amount === 0n) return;
  await ensureAccount(session);
  const allowance = await session.reader.readContract({
    address: contracts.musd, abi: tokenAbi, functionName: 'allowance', args: [session.account, spender],
  });
  if (allowance >= amount) return;
  const { request } = await session.reader.simulateContract({
    address: contracts.musd, abi: tokenAbi, functionName: 'approve', args: [spender, amount], account: session.account,
  });
  await confirmed(session.reader, await session.wallet.writeContract(request), onHash);
}
