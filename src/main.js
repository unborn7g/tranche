import '@fontsource-variable/geist';
import '@fontsource-variable/dm-sans';
import './style.css';
import { formatEther, formatUnits, getAddress, isAddress, keccak256, parseUnits, stringToHex, zeroAddress } from 'viem';
import { connectWallet, makeReader, mezo, planBorrow, reviewTypes, sameAddress, simulateBorrow } from './mezo.js';
import { approveMusd, confirmed, deployEscrow, ensureAccount, escrowAbi, escrowConfig, escrowWrite, eventArgs, getMilestone } from './live.js';
import { button, explorer, formatAmount, icon, renderApp, safe, short, statusLabels } from './ui.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const sample = [
  { label: 'Electrical materials', detail: 'Panels, wiring and fixtures', payee: 'Supplier', amount: 600, icon: 'box' },
  { label: 'First-fix installation', detail: 'Cabling and conduit labour', payee: 'Contractor', amount: 300, icon: 'bolt' },
  { label: 'Final testing', detail: 'Inspection and commissioning', payee: 'Contractor', amount: 300, icon: 'tool' },
];
const params = new URLSearchParams(location.search);
const publicReader = makeReader();
const emptyDemo = () => ({
  funded: false, statuses: [0, 0, 0], floors: ['', '', ''], received: ['', '', ''],
  events: [{ title: 'Milestone prepared', detail: 'Three work items · 1,200 MUSD', glyph: 'file' }],
});

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`tranche:${key}`)) ?? fallback; } catch { return fallback; }
}
function saveStorage(key, value) {
  try { localStorage.setItem(`tranche:${key}`, JSON.stringify(value)); } catch { /* Private browsing can disable storage. */ }
}

const sharedMilestone = params.get('milestone');
const hasShareLink = params.has('escrow') || sharedMilestone !== null;
const selectedAddress = hasShareLink ? params.get('escrow') : readStorage('escrow', null);
const address = typeof selectedAddress === 'string' && isAddress(selectedAddress, { strict: false }) &&
  !sameAddress(selectedAddress, zeroAddress) ? getAddress(selectedAddress) : null;
const state = {
  mode: hasShareLink ? 'testnet' : 'demo', view: 'milestone', demo: readStorage('demo-v1', emptyDemo()),
  session: null, address, live: null, config: null, busy: false,
  events: readStorage('testnet-events', []),
};
let dialogSubmit = null;
let dialogAction = null;
let noticeTimeout;

function demoMilestone() {
  const lines = sample.map((line, index) => ({
    ...line, budget: parseUnits(String(line.amount), 18), recipient: zeroAddress,
    status: state.demo.statuses[index], minMusdc: parseUnits(state.demo.floors[index] || '0', 6),
    amountPaid: parseUnits(state.demo.received[index] || '0', 6),
  }));
  const held = state.demo.funded ? lines.filter(line => line.status < 3).reduce((sum, line) => sum + line.budget, 0n) : 0n;
  return { id: 1n, title: 'Electrical installation', lines, budget: parseUnits('1200', 18), held, funded: state.demo.funded };
}

function render() {
  const mode = state.mode;
  app.innerHTML = renderApp({
    ...state, contractAddress: state.address,
    milestone: mode === 'demo' ? demoMilestone() : state.live,
    events: mode === 'demo' ? state.demo.events : state.events,
    payoutDecimals: mode === 'demo' ? 6 : state.config?.payoutDecimals ?? 6,
  });
}

function say(message, { error = false, hash } = {}) {
  clearTimeout(noticeTimeout);
  notice.className = `toast ${error ? 'toast-error' : ''}`;
  notice.innerHTML = `<span>${icon(error ? 'info' : 'check', 17)}</span><div>${safe(message)}${hash ? explorer('tx', hash, 'View transaction') : ''}</div>`;
  noticeTimeout = setTimeout(() => { notice.className = ''; notice.innerHTML = ''; }, hash || error ? 16_000 : 5_500);
}

function report(error) {
  const message = String(error.shortMessage ?? error.message ?? error).slice(0, 260);
  if (dialog.open) {
    const feedback = dialog.querySelector('.form-feedback');
    if (feedback) feedback.textContent = message;
  }
  say(message, { error: true });
}

