import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseEther } from 'viem';
import { createServer } from 'vite';
import { contracts, mezo } from '../src/mezo.js';

const account = getAddress('0x1234567890abcdef1234567890abcdef12345678');
const escrow = getAddress('0xabcdef1234567890abcdef1234567890abcdef12');
const otherWallet = '0x000000000000000000000000000000000000000a';
const payoutToken = '0x0000000000000000000000000000000000000010';
const hash = '0x' + '12'.repeat(32);
const budget = parseEther('12');
let server, live;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
  });
  live = await server.ssrLoadModule('/src/live.js');
});

after(async () => {
  await server?.close();
});

function session({ addresses = [account], chainId = mezo.id, wallet, reader } = {}) {
  return {
    account,
    wallet: {
      async getChainId() { return chainId; },
      async getAddresses() { return addresses; },
      ...wallet,
    },
    reader,
  };
}

test('wallet preflight accepts the same address with different casing', async () => {
  await live.ensureAccount(session({ addresses: [account.toLowerCase()] }));
});

test('wallet preflight rejects an account switch after connection', async () => {
  await assert.rejects(live.ensureAccount(session({ addresses: [otherWallet, account] })), /account or network changed/);
});

test('wallet preflight rejects a disconnected account', async () => {
  await assert.rejects(live.ensureAccount(session({ addresses: [] })), /account or network changed/);
});

test('wallet preflight rejects a network change after connection', async () => {
  await assert.rejects(live.ensureAccount(session({ chainId: 1 })), /account or network changed/);
});

test('publishes the transaction hash while waiting for confirmation', async () => {
  const steps = [];
  const receipt = { status: 'success', transactionHash: hash };
  const reader = {
    async waitForTransactionReceipt(request) {
      assert.deepEqual(request, { hash, timeout: 75_000 });
      steps.push('wait');
      return receipt;
    },
  };
  const result = await live.confirmed(reader, hash, submitted => {
    assert.equal(submitted, hash);
    steps.push('hash');
  });
  assert.equal(result, receipt);
  assert.deepEqual(steps, ['hash', 'wait']);
});

test('reports a reverted receipt as a failed transaction', async () => {
  const reader = {
    async waitForTransactionReceipt() {
      return { status: 'reverted', transactionHash: hash };
    },
  };
  await assert.rejects(live.confirmed(reader, hash), /transaction reverted/);
});

test('preserves confirmation errors so a missing receipt cannot look successful', async () => {
  const error = new Error('Receipt not found before the timeout');
  const reader = {
    async waitForTransactionReceipt() { throw error; },
  };
  await assert.rejects(live.confirmed(reader, hash), error);
});

test('a zero spending request skips wallet and token calls', async () => {
  await live.approveMusd({}, escrow, 0n);
});

test('an existing MUSD allowance avoids a duplicate approval', async () => {
  for (const allowance of [budget, budget + 1n]) {
    const reader = {
      async readContract(request) {
        assert.equal(request.address, contracts.musd);
        assert.equal(request.functionName, 'allowance');
        assert.deepEqual(request.args, [account, escrow]);
        return allowance;
      },
    };
    await live.approveMusd(session({ reader }), escrow, budget);
  }
});

test('grants exactly the needed MUSD allowance and waits for its receipt', async () => {
  const steps = [];
  const reader = {
    async readContract() { return budget - 1n; },
    async simulateContract(request) {
      assert.equal(request.address, contracts.musd);
      assert.equal(request.functionName, 'approve');
      assert.equal(request.account, account);
      assert.deepEqual(request.args, [escrow, budget]);
      steps.push('simulate');
      return { request };
    },
    async waitForTransactionReceipt({ hash: submitted }) {
      assert.equal(submitted, hash);
      steps.push('confirmed');
      return { status: 'success' };
    },
  };
  const wallet = {
    async writeContract(request) {
      assert.deepEqual(request.args, [escrow, budget]);
      steps.push('approve');
      return hash;
    },
  };
  await live.approveMusd(session({ reader, wallet }), escrow, budget);
  assert.deepEqual(steps, ['simulate', 'approve', 'confirmed']);
});

test('checks the connected wallet before reading a nonzero allowance', async () => {
  await assert.rejects(live.approveMusd(session({ addresses: [otherWallet] }), escrow, budget), /account or network changed/);
});

