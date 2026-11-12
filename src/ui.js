import { formatUnits } from 'viem';
import { mezo, sameAddress } from './mezo.js';

const symbols = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  external: '<path d="M13 5h6v6m0-6-9 9"/><path d="M19 13v6H5V5h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v3M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-1Z"/><path d="M21 12h-5a2 2 0 0 0 0 4h5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  building: '<path d="M4 21h16M6 21V7l6-4 6 4v14M10 21v-4h4v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm-8 4.5 8 4.5 8-4.5m-8 4.5v9m-4-15.8 8 4.5"/>',
  tool: '<path d="M14 7a5 5 0 0 0-6-6l3 3-3 3-3-3a5 5 0 0 0 6 6L3 18a2 2 0 0 0 3 3l8-8a5 5 0 0 0 6-6l-3 3-3-3Z"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m-4 0a7 7 0 0 1 12-5l3 5m-16 0 3 5a7 7 0 0 0 12-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H4v12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
};

export function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] ?? symbols.file}</svg>`;
}

export function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function formatAmount(amount, decimals = 18, precision = 2) {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.');
  const displayFraction = fraction.slice(0, precision).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString('en-US')}${displayFraction ? `.${displayFraction}` : ''}`;
}

export function short(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '';
}

export function explorer(type, value, label) {
  return `<a class="text-link" href="${mezo.blockExplorers.default.url}/${type}/${encodeURIComponent(value)}" target="_blank" rel="noreferrer">${safe(label)} ${icon('external', 14)}</a>`;
}

export const statusLabels = ['Pending', 'Approved', 'Disputed', 'Paid', 'Refunded'];
const statusClasses = ['pending', 'approved', 'disputed', 'paid', 'refunded'];

function statusTag(status) {
  return `<span class="tag tag-${statusClasses[status]}"><i></i>${statusLabels[status]}</span>`;
}

export function button(label, action, glyph = '', className = 'primary', disabled = false, attributes = '') {
  return `<button type="button" class="button ${className}" data-action="${action}" ${disabled ? 'disabled' : ''} ${attributes}>${glyph ? icon(glyph, 17) : ''}${safe(label)}</button>`;
}

export function totals(milestone) {
  const budgetInStatus = status => milestone.lines.filter(line => line.status === status).reduce((sum, line) => sum + line.budget, 0n);
  return { paid: budgetInStatus(3), approved: budgetInStatus(1), disputed: budgetInStatus(2), refunded: budgetInStatus(4) };
}

function navigation(view, mode) {
  const navItem = (name, label, glyph, active) => `<button type="button" class="nav-link ${active ? 'selected' : ''}" data-action="${name}" ${active ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></button>`;
  return `<aside class="sidebar" aria-label="Tranche navigation">
    <button type="button" class="wordmark" data-action="milestone" aria-label="Tranche home"><span class="brand-mark"><i></i><i></i><i></i></span>Tranche<span class="wordmark-dot">.</span></button>
    <nav class="nav">
      <span class="nav-caption">Workspace</span>
      ${navItem('milestone', 'Milestone', 'grid', view === 'milestone')}
      ${navItem('activity', 'Activity', 'activity', view === 'activity')}
      ${navItem('setup', 'Testnet setup', 'code', view === 'setup')}
    </nav>
    <div class="sidebar-end">
      <div class="network-note"><span class="network-icon">M</span><div><strong>Mezo</strong><small>${mode === 'demo' ? 'Demo environment' : 'Testnet · 31611'}</small></div><span class="network-led"></span></div>
      <a href="https://mezo.org/docs/developers/getting-started/" target="_blank" rel="noreferrer" class="sidebar-link">Mezo docs ${icon('external', 14)}</a>
    </div>
  </aside>`;
}