async function work(fn) {
  if (state.busy) return;
  state.busy = true;
  render();
  if (dialog.open) dialog.querySelector('form').setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (error) {
    report(error);
  } finally {
    state.busy = false;
    if (dialog.open) dialog.querySelector('form').removeAttribute('aria-busy');
    render();
  }
}

function modal(title, description, body, submit, handler, action = null) {
  dialogSubmit = handler;
  dialogAction = action;
  dialog.innerHTML = `<form class="modal-form"><div class="modal-head"><div><h2 id="dialog-title">${safe(title)}</h2><p>${safe(description)}</p></div><button type="button" class="icon-button" data-modal="close" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body">${body}</div><p class="form-feedback" role="alert"></p><div class="modal-footer"><button type="button" class="button outline" data-modal="close">Cancel</button><button type="submit" class="button primary">${safe(submit)} ${icon('arrow', 17)}</button></div></form>`;
  if (!dialog.open) dialog.showModal();
}

function field(label, name, value = '', attributes = '') {
  return `<label class="field"><span>${safe(label)}</span><input name="${name}" value="${safe(value)}" ${attributes}></label>`;
}

function addEvent(title, detail, glyph, hash) {
  const event = { title, detail, glyph, hash };
  if (state.mode === 'demo') {
    state.demo.events.unshift(event);
    saveStorage('demo-v1', state.demo);
  } else {
    state.events.unshift(event);
    state.events = state.events.slice(0, 100);
    saveStorage('testnet-events', state.events);
  }
}

const pending = hash => say('Transaction submitted. Waiting for confirmation.', { hash });
const reader = () => state.session?.reader ?? publicReader;
const milestone = () => state.mode === 'demo' ? demoMilestone() : state.live;
const txDeadline = () => BigInt(Math.floor(Date.now() / 1_000) + 600);

function positiveAmount(value, decimals, allowZero = false) {
  const input = String(value ?? '').trim();
  const expression = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!expression.test(input) || input.length > 44) throw new Error('Enter a valid amount with no commas.');
  const amount = parseUnits(input, decimals);
  if (!allowZero && amount <= 0n) throw new Error('Enter an amount greater than zero.');
  return amount;
}

function addressInput(value) {
  const input = String(value ?? '').trim();
  if (!isAddress(input, { strict: false }) || /^0x0+$/i.test(input)) throw new Error('Enter a valid, nonzero wallet or contract address.');
  return getAddress(input);
}

function milestoneId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{0,31}$/.test(id)) throw new Error('Enter a positive milestone ID.');
  return BigInt(id);
}

async function loadMilestone(id) {
  if (!state.address) throw new Error('Open an escrow deployment first.');
  state.config ??= await escrowConfig(reader(), state.address);
  state.live = await getMilestone(reader(), state.address, id);
  state.view = 'milestone';
}

function setDeployment(selected, config) {
  state.address = selected;
  state.config = config;
  state.live = null;
  saveStorage('escrow', selected);
}

function showFunding() {
  const current = milestone();
  modal('Fund milestone', state.mode === 'demo' ? 'Add simulated MUSD to the demo escrow.' : 'Approve the escrow contract and deposit testnet MUSD from your wallet.',
    `<div class="total-strip"><span>Escrow deposit</span><strong>${formatAmount(current.budget)} MUSD</strong></div>`,
    'Fund escrow', async () => {
      if (state.mode === 'demo') {
        state.demo.funded = true;
        addEvent('Milestone funded', '1,200 MUSD reserved', 'wallet');
      } else {
        await approveMusd(state.session, state.address, current.budget, pending);
        const receipt = await escrowWrite(state.session, state.address, 'fund', [current.id], pending);
        addEvent('Milestone funded', `${formatAmount(current.budget)} MUSD · #${current.id}`, 'wallet', receipt.transactionHash);
        await loadMilestone(current.id);
      }
      dialog.close();
      say('Milestone funded. The reviewer can assess the work.');
    });
}

