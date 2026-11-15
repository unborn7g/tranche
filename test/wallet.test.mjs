import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, parseEther } from 'viem';
import { connectWallet, contracts, getMusdc, mezo, planBorrow, simulateBorrow } from '../src/mezo.js';

const account = getAddress('0x1234567890abcdef1234567890abcdef12345678');
const payoutToken = '0x0000000000000000000000000000000000000020';
const otherToken = '0x0000000000000000000000000000000000000030';
const previousTrove = '0x0000000000000000000000000000000000000040';
const nextTrove = '0x0000000000000000000000000000000000000050';
const mezoChainId = '0x7b7b';
const requestAccounts = { method: 'eth_requestAccounts', result: [account.toLowerCase()] };
const currentChain = chain => ({ method: 'eth_chainId', result: chain });
const switchToMezo = { method: 'wallet_switchEthereumChain', params: [{ chainId: mezoChainId }] };
const addMezo = {
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: mezoChainId,
    chainName: 'Mezo Testnet',
    nativeCurrency: { name: 'Testnet Bitcoin', symbol: 'BTC', decimals: 18 },
    rpcUrls: ['https://rpc.test.mezo.org'],
    blockExplorerUrls: ['https://explorer.test.mezo.org'],
  }],
};

function scriptedWallet(steps) {
  const queue = [...steps];
  return {
    provider: {
      async request({ method, params }) {
        const next = queue.shift();
        assert.ok(next, 'Unexpected wallet request ' + method);
        assert.equal(method, next.method);
        assert.deepEqual(params, next.params);
        if (next.error) throw next.error;
        return next.result;
      },
    },
    verify() {
      assert.equal(queue.length, 0, 'Every expected wallet request was made');
    },
  };
}

test('wallet connection reports a missing browser extension', async () => {
  await assert.rejects(connectWallet(undefined), /browser with an Ethereum wallet extension/);
});

test('wallet connection requires a selected account before switching chains', async () => {
  const wallet = scriptedWallet([{ ...requestAccounts, result: [] }]);
  await assert.rejects(connectWallet(wallet.provider), /Select an account/);
  wallet.verify();
});

test('wallet access rejection stops the connection', async () => {
  const error = Object.assign(new Error('Connection declined'), { code: 4001 });
  const wallet = scriptedWallet([{ ...requestAccounts, error }]);
  await assert.rejects(connectWallet(wallet.provider), error);
  wallet.verify();
});

test('connects the selected account and checksums it on Mezo Testnet', async () => {
  const wallet = scriptedWallet([requestAccounts, currentChain(mezoChainId)]);
  const session = await connectWallet(wallet.provider);
  assert.equal(session.account, account);
  assert.equal(session.wallet.account.address, account);
  assert.equal(session.reader.chain.id, 31611);
  wallet.verify();
});

test('switches to Mezo Testnet when the network is already registered', async () => {
  const wallet = scriptedWallet([requestAccounts, currentChain('0x1'), switchToMezo]);
  const session = await connectWallet(wallet.provider);
  assert.equal(session.wallet.chain.id, mezo.id);
  wallet.verify();
});

test('adds the official Mezo Testnet network and switches when the wallet stays on the old chain', async () => {
  for (const error of [{ code: 4902 }, { data: { originalError: { code: 4902 } } }]) {
    const wallet = scriptedWallet([
      requestAccounts, currentChain('0x1'), { ...switchToMezo, error }, addMezo,
      currentChain('0x1'), switchToMezo,
    ]);
    assert.equal((await connectWallet(wallet.provider)).account, account);
    wallet.verify();
  }
});

test('accepts automatic network switching after Mezo Testnet is added', async () => {
  const wallet = scriptedWallet([
    requestAccounts, currentChain('0x1'), { ...switchToMezo, error: { code: 4902 } },
    addMezo, currentChain(mezoChainId),
  ]);
  assert.equal((await connectWallet(wallet.provider)).wallet.chain.id, 31611);
  wallet.verify();
});

test('preserves a declined network switch without prompting to add a network', async () => {
  const error = Object.assign(new Error('Switch declined'), { code: 4001 });
  const wallet = scriptedWallet([
    requestAccounts, currentChain('0x1'), { ...switchToMezo, error },
  ]);
  await assert.rejects(connectWallet(wallet.provider), error);
  wallet.verify();
});

test('reports a declined Mezo Testnet add request', async () => {
  const error = Object.assign(new Error('Addition declined'), { code: 4001 });
  const wallet = scriptedWallet([
    requestAccounts, currentChain('0x1'), { ...switchToMezo, error: { code: 4902 } },
    { ...addMezo, error },
  ]);
  await assert.rejects(connectWallet(wallet.provider), error);
  wallet.verify();
});

function poolTokens(token0, token1) {
  return {
    async readContract({ functionName, address }) {
      assert.equal(address, contracts.stablePool);
      assert.ok(functionName === 'token0' || functionName === 'token1');
      return functionName === 'token0' ? token0 : token1;
    },
  };
}