function header({ mode, session, busy, view }) {
  const page = { milestone: 'Milestone', activity: 'Activity', setup: 'Testnet setup' }[view];
  return `<header class="topbar"><div class="crumb"><span>Workspace</span>${icon('chevron', 13)}<strong>${page}</strong></div>
    <div class="top-actions">
      <div class="mode-switch" aria-label="Environment">
        <button type="button" data-action="demo-mode" aria-pressed="${mode === 'demo'}" ${busy ? 'disabled' : ''}>Demo</button>
        <button type="button" data-action="testnet-mode" aria-pressed="${mode === 'testnet'}" ${busy ? 'disabled' : ''}>Testnet</button>
      </div>
      ${mode === 'testnet' ? button(session ? short(session.account) : 'Connect wallet', 'wallet', 'wallet', 'outline wallet-button', busy) : '<span class="mode-indicator"><i></i>Demo mode</span>'}
    </div>
  </header>`;
}

function hero(milestone, stats, context) {
  const { mode, busy, contractAddress } = context;
  const percentage = Number(stats.paid * 100n / milestone.budget);
  const cleared = stats.paid + stats.refunded;
  const stateLabel = !milestone.funded ? 'Awaiting funding' : cleared === milestone.budget ? 'Complete' : stats.paid > 0n ? 'Partial payout' : stats.approved > 0n ? 'Ready for payout' : 'Funded';
  return `<div class="page-heading">
    <div><p class="kicker">${icon('building', 16)} ${mode === 'demo' ? 'Sample project' : 'Mezo Testnet'}</p><h1>${safe(mode === 'demo' ? 'Westbridge House' : milestone.title)}</h1><p>${mode === 'demo' ? 'Cross-border construction · Electrical work' : `Milestone #${milestone.id} · Bitcoin-backed payments`}</p></div>
    ${mode === 'demo' ? button('Reset demo', 'reset', 'refresh', 'outline subtle-button', busy) : `<div class="heading-actions">${button('Share', 'share', 'copy', 'outline', busy)}${button('Refresh', 'refresh', 'refresh', 'outline', busy)}</div>`}
  </div>
  <section class="hero" aria-label="Milestone budget and progress">
    <div class="hero-grid" aria-hidden="true"></div>
    <div class="hero-copy">
      <div class="hero-label"><span class="hero-glyph">${icon('bolt', 19)}</span><span>${safe(mode === 'demo' ? milestone.title : 'Milestone budget')}</span></div>
      <div class="hero-amount">${formatAmount(milestone.budget)} <span>MUSD</span></div>
      <span class="hero-status"><i></i>${stateLabel}</span>
    </div>
    <div class="hero-progress" aria-label="${percentage}% of budget paid">
      <div class="ring" style="--progress:${percentage}%"><div><strong>${percentage}%</strong><small>paid</small></div></div>
    </div>
  </section>
  <div class="metrics" aria-label="Escrow balances">
    ${metric('Funded', milestone.funded ? milestone.budget : 0n, 'wallet', 'violet')}
    ${metric('Released', stats.paid, 'check', 'green')}
    ${metric('Held in escrow', milestone.held, 'lock', 'amber')}
  </div>
  ${mode === 'testnet' && contractAddress ? `<div class="chain-record">Contract ${explorer('address', contractAddress, short(contractAddress))}<span>·</span> Reviewer ${explorer('address', milestone.reviewer, short(milestone.reviewer))}${stats.refunded > 0n ? `<span>·</span> ${formatAmount(stats.refunded)} MUSD refunded` : ''}</div>` : ''}`;
}

function metric(label, value, glyph, colour) {
  return `<div class="metric"><span class="metric-icon ${colour}">${icon(glyph, 18)}</span><div><span>${label}</span><strong>${formatAmount(value)} <small>MUSD</small></strong></div></div>`;
}

function workItems(milestone, { mode, busy, session, payoutDecimals }) {
  const rows = milestone.lines.map((line, index) => {
    const canSelect = (mode === 'demo' ? index === 1 : sameAddress(session?.account, line.recipient)) && line.status < 3;
    const payout = line.minMusdc > 0n ? `${line.status === 3 ? formatAmount(line.amountPaid, payoutDecimals) + ' ' : ''}mUSDC` : 'MUSD';
    return `<tr>
      <td><div class="item-cell"><span class="item-icon">${icon(line.icon || 'file', 16)}</span><div><strong>${safe(line.label)}</strong><small>${safe(line.detail ?? (line.evidenceHash && !/^0x0+$/.test(line.evidenceHash) ? `Evidence ${short(line.evidenceHash)}` : ''))}</small></div></div></td>
      <td><strong class="payee">${safe(line.payee ?? short(line.recipient))}</strong><span class="table-payout">${payout}</span></td>
      <td class="amount-cell">${formatAmount(line.budget)} <span>MUSD</span></td>
      <td>${statusTag(line.status)}</td>
      <td class="table-actions">${canSelect ? `<button type="button" class="icon-button" aria-label="Payout preference for ${safe(line.label)}" title="Payout preference" data-action="payout" data-index="${index}" ${busy ? 'disabled' : ''}>${icon('dots', 18)}</button>` : ''}</td>
    </tr>`;
  }).join('');
  return `<section class="card work-card"><div class="card-title"><div><h2>Work items</h2><p>Payment amounts and review status</p></div><span class="count-pill">${milestone.lines.length} items</span></div>
    <div class="table-wrap"><table><thead><tr><th scope="col">Item</th><th scope="col">Recipient</th><th scope="col">Budget</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="table-footer">${icon('shield', 16)} Only approved items can be paid.</div>
  </section>`;
}

function workflow(milestone, stats, context) {
  const { mode, session, busy } = context;
  const owner = mode === 'demo' || sameAddress(session?.account, milestone.owner);
  const reviewer = mode === 'demo' || sameAddress(session?.account, milestone.reviewer);
  const reviewed = milestone.lines.some(line => line.status !== 0);
  const hasUnpaid = milestone.lines.some(line => line.status < 3);
  const settled = stats.paid > 0n;
  const stage = !milestone.funded ? 0 : !reviewed ? 1 : stats.approved > 0n ? 2 : settled || !hasUnpaid ? 3 : 1;
  const steps = [
    ['Fund escrow', 'Owner commits MUSD upfront.', milestone.funded],
    ['Review the work', 'Reviewer signs off on each item.', reviewed],
    ['Release payment', 'Approved funds go to recipients.', settled],
  ];
  let action = '';
  if (!milestone.funded && owner) action = button('Fund milestone', 'fund', 'arrow', 'primary full', busy);
  if (milestone.funded && hasUnpaid && reviewer && (stats.approved === 0n || mode === 'testnet')) action = button('Review work items', 'review', 'file', 'primary full', busy);
  if (milestone.funded && stats.approved > 0n && owner) action = button('Release approved funds', 'settle', 'arrow', 'primary full', busy);
  if (!action && mode === 'testnet' && !session) action = button('Connect wallet', 'wallet', 'wallet', 'primary full', busy);
  if (!action && settled && mode === 'demo') action = button('View activity', 'activity', 'arrow', 'primary full', busy);
  if (!action && mode === 'testnet') action = '<p class="action-note">Connect the assigned owner or reviewer wallet to take the next step.</p>';
  const notice = stats.disputed > 0n ? `<div class="held-note">${icon('lock', 15)} <span><strong>${formatAmount(stats.disputed)} MUSD</strong> held for disputed work.</span></div>` : '';
  return `<section class="card workflow-card"><div class="card-title"><div><h2>Payment workflow</h2><p>${mode === 'demo' ? 'Walk through the three roles' : 'Review each step on Mezo'}</p></div></div>
    <ol class="workflow">${steps.map(([label, description, done], index) => `<li class="${done ? 'done' : ''} ${index === stage ? 'current' : ''}"><span class="step-index">${done ? icon('check', 15) : index + 1}</span><div><strong>${label}</strong><small>${description}</small></div></li>`).join('')}</ol>
    ${notice}<div class="workflow-action">${action}</div>
  </section>`;
}

function activityPanel(context, compact = false) {
  const { events, mode } = context;
  const visible = compact ? events.slice(0, 3) : events;
  return `<section class="card activity-card"><div class="card-title"><div><h2>${compact ? 'Recent activity' : 'Transaction history'}</h2><p>${mode === 'demo' ? 'Events from this walkthrough' : 'Transactions recorded by this browser'}</p></div>${compact ? button('View activity', 'activity', 'arrow', 'text-button') : ''}</div>
    ${visible.length ? `<ul class="events">${visible.map(event => `<li><span class="event-icon">${icon(event.glyph ?? 'activity', 17)}</span><div><strong>${safe(event.title)}</strong><small>${safe(event.detail)}</small></div><div class="event-side">${event.hash ? explorer('tx', event.hash, short(event.hash)) : `<small>${mode === 'demo' ? 'Demo' : ''}</small>`}</div></li>`).join('')}</ul>` : '<p class="empty-events">Transactions you send from Tranche appear here after confirmation.</p>'}
  </section>`;
}

function setupPanel({ session, contractAddress, busy }) {
  return `<div class="page-heading"><div><p class="kicker">${icon('code', 16)} Chain 31611</p><h1>Testnet setup</h1><p>Use a wallet with testnet BTC to deploy and run a milestone.</p></div></div>
    <div class="setup-grid">
      <section class="card setup-card"><span class="metric-icon violet">${icon('wallet', 20)}</span><h2>Wallet</h2><p>${session ? `Connected as ${safe(short(session.account))}.` : 'Connect an Ethereum-compatible browser wallet.'}</p><div class="button-group">${button(session ? 'Change wallet' : 'Connect wallet', 'wallet', 'wallet', 'primary', busy)}<a class="text-link" href="https://faucet.test.mezo.org/" target="_blank" rel="noreferrer">Mezo faucet ${icon('external', 14)}</a></div></section>
      <section class="card setup-card"><span class="metric-icon green">${icon('code', 20)}</span><h2>Escrow contract</h2><p>${contractAddress ? 'Your selected deployment' : 'Deploy Tranche or open a trusted testnet deployment.'}</p>${contractAddress ? explorer('address', contractAddress, short(contractAddress)) : ''}<div class="button-group">${button('Deploy escrow', 'deploy', 'plus', 'primary', busy || !session)}${button('Open deployment', 'attach', '', 'outline', busy)}</div></section>
      <section class="card setup-card"><span class="metric-icon amber">${icon('bolt', 20)}</span><h2>Fund with MUSD</h2><p>Borrow test MUSD against testnet BTC or use MUSD already in your wallet.</p><div class="button-group">${button('Borrow MUSD', 'borrow', 'bolt', 'primary', busy || !session)}<a class="text-link" href="https://testnet.mezo.org/feature/borrow" target="_blank" rel="noreferrer">Mezo Borrow ${icon('external', 14)}</a></div></section>
      <section class="card setup-card"><span class="metric-icon violet">${icon('grid', 20)}</span><h2>Milestones</h2><p>Create a milestone with separate reviewer and recipient wallets, or load one by ID.</p><div class="button-group">${button('Create milestone', 'create', 'plus', 'primary', busy || !session || !contractAddress)}${button('Open milestone', 'load', '', 'outline', busy || !contractAddress)}</div></section>
    </div>`;
}

export function renderApp(context) {
  const { view, mode, milestone, busy } = context;
  const stats = milestone ? totals(milestone) : null;
  let page;
  if (view === 'activity') {
    page = `<div class="page-heading"><div><p class="kicker">${icon('activity', 16)} ${mode === 'demo' ? 'Demo' : 'Mezo Testnet'}</p><h1>Activity</h1><p>Track funding, signed reviews, and payments.</p></div>${button('Back to milestone', 'milestone', '', 'outline', busy)}</div>${activityPanel(context)}`;
  } else if (view === 'setup' || !milestone) {
    page = setupPanel(context);
  } else {
    page = `${hero(milestone, stats, context)}<div class="content-grid">${workItems(milestone, context)}${workflow(milestone, stats, context)}</div>${activityPanel(context, true)}`;
  }
  return `<div class="app-shell">${navigation(view, mode)}<div class="workspace">${header(context)}<main id="main" class="main">${busy ? '<div class="working" role="status"><i></i>Working with your wallet or Mezo Testnet…</div>' : ''}${page}<footer>${icon('info', 15)} ${mode === 'demo' ? 'Demo funds and events are simulated.' : 'Mezo Testnet · Test tokens have no monetary value.'}</footer></main></div></div>`;
}