function showReview() {
  const current = milestone();
  const demo = state.mode === 'demo';
  const rows = current.lines.map((line, index) => line.status >= 3 ? '' : `<label class="form-line"><span><strong>${safe(line.label)}</strong><small>${formatAmount(line.budget)} MUSD · ${statusLabels[line.status]}</small></span><select name="decision-${index}"><option value="" ${demo && line.status === 2 ? 'selected' : ''}>Keep status</option><option value="0" ${demo && line.status === 0 && index < 2 ? 'selected' : ''}>Approve</option><option value="1" ${demo && line.status === 0 && index === 2 ? 'selected' : ''}>Dispute</option>${line.status === 2 ? '<option value="2">Refund owner</option>' : ''}</select></label>`).join('');
  modal('Review work items', demo ? 'Mark completed work as approved and flag any disputed items.' : 'Your wallet signs a certificate for each changed work item.',
    `${rows}<label class="field"><span>Evidence or review note</span><textarea name="evidence" rows="3" maxlength="2000" required>${demo ? 'First-fix work confirmed. Final testing requires a revised commissioning report.' : ''}</textarea><small>The contract records a hash of the note.</small></label>`,
    demo ? 'Submit review' : 'Sign and submit', async data => {
      const choices = current.lines.flatMap((line, index) => {
        const decision = data.get(`decision-${index}`);
        return decision === null || decision === '' ? [] : [{ line, index, decision: Number(decision) }];
      });
      if (!choices.length) throw new Error('Choose a decision for at least one work item.');
      const evidence = String(data.get('evidence') ?? '').trim();
      if (!evidence) throw new Error('Enter an evidence or review note.');
      if (demo) {
        for (const { index, decision } of choices) state.demo.statuses[index] = [1, 2, 4][decision];
        addEvent('Work items reviewed', `${choices.length} decisions recorded`, 'file');
      } else {
        await ensureAccount(state.session);
        const evidenceHash = keccak256(stringToHex(evidence));
        const reviews = choices.map(({ line, index, decision }) => ({
          milestoneId: current.id, lineIndex: BigInt(index), decision, evidenceHash, revision: line.revision + 1n, deadline: txDeadline(),
        }));
        const signatures = [];
        for (const review of reviews) {
          signatures.push(await state.session.wallet.signTypedData({
            account: state.session.account, domain: { name: 'Tranche', version: '1', chainId: mezo.id, verifyingContract: state.address },
            types: reviewTypes, primaryType: 'Review', message: review,
          }));
        }
        const receipt = await escrowWrite(state.session, state.address, 'applyReviews', [reviews, signatures], pending);
        addEvent('Signed review confirmed', `Milestone #${current.id} · ${reviews.length} decisions`, 'file', receipt.transactionHash);
        await loadMilestone(current.id);
      }
      dialog.close();
      say('Review recorded. Approved work can now be paid.');
    });
}

function showPayout(index) {
  const current = milestone();
  const line = current.lines[index];
  const demo = state.mode === 'demo';
  const decimals = demo ? 6 : state.config.payoutDecimals;
  modal('Payout preference', 'The recipient sets the currency and minimum amount they will accept.',
    `<label class="field"><span>Receive</span><select name="currency"><option value="musd">MUSD</option><option value="musdc" ${line.minMusdc ? 'selected' : ''}>mUSDC (testnet USDC)</option></select></label>${field('Minimum mUSDC when selected', 'minimum', line.minMusdc ? formatUnits(line.minMusdc, decimals) : formatUnits(line.budget, 18), 'inputmode="decimal"')}<p class="hint">The owner can add MUSD to cover a conversion shortfall.</p>`,
    'Save preference', async data => {
      const floor = data.get('currency') === 'musdc' ? positiveAmount(data.get('minimum'), decimals) : 0n;
      if (demo) {
        state.demo.floors[index] = formatUnits(floor, decimals);
        addEvent('Payout preference set', `${line.payee} · ${floor ? 'mUSDC' : 'MUSD'}`, 'wallet');
      } else {
        const receipt = await escrowWrite(state.session, state.address, 'setPayout', [current.id, BigInt(index), floor], pending);
        addEvent('Payout preference set', `${line.label} · ${floor ? 'mUSDC' : 'MUSD'}`, 'wallet', receipt.transactionHash);
        await loadMilestone(current.id);
      }
      dialog.close();
      say('Payout preference saved.');
    });
}