test('sends the exact validated escrow call from the connected wallet', async () => {
  const argumentsForFunding = [9n];
  let simulated;
  const reader = {
    async simulateContract(request) {
      assert.equal(request.address, escrow);
      assert.equal(request.functionName, 'fund');
      assert.deepEqual(request.args, argumentsForFunding);
      assert.equal(request.account, account);
      simulated = request;
      return { request };
    },
    async waitForTransactionReceipt() { return { status: 'success', transactionHash: hash }; },
  };
  const wallet = {
    async writeContract(request) {
      assert.equal(request, simulated);
      return hash;
    },
  };

  const receipt = await live.escrowWrite(session({ reader, wallet }), escrow.toLowerCase(), 'fund', argumentsForFunding);
  assert.equal(receipt.transactionHash, hash);
});

test('stops an escrow write when simulation fails', async () => {
  const error = new Error('Not the milestone owner');
  const reader = {
    async simulateContract() { throw error; },
  };
  await assert.rejects(live.escrowWrite(session({ reader }), escrow, 'fund', [9n]), error);
});

test('blocks an escrow write after the wallet changes chain', async () => {
  await assert.rejects(live.escrowWrite(session({ chainId: 1 }), escrow, 'fund', [9n]), /account or network changed/);
});

function configReader(overrides = {}) {
  const values = {
    musd: contracts.musd.toLowerCase(),
    musdc: payoutToken,
    router: contracts.router,
    factory: contracts.factory,
    ...overrides,
  };
  return {
    async readContract({ address, functionName }) {
      if (address === escrow) return values[functionName];
      if (address === contracts.stablePool) {
        assert.ok(functionName === 'token0' || functionName === 'token1');
        return functionName === 'token0' ? contracts.musd : payoutToken;
      }
      assert.equal(address, payoutToken);
      assert.equal(functionName, 'decimals');
      return 6;
    },
  };
}

test('validates a Mezo escrow and reads the payout token’s precision', async () => {
  assert.deepEqual(await live.escrowConfig(configReader(), escrow), { musdc: payoutToken, payoutDecimals: 6 });
});

test('rejects escrow deployments with different tokens, router or pool factory', async () => {
  for (const field of ['musd', 'musdc', 'router', 'factory']) {
    await assert.rejects(
      live.escrowConfig(configReader({ [field]: otherWallet }), escrow),
      /does not match the Mezo Testnet escrow configuration/,
    );
  }
});

test('preserves the exact milestone ID and work items from a chain read', async () => {
  const id = 2n ** 60n + 1n;
  const milestone = { owner: account, budget, held: budget, funded: true };
  const lines = [{ budget, recipient: otherWallet, status: 0 }];
  const reader = {
    async readContract(request) {
      assert.equal(request.address, escrow);
      assert.equal(request.functionName, 'getMilestone');
      assert.deepEqual(request.args, [id]);
      return [milestone, lines];
    },
  };
  assert.deepEqual(await live.getMilestone(reader, escrow, id), { ...milestone, id, lines });
});

test('decodes milestone events from the escrow that emitted them', () => {
  const id = 9n;
  const log = {
    address: escrow.toLowerCase(),
    topics: encodeEventTopics({ abi: live.escrowAbi, eventName: 'MilestoneCreated', args: [id, account, otherWallet] }),
    data: encodeAbiParameters([{ type: 'uint256' }], [budget]),
  };
  const funded = {
    ...log,
    topics: encodeEventTopics({ abi: live.escrowAbi, eventName: 'Funded', args: [id] }),
  };
  const receipt = { logs: [{ ...log, address: otherWallet }, { ...log, topics: [] }, funded, log] };
  assert.deepEqual(live.eventArgs(receipt, escrow, 'MilestoneCreated'), [{
    id, owner: account, reviewer: getAddress(otherWallet), budget,
  }]);
});

test('deploys escrow with the current Mezo pool token and confirmed address', async () => {
  const reader = {
    ...configReader(),
    async waitForTransactionReceipt() {
      return { status: 'success', contractAddress: escrow, transactionHash: hash };
    },
  };
  const wallet = {
    async deployContract(request) {
      assert.deepEqual(request.args, [contracts.musd, payoutToken, contracts.router, contracts.factory]);
      assert.match(request.bytecode, /^0x[\da-f]+$/);
      return hash;
    },
  };
  assert.deepEqual(await live.deployEscrow(session({ reader, wallet })), { address: escrow, hash });
});

test('reports a deployment receipt that is missing the contract address', async () => {
  const reader = {
    ...configReader(),
    async waitForTransactionReceipt() { return { status: 'success', contractAddress: null }; },
  };
  const wallet = { async deployContract() { return hash; } };
  await assert.rejects(live.deployEscrow(session({ reader, wallet })), /did not return a contract address/);
});