test('finds the payout token on either side of the MUSD pool', async () => {
  assert.equal(await getMusdc(poolTokens(contracts.musd.toLowerCase(), payoutToken)), payoutToken);
  assert.equal(await getMusdc(poolTokens(payoutToken, contracts.musd)), payoutToken);
});

test('blocks network configuration when the pool has no MUSD', async () => {
  await assert.rejects(getMusdc(poolTokens(payoutToken, otherToken)), /no longer lists MUSD/);
});

const draw = parseEther('1800');
const collateral = parseEther('0.04');
const fee = parseEther('1.8');
const gasReserve = parseEther('200');

function borrowReader({ status = 0n, balance = parseEther('0.05'), priceUnavailable } = {}) {
  return {
    async readContract({ address, functionName, args }) {
      if (functionName === 'getBorrowingFee') {
        assert.equal(address, contracts.borrowerOperations);
        assert.deepEqual(args, [draw]);
        return fee;
      }
      assert.equal(address, contracts.troveManager);
      if (functionName === 'getTroveStatus') {
        assert.deepEqual(args, [account]);
        return status;
      }
      assert.equal(functionName, 'MUSD_GAS_COMPENSATION');
      return gasReserve;
    },
    async getBalance(request) {
      assert.deepEqual(request, { address: account });
      return balance;
    },
    async simulateContract(request) {
      assert.equal(request.address, contracts.priceFeed);
      assert.equal(request.functionName, 'fetchPrice');
      assert.equal(request.account, account);
      if (priceUnavailable) throw priceUnavailable;
      return { result: parseEther('90000') };
    },
  };
}

test('rejects a subminimum MUSD loan before contacting the chain', async () => {
  await assert.rejects(planBorrow({}, account, draw - 1n, collateral), /minimum is 1,800 MUSD/);
});

test('calculates the debt and collateral ratio using the Mezo fee and gas reserve', async () => {
  const plan = await planBorrow(borrowReader(), account, draw, collateral);
  assert.deepEqual(plan, {
    collateral, amount: draw, fee, totalDebt: parseEther('2001.8'),
    collateralValue: parseEther('3600'), ratio: 17_983n,
  });
});

test('prevents opening a second active Mezo loan from the same wallet', async () => {
  await assert.rejects(planBorrow(borrowReader({ status: 1n }), account, draw, collateral), /has an open loan/);
});

test('allows a quote when the account’s previous loan is closed', async () => {
  const plan = await planBorrow(borrowReader({ status: 2n }), account, draw, collateral);
  assert.equal(plan.amount, draw);
});

test('requires the owner to leave BTC for transaction fees', async () => {
  for (const balance of [collateral, collateral - 1n]) {
    await assert.rejects(planBorrow(borrowReader({ balance }), account, draw, collateral), /leave some BTC/);
  }
});

test('surfaces an unavailable Mezo price instead of returning an incomplete quote', async () => {
  const error = new Error('Cannot read BTC price');
  await assert.rejects(planBorrow(borrowReader({ priceUnavailable: error }), account, draw, collateral), error);
});

const quotedLoan = { collateral, amount: draw, fee, totalDebt: parseEther('2001.8') };

function loanSimulation({ modernError, legacyError } = {}) {
  const calls = [];
  return {
    calls,
    reader: {
      async readContract({ address, functionName, args }) {
        if (functionName === 'getApproxHint') {
          assert.equal(address, contracts.hintHelpers);
          assert.equal(args[0], 1_998_201_618_543_311n);
          return [previousTrove];
        }
        assert.equal(address, contracts.sortedTroves);
        assert.equal(functionName, 'findInsertPosition');
        assert.deepEqual(args, [1_998_201_618_543_311n, previousTrove, previousTrove]);
        return [previousTrove, nextTrove];
      },
      async simulateContract(request) {
        calls.push(request);
        const error = request.args.length === 3 ? modernError : legacyError;
        if (error) throw error;
        return { request };
      },
    },
  };
}

test('simulates opening the Mezo loan with the exact collateral and placement hints', async () => {
  const { reader, calls } = loanSimulation();
  const request = await simulateBorrow(reader, account, quotedLoan);
  assert.equal(calls.length, 1);
  assert.equal(request.address, contracts.borrowerOperations);
  assert.equal(request.functionName, 'openTrove');
  assert.equal(request.account, account);
  assert.equal(request.value, collateral);
  assert.deepEqual(request.args, [draw, previousTrove, nextTrove]);
});

test('includes a fee ceiling when an older borrower contract needs the extra argument', async () => {
  const { reader, calls } = loanSimulation({ modernError: new Error('Modern ABI unavailable') });
  const request = await simulateBorrow(reader, account, quotedLoan);
  assert.equal(calls.length, 2);
  assert.equal(request.value, collateral);
  assert.deepEqual(request.args, [1_000_000_000_000_001n, draw, previousTrove, nextTrove]);
});

test('preserves the original simulation failure when both loan variants fail', async () => {
  const modernError = new Error('Collateral ratio below minimum');
  const { reader, calls } = loanSimulation({ modernError, legacyError: new Error('Legacy ABI unavailable') });
  await assert.rejects(simulateBorrow(reader, account, quotedLoan), modernError);
  assert.equal(calls.length, 2);
});