function showSettlement() {
  const current = milestone();
  const demo = state.mode === 'demo';
  const decimals = demo ? 6 : state.config.payoutDecimals;
  const approved = current.lines.flatMap((line, index) => line.status === 1 ? [{ ...line, index }] : []);
  const approvedBudget = approved.reduce((sum, line) => sum + line.budget, 0n);
  const payments = data => approved.map(line => ({
    lineIndex: BigInt(line.index), minOut: line.minMusdc,
    extraMusd: line.minMusdc ? positiveAmount(data.get(`extra-${line.index}`) || '0', 18, true) : 0n,
  }));
  const quote = async (line, extra) => demo
    ? (line.budget + extra) * 9_950n / 10_000n / 10n ** 12n
    : reader().readContract({ address: state.address, abi: escrowAbi, functionName: 'quoteMusdc', args: [line.budget + extra] });
  const rows = approved.map(line => `<div class="settlement-line"><div class="form-line"><span><strong>${safe(line.label)}</strong><small>${safe(line.payee ?? short(line.recipient))}</small></span><strong>${formatAmount(line.budget)} MUSD</strong></div>${line.minMusdc ? `<p class="hint">Recipient minimum ${formatUnits(line.minMusdc, decimals)} mUSDC</p>${field('Owner top-up (MUSD)', `extra-${line.index}`, demo ? '2' : '0', 'inputmode="decimal"')}<p class="hint" data-quote="${line.index}"></p>` : ''}</div>`).join('');
  const hasSwap = approved.some(line => line.minMusdc);
  let verifiedAmounts = null;
  modal('Release approved funds', 'Disputed items stay in escrow.',
    `${rows}<div class="total-strip"><span>Approved budget</span><strong>${formatAmount(approvedBudget)} MUSD</strong></div>${hasSwap ? '<button type="button" class="button outline" data-modal="quote">Check payout quote</button>' : ''}`,
    'Release funds', async data => {
      const instructions = payments(data);
      if (hasSwap && (!verifiedAmounts || verifiedAmounts.some((amount, i) => amount !== instructions[i].extraMusd))) {
        throw new Error('Check the payout quote for these top-up amounts first.');
      }
      if (demo) {
        for (const [i, instruction] of instructions.entries()) {
          const line = approved[i];
          if (line.minMusdc) {
            const received = await quote(line, instruction.extraMusd);
            if (received < line.minMusdc) throw new Error('Increase the owner top-up to meet the recipient minimum.');
            state.demo.received[line.index] = formatUnits(received, decimals);
          }
        }
        for (const line of approved) state.demo.statuses[line.index] = 3;
        addEvent('Approved funds released', `${formatAmount(approvedBudget)} MUSD of milestone budget`, 'check');
      } else {
        const topUp = instructions.reduce((sum, instruction) => sum + instruction.extraMusd, 0n);
        await approveMusd(state.session, state.address, topUp, pending);
        const receipt = await escrowWrite(state.session, state.address, 'settle', [current.id, instructions, txDeadline()], pending);
        addEvent('Approved funds released', `${formatAmount(approvedBudget)} MUSD of milestone budget · #${current.id}`, 'check', receipt.transactionHash);
        await loadMilestone(current.id);
      }
      dialog.close();
      say('Approved funds released.');
    }, async (action, data) => {
      if (action !== 'quote') return;
      verifiedAmounts = null;
      const instructions = payments(data);
      const quotes = await Promise.all(approved.map((line, i) => line.minMusdc ? quote(line, instructions[i].extraMusd) : 0n));
      let meetsMinimum = true;
      for (const [i, line] of approved.entries()) {
        if (!line.minMusdc) continue;
        const enough = quotes[i] >= line.minMusdc;
        meetsMinimum &&= enough;
        dialog.querySelector(`[data-quote="${line.index}"]`).textContent = `${demo ? 'Demo quote' : 'Current quote'} ${formatUnits(quotes[i], decimals)} mUSDC${enough ? '' : ' · below minimum'}`;
      }
      if (!meetsMinimum) throw new Error('At least one quote is below the recipient minimum. Increase the top-up.');
      verifiedAmounts = instructions.map(instruction => instruction.extraMusd);
      dialog.querySelector('.form-feedback').textContent = '';
    });
}

