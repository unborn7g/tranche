import {
  createPublicClient, createWalletClient, custom, defineChain, getAddress,
  http, parseAbi, parseEther, zeroAddress,
} from 'viem';

export const mezo = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Testnet Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Testnet Explorer', url: 'https://explorer.test.mezo.org' } },
  testnet: true,
});

export const contracts = {
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  router: '0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9',
  factory: '0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A',
  stablePool: '0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e',
  borrowerOperations: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  hintHelpers: '0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6',
  sortedTroves: '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
};

export const tokenAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export const reviewTypes = {
  Review: [
    { name: 'milestoneId', type: 'uint256' }, { name: 'lineIndex', type: 'uint256' },
    { name: 'decision', type: 'uint8' }, { name: 'evidenceHash', type: 'bytes32' },
    { name: 'revision', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
};

export const sameAddress = (first, second) => Boolean(first && second && first.toLowerCase() === second.toLowerCase());

export function makeReader(provider) {
  return createPublicClient({
    chain: mezo,
    transport: provider ? custom(provider, { retryCount: 0 }) : http(undefined, { timeout: 12_000, retryCount: 0 }),
    pollingInterval: 2_000,
  });
}

export async function connectWallet(provider) {
  if (!provider) throw new Error('Open this page in a browser with an Ethereum wallet extension.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Select an account in your wallet.');
  const chainId = '0x7b7b';
  if (Number(await provider.request({ method: 'eth_chainId' })) !== mezo.id) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (error) {
      if (Number(error.code) !== 4902 && Number(error.data?.originalError?.code) !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId,
        chainName: mezo.name,
        nativeCurrency: mezo.nativeCurrency,
        rpcUrls: mezo.rpcUrls.default.http,
        blockExplorerUrls: [mezo.blockExplorers.default.url],
      }] });
      if (Number(await provider.request({ method: 'eth_chainId' })) !== mezo.id) {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
    }
  }
  const account = getAddress(accounts[0]);
  return { account, wallet: createWalletClient({ account, chain: mezo, transport: custom(provider) }), reader: makeReader(provider) };
}

const poolAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);

export async function getMusdc(reader) {
  const [token0, token1] = await Promise.all(['token0', 'token1'].map(functionName => reader.readContract({
    address: contracts.stablePool, abi: poolAbi, functionName,
  })));
  if (sameAddress(token0, contracts.musd)) return token1;
  if (sameAddress(token1, contracts.musd)) return token0;
  throw new Error('The documented testnet pool no longer lists MUSD. Check the Mezo pool configuration.');
}

const borrowerAbi = parseAbi([
  'function getBorrowingFee(uint256 amount) view returns (uint256)',
  'function openTrove(uint256 amount, address upperHint, address lowerHint) payable',
]);
const earlierBorrowerAbi = parseAbi(['function openTrove(uint256 maxFeePercentage, uint256 amount, address upperHint, address lowerHint) payable']);
const troveAbi = parseAbi([
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
  'function getTroveStatus(address borrower) view returns (uint256)',
]);
const hintAbi = parseAbi(['function getApproxHint(uint256 nicr, uint256 trials, uint256 seed) view returns (address, uint256, uint256)']);
const sortedAbi = parseAbi(['function findInsertPosition(uint256 nicr, address previous, address next) view returns (address, address)']);
const priceAbi = parseAbi(['function fetchPrice() returns (uint256)']);

export async function planBorrow(reader, account, amount, collateral) {
  if (amount < parseEther('1800')) throw new Error('Mezo’s documented minimum is 1,800 MUSD.');
  const [status, gasCompensation, fee, price, balance] = await Promise.all([
    reader.readContract({ address: contracts.troveManager, abi: troveAbi, functionName: 'getTroveStatus', args: [account] }),
    reader.readContract({ address: contracts.troveManager, abi: troveAbi, functionName: 'MUSD_GAS_COMPENSATION' }),
    reader.readContract({ address: contracts.borrowerOperations, abi: borrowerAbi, functionName: 'getBorrowingFee', args: [amount] }),
    reader.simulateContract({ address: contracts.priceFeed, abi: priceAbi, functionName: 'fetchPrice', account }).then(sim => sim.result),
    reader.getBalance({ address: account }),
  ]);
  if (status === 1n) throw new Error('This wallet has an open loan. Use Mezo Borrow to manage it, or fund escrow from your existing MUSD.');
  const totalDebt = amount + gasCompensation + fee;
  const collateralValue = collateral * price / parseEther('1');
  if (collateral >= balance) throw new Error('Your testnet BTC must cover the collateral and leave some BTC for network fees.');
  const ratio = collateralValue * 10_000n / totalDebt;
  return { collateral, amount, totalDebt, collateralValue, ratio, fee };
}

export async function simulateBorrow(reader, account, plan) {
  const nicr = plan.collateral * 10n ** 20n / plan.totalDebt;
  const [hint] = await reader.readContract({
    address: contracts.hintHelpers, abi: hintAbi, functionName: 'getApproxHint', args: [nicr, 15n, 42n],
  });
  const [upper, lower] = await reader.readContract({
    address: contracts.sortedTroves, abi: sortedAbi, functionName: 'findInsertPosition', args: [nicr, hint, hint],
  });
  const params = { address: contracts.borrowerOperations, functionName: 'openTrove', account, value: plan.collateral };
  try {
    return (await reader.simulateContract({ ...params, abi: borrowerAbi, args: [plan.amount, upper, lower] })).request;
  } catch (error) {
    // Some older Mezo deployments include an explicit maximum-fee argument.
    const feeCeiling = (plan.fee + 1n) * parseEther('1') / plan.amount + 1n;
    try {
      return (await reader.simulateContract({
        ...params, abi: earlierBorrowerAbi, args: [feeCeiling, plan.amount, upper || zeroAddress, lower || zeroAddress],
      })).request;
    } catch {
      throw error;
    }
  }
}
