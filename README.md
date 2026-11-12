# Tranche

Bitcoin-backed milestone payments for cross-border projects. An owner borrows MUSD through Mezo, funds a milestone, and releases the approved items after an independent reviewer certifies the work. Recipients can choose MUSD or a minimum payout in testnet mUSDC.

## Mezo Buildathon testnet run

The electrical installation milestone shows how a project owner can pay a supplier and a contractor for approved work while keeping the disputed amount in escrow.

| Step | Mezo Testnet result |
| --- | --- |
| Borrow | Mezo minted **1,800 MUSD** to the project owner after the owner pledged **0.04 testnet BTC** as collateral. [Loan receipt](https://explorer.test.mezo.org/tx/0xdfa6d04b5d14b63284e5a75c5a0a5f3a9451fd92513c2e9a5a4a5f59bb2589bc) |
| Fund and review | The owner deposited **1,200 MUSD** for milestone #1. The reviewer approved electrical materials and first-fix installation and disputed final testing. [Escrow contract](https://explorer.test.mezo.org/address/0xd7813f530fd625added1b4b8c1d09e0e4dd6be3d) |
| Release | Tranche paid **600 MUSD** to the materials supplier and **300 MUSD** to the installer in one transaction. The remaining **300 MUSD** stayed in escrow for disputed final testing. [Payout receipt](https://explorer.test.mezo.org/tx/0x9b1d38637846c88b2694c2e14022e2f846c58bd1ecac6bf19bd01feb1739f594) |

## Run locally

Use Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

Open the URL printed by the development server. The app starts in Demo mode, where funds and events are simulated in the browser. To inspect the testnet milestone, append `?escrow=0xd7813f530fd625added1b4b8c1d09e0e4dd6be3d&milestone=1` to that URL. Viewing the milestone uses the public Mezo Testnet RPC and needs no wallet connection.

In a separate terminal, run the contract tests and build the static frontend.

```bash
npm test
npm run build
```

The build writes the site to `dist` for HTTPS hosting.

## Buildathon walkthrough

1. Open the sample electrical installation. Fund the 1,200 MUSD milestone.
2. Approve the 600 MUSD materials item and the 300 MUSD first-fix item. Dispute the 300 MUSD final-testing item.
3. Release the approved funds. Check the 900 MUSD released and the 300 MUSD still held.
4. For the alternate payout, set the contractor’s first-fix preference to a 300 mUSDC minimum. The sample exchange rate requires an owner top-up. A 2 MUSD top-up produces a 300.49 mUSDC demo quote.

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