function showCreate() {
  const row = (label = '', amount = '') => `<div class="create-row">${field('Work item', 'label', label, 'maxlength="120" required')}${field('MUSD', 'budget', amount, 'inputmode="decimal" required')}${field('Recipient wallet', 'recipient', '', 'placeholder="0x…" required')}<button type="button" class="icon-button" data-modal="remove-item" aria-label="Remove work item">${icon('close', 16)}</button></div>`;
  modal('Create milestone', 'Set the budget, the independent reviewer, and the recipients.',
    `${field('Milestone title', 'title', 'Electrical installation', 'maxlength="120" required')}${field('Reviewer wallet', 'reviewer', '', 'placeholder="0x…" required')}<div id="create-rows">${sample.map(item => row(item.label, item.amount)).join('')}</div><button type="button" class="button outline" data-modal="add-item">${icon('plus', 17)} Add item</button>`,
    'Create milestone', async data => {
      const budgets = data.getAll('budget');
      const recipients = data.getAll('recipient');
      const lines = data.getAll('label').map((label, index) => ({ label: String(label).trim(), budget: positiveAmount(budgets[index], 18), recipient: addressInput(recipients[index]) }));
      const receipt = await escrowWrite(state.session, state.address, 'createMilestone', [String(data.get('title')).trim(), addressInput(data.get('reviewer')), lines], pending);
      const created = eventArgs(receipt, state.address, 'MilestoneCreated')[0];
      if (!created) throw new Error('The confirmation did not include a milestone ID. Check the explorer record.');
      addEvent('Milestone created', `Milestone #${created.id} · ${lines.length} work items`, 'file', receipt.transactionHash);
      await loadMilestone(created.id);
      dialog.close();
      say(`Milestone #${created.id} is ready to fund.`);
    }, (action, _data, target) => {
      const rows = dialog.querySelector('#create-rows');
      if (action === 'add-item' && rows.childElementCount < 12) rows.insertAdjacentHTML('beforeend', row());
      if (action === 'remove-item' && rows.childElementCount > 1) target.closest('.create-row').remove();
    });
}

function showBorrow() {
  modal('Borrow testnet MUSD', 'Open a new Mezo loan with testnet BTC as collateral.',
    `${field('MUSD to borrow', 'amount', '2000', 'inputmode="decimal" required')}${field('Testnet BTC collateral', 'collateral', '', 'inputmode="decimal" placeholder="Enter BTC amount" required')}<p class="hint">Mezo’s documented minimum loan is 1,800 MUSD. The wallet also needs BTC for gas.</p>`, 'Check loan', async data => {
      const amount = positiveAmount(data.get('amount'), 18);
      const collateral = positiveAmount(data.get('collateral'), 18);
      await ensureAccount(state.session);
      const plan = await planBorrow(reader(), state.session.account, amount, collateral);
      modal('Confirm testnet loan', 'Review the on-chain quote before confirming in your wallet.',
        `<dl class="summary-list"><div><dt>Borrow</dt><dd>${formatAmount(plan.amount)} MUSD</dd></div><div><dt>BTC collateral</dt><dd>${formatEther(plan.collateral)} BTC</dd></div><div><dt>Estimated opening debt</dt><dd>${formatAmount(plan.totalDebt, 18, 5)} MUSD</dd></div><div><dt>Collateral ratio</dt><dd>${formatUnits(plan.ratio, 2)}%</dd></div></dl><p class="hint">The opening debt includes Mezo’s fee and gas reserve. Loan eligibility is checked again before signing.</p>`,
        'Open loan', async () => {
          await ensureAccount(state.session);
          const fresh = await planBorrow(reader(), state.session.account, amount, collateral);
          const request = await simulateBorrow(reader(), state.session.account, fresh);
          const receipt = await confirmed(reader(), await state.session.wallet.writeContract(request), pending);
          addEvent('Mezo loan opened', `${formatAmount(amount)} MUSD borrowed`, 'bolt', receipt.transactionHash);
          dialog.close();
          say('Mezo confirmed the testnet loan.', { hash: receipt.transactionHash });
        });
    });
}

