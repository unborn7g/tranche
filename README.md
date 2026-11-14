# Tranche

Bitcoin-backed milestone payments for cross-border projects. Built by Unborn Studios for the Mezo Buildathon.

[Watch the 1:57 pitch](https://youtu.be/Dt3lyodfdwM) · [Try the live demo](https://tranche-mezo.vercel.app/) · [Open testnet milestone #1](https://tranche-mezo.vercel.app/?escrow=0xd7813f530fd625added1b4b8c1d09e0e4dd6be3d&milestone=1)

## What Tranche does

Say you’re hiring a designer and a developer for a launch. You hold Bitcoin, and both want to see that their work is funded before they start.

With Tranche, you can borrow MUSD, Mezo’s dollar stablecoin, against Bitcoin and set the budget aside in escrow. Each work item has its own amount and recipient. A designated reviewer signs off on each item. The owner can pay for approved work while disputed amounts stay in escrow.

## Mezo Buildathon testnet run

Tranche opens the loan through Mezo’s lending contracts. The escrow then holds and pays out MUSD on Mezo Testnet. In the electrical installation run, one milestone funded a materials supplier and an installer.

| Step | Mezo Testnet result |
| --- | --- |
| Borrow | Mezo minted **1,800 MUSD** to the project owner after the owner pledged **0.04 testnet BTC** as collateral. [Loan receipt](https://explorer.test.mezo.org/tx/0xdfa6d04b5d14b63284e5a75c5a0a5f3a9451fd92513c2e9a5a4a5f59bb2589bc) |
| Fund and review | The owner deposited **1,200 MUSD** for milestone #1. The reviewer approved electrical materials and first-fix installation and disputed final testing. [Escrow contract](https://explorer.test.mezo.org/address/0xd7813f530fd625added1b4b8c1d09e0e4dd6be3d) |
| Release | Tranche paid **600 MUSD** to the materials supplier and **300 MUSD** to the installer in one transaction. The remaining **300 MUSD** stayed in escrow for disputed final testing. [Payout receipt](https://explorer.test.mezo.org/tx/0x9b1d38637846c88b2694c2e14022e2f846c58bd1ecac6bf19bd01feb1739f594) |

## Try the demo

Open the [live demo](https://tranche-mezo.vercel.app/) to try the workflow without a wallet. Use **Reset demo** to start over.

1. Choose **Fund milestone**, then **Fund escrow** to deposit 1,200 simulated MUSD.
2. Choose **Review work items**. Approve the 600 MUSD materials item and the 300 MUSD first-fix item. Mark the 300 MUSD final-testing item as disputed and select **Submit review**.
3. Choose **Release approved funds**, then **Release funds**. The dashboard shows **900 MUSD released** and **300 MUSD held in escrow**.

To try the optional mUSDC payout before releasing funds, set the first-fix recipient’s minimum to 300 mUSDC. A 2 MUSD owner top-up brings the simulated payout to 300.49 mUSDC. Use **Check payout quote** before releasing the funds.

## Code and stack

| Component | Where to look |
| --- | --- |
| Mezo borrowing and network configuration | [`src/mezo.js`](src/mezo.js) |
| Solidity escrow, OpenZeppelin, and EIP-712 reviewer signatures | [`contracts/Tranche.sol`](contracts/Tranche.sol) |
| JavaScript, Vite, and viem web app deployed to Vercel | [`src/main.js`](src/main.js) and [`src/live.js`](src/live.js) |
| Contract tests with Node.js and Ganache | [`test/escrow.test.mjs`](test/escrow.test.mjs) |

## Run locally

Use Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

Open the URL printed by the development server. Demo mode uses simulated funds and browser storage. You can also inspect [testnet milestone #1](https://tranche-mezo.vercel.app/?escrow=0xd7813f530fd625added1b4b8c1d09e0e4dd6be3d&milestone=1) using the public Mezo Testnet RPC without connecting a wallet.

In a separate terminal, run the contract tests and build the static frontend.

```bash
npm test
npm run build
```

The build writes the site to `dist` for HTTPS hosting.

## Mezo Testnet

1. Open **Testnet setup** and connect an Ethereum-compatible browser wallet. Use Mezo Testnet, chain `31611`, and obtain testnet BTC for gas. Each signer needs gas.
2. Deploy the escrow using **Deploy escrow**. The app discovers the mUSDC token from Mezo’s documented testnet pool. Save the explorer link and contract address.
3. Use **Borrow MUSD** or [Mezo Borrow](https://testnet.mezo.org/feature/borrow) to open a testnet loan. A wallet with existing test MUSD can also fund escrow. The documented minimum borrow is 1,800 MUSD, plus the protocol’s gas reserve and applicable fee. Check the wallet’s live quote.
4. Create the milestone with an owner wallet, a separate reviewer wallet, and contractor and supplier addresses. Use **Share** to give reviewers and payees the contract and milestone ID. Each signer opens the milestone with their own wallet.
5. The owner deposits MUSD. The reviewer signs and submits item decisions. A payee can set an mUSDC minimum on their own item. The owner checks the quote, adds a top-up if needed, and settles the approved items. Confirm the transactions in the explorer.

The CLI also deploys with `npm run deploy:testnet` after `MEZO_TESTNET_DEPLOYER_KEY` is set in the environment to a dedicated funded testnet key. Browser wallet deployment keeps key handling with the wallet extension.

- [Mezo testnet and faucet](https://mezo.org/docs/developers/getting-started/)
- [Mezo MUSD borrowing](https://mezo.org/docs/users/borrow/mint-musd/)
- [Mezo pool contracts](https://testnet.mezo.org/docs/developers/features/mezo-pools/)

## Contract behavior

The escrow stores recipient addresses, MUSD budgets, and held balances per milestone. The EIP-712 review binds the chain and escrow address, milestone, line item, decision, evidence hash, revision, and expiry. The line item fixes the recipient and budget. Only the designated reviewer can certify an item or authorize a disputed-item refund. The owner can settle approved items in one transaction. A failed swap rolls back the full settlement batch. The contract enforces the payee’s minimum and only grants the swap router an allowance for the current input amount.

Review notes stay in the browser input. The chain records their hashes, along with public wallet addresses and amounts. The product assumes a trusted reviewer. If a reviewer becomes unavailable, unresolved funds remain held. The contract has no upgrade or admin withdrawal path. The activity view records this browser’s confirmed transactions. Anyone with the milestone link can read the current on-chain state.

The local contract tests use Ganache, mock tokens, and a mock swap router. They cover partial settlement, unauthorized and replayed reviews, dispute resolution, and atomic rollback when payout falls below the minimum. The Mezo Testnet run settled in MUSD. The tests exercise the mUSDC swap path with a mock router. The implementation is a testnet prototype and has not been independently audited.

## What’s next

The next step would be a small pilot with a Bitcoin-holding project owner and the people they hire. The pilot would test whether an owner would borrow MUSD for an actual job and whether recipients would choose to be paid that way. It would also inform how payments should be resolved when a reviewer becomes unavailable.