const actions = {
  milestone() { state.view = 'milestone'; render(); },
  activity() { state.view = 'activity'; render(); },
  setup() { state.mode = 'testnet'; state.view = 'setup'; render(); },
  'demo-mode'() { state.mode = 'demo'; state.view = 'milestone'; render(); },
  'testnet-mode'() { state.mode = 'testnet'; state.view = state.live ? 'milestone' : 'setup'; render(); },
  reset() {
    modal('Reset walkthrough', 'Return this browser’s demo to the unfunded milestone.', '', 'Reset demo', () => {
      state.demo = emptyDemo(); saveStorage('demo-v1', state.demo); dialog.close();
    });
  },
  wallet() {
    return work(async () => {
      state.session = await connectWallet(window.ethereum);
      say(`Connected ${short(state.session.account)} on Mezo Testnet.`);
      if (sharedMilestone !== null && sameAddress(state.address, address) && !state.live) {
        await loadMilestone(milestoneId(sharedMilestone));
      }
    });
  },
  attach() {
    modal('Open escrow deployment', 'Use a trusted Tranche contract address on Mezo Testnet.',
      field('Contract address', 'address', state.address ?? '', 'placeholder="0x…" required'), 'Open deployment', async data => {
        const selected = addressInput(data.get('address'));
        setDeployment(selected, await escrowConfig(reader(), selected));
        dialog.close();
        say('Mezo Testnet deployment opened.');
      });
  },
  deploy() {
    modal('Deploy escrow contract', 'Your wallet will pay the testnet BTC gas fee.', '', 'Deploy escrow', async () => {
      const { address: selected, hash } = await deployEscrow(state.session, pending);
      setDeployment(selected, null);
      addEvent('Escrow deployed', selected, 'code', hash);
      dialog.close();
      state.config = await escrowConfig(reader(), selected);
      say(`Deployed ${short(selected)} on Mezo Testnet.`, { hash });
    });
  },
  create: showCreate,
  load() {
    modal('Open milestone', 'Enter the milestone ID shown by the creator.', field('Milestone ID', 'id', '', 'inputmode="numeric" required'), 'Open milestone', async data => {
      await loadMilestone(milestoneId(data.get('id')));
      dialog.close();
    });
  },
  refresh() { return work(() => loadMilestone(state.live.id)); },
  share() {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ escrow: state.address, milestone: state.live.id.toString() });
    modal('Share milestone', 'Recipients and the reviewer can open this link with their own wallets.', field('Milestone link', 'url', url.href, 'readonly'), 'Copy link', async () => {
      await navigator.clipboard.writeText(url.href);
      dialog.close(); say('Milestone link copied.');
    });
  },
  fund: showFunding,
  review: showReview,
  payout: target => showPayout(Number(target.dataset.index)),
  settle: showSettlement,
  borrow: showBorrow,
};

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || state.busy) return;
  try { actions[target.dataset.action]?.(target); } catch (error) { report(error); }
});

dialog.addEventListener('click', event => {
  const target = event.target.closest('[data-modal]');
  if (!target || state.busy) return;
  if (target.dataset.modal === 'close') { dialog.close(); return; }
  const action = target.dataset.modal;
  const data = new FormData(dialog.querySelector('form'));
  if (action === 'quote') void work(() => dialogAction?.(action, data, target));
  else dialogAction?.(action, data, target);
});

dialog.addEventListener('submit', event => {
  event.preventDefault();
  const handler = dialogSubmit;
  const data = new FormData(event.target);
  const feedback = dialog.querySelector('.form-feedback');
  feedback.textContent = '';
  void work(() => handler?.(data));
});

dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });

window.ethereum?.on?.('accountsChanged', () => { state.session = null; render(); });
window.ethereum?.on?.('chainChanged', () => { state.session = null; render(); });

render();
if (hasShareLink && !state.address) {
  say('This link has an invalid or missing escrow address.', { error: true });
} else if (sharedMilestone !== null) {
  void work(() => loadMilestone(milestoneId(sharedMilestone)));
}
