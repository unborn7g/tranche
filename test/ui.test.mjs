import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEther, parseUnits } from 'viem';
import { renderApp, totals } from '../src/ui.js';

const owner = '0x1111111111111111111111111111111111111111';
const reviewer = '0x2222222222222222222222222222222222222222';
const supplier = '0x3333333333333333333333333333333333333333';
const installer = '0x4444444444444444444444444444444444444444';
const other = '0x5555555555555555555555555555555555555555';
const escrow = '0x6666666666666666666666666666666666666666';
const hash = '0x' + 'a7'.repeat(32);
const pending = 0;
const approved = 1;
const disputed = 2;
const paid = 3;
const refunded = 4;

const stages = [
  { name: 'unfunded', funded: false, statuses: [pending, pending, pending], owner: 'fund', reviewer: null,
    demo: 'fund', supplierItems: [0], installerItems: [1, 2] },
  { name: 'funded with pending work', funded: true, statuses: [pending, pending, pending], owner: null, reviewer: 'review',
    demo: 'review', supplierItems: [0], installerItems: [1, 2] },
  { name: 'ready for a partial release', funded: true, statuses: [approved, approved, disputed], owner: 'settle', reviewer: 'review',
    demo: 'settle', supplierItems: [0], installerItems: [1, 2] },
  { name: 'waiting on a dispute', funded: true, statuses: [disputed, pending, pending], owner: null, reviewer: 'review',
    demo: 'review', supplierItems: [0], installerItems: [1, 2] },
  { name: 'partially paid', funded: true, statuses: [paid, paid, disputed], owner: null, reviewer: 'review',
    demo: 'review', supplierItems: [], installerItems: [2] },
  { name: 'fully paid', funded: true, statuses: [paid, paid, paid], owner: null, reviewer: null,
    demo: 'activity', supplierItems: [], installerItems: [] },
  { name: 'closed with a refund', funded: true, statuses: [paid, paid, refunded], owner: null, reviewer: null,
    demo: 'activity', supplierItems: [], installerItems: [] },
];

function milestoneAt(stage) {
  const lines = ['Electrical materials', 'First-fix installation', 'Final testing'].map((label, index) => ({
    label,
    recipient: index === 0 ? supplier : installer,
    budget: parseEther(index === 0 ? '600' : '300'),
    status: stage.statuses[index],
    minMusdc: 0n,
    amountPaid: 0n,
  }));
  const held = stage.funded ? lines.filter(line => line.status < paid).reduce((carry, line) => carry + line.budget, 0n) : 0n;
  return { id: 7n, title: 'Electrical installation', owner, reviewer, budget: parseEther('1200'), held, funded: stage.funded, lines };
}

function render(overrides = {}) {
  return renderApp({
    mode: 'testnet',
    view: 'milestone',
    milestone: milestoneAt(stages[0]),
    session: null,
    busy: false,
    contractAddress: escrow,
    events: [],
    payoutDecimals: 6,
    ...overrides,
  });
}

function buttons(html, action) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0])
    .filter(element => element.includes('data-action="' + action + '"'));
}

function workflowAction(html) {
  const segment = html.match(/<div class="workflow-action">([\s\S]*?)<\/div>/);
  assert.ok(segment, 'Milestone has a payment workflow');
  return segment[1].match(/data-action="([^"]+)"/)?.[1] ?? null;
}

function payoutIndices(html) {
  return buttons(html, 'payout').map(tag => Number(tag.match(/data-index="(\d+)"/)?.[1]));
}

const roles = [
  ['owner', owner],
  ['reviewer', reviewer],
  ['supplier', supplier],
  ['installer', installer],
  ['unrelated wallet', other],
  ['without a wallet', null],
];

for (const stage of stages) {
  for (const [role, account] of roles) {
    test('Testnet ' + stage.name + ' as ' + role, () => {
      const markup = render({ milestone: milestoneAt(stage), session: account ? { account } : null });
      const expectedAction = !account ? 'wallet' : stage[role] ?? null;
      const expectedPreferences = role === 'supplier' ? stage.supplierItems : role === 'installer' ? stage.installerItems : [];
      assert.equal(workflowAction(markup), expectedAction);
      assert.deepEqual(payoutIndices(markup), expectedPreferences);
    });
  }

  test('Demo ' + stage.name + ' shows the correct next action and one sample payee', () => {
    const markup = render({ mode: 'demo', milestone: milestoneAt(stage) });
    assert.equal(workflowAction(markup), stage.demo);
    assert.deepEqual(payoutIndices(markup), stage.installerItems.includes(1) ? [1] : []);
  });
}

for (const connected of [false, true]) {
  for (const configured of [false, true]) {
    for (const busy of [false, true]) {
      const label = [
        connected ? 'with a wallet' : 'without a wallet',
        configured ? 'with an escrow' : 'without an escrow',
        busy ? 'during a request' : 'while idle',
      ].join(', ');
      test('Testnet setup ' + label, () => {
        const markup = render({
          view: 'setup', milestone: null,
          session: connected ? { account: owner } : null,
          contractAddress: configured ? escrow : null,
          busy,
        });
        const enabled = {
          deploy: connected && !busy,
          borrow: connected && !busy,
          attach: !busy,
          create: connected && configured && !busy,
          load: configured && !busy,
        };
        for (const [action, expected] of Object.entries(enabled)) {
          const controls = buttons(markup, action);
          assert.equal(controls.length, 1, action);
          assert.equal(!/\bdisabled\b/.test(controls[0]), expected, action);
        }
        assert.equal(markup.includes('Working with your wallet'), busy);
      });
    }
  }
}

test('marks the current workspace page for assistive technology', () => {
  for (const view of ['milestone', 'activity', 'setup']) {
    const currentPage = buttons(render({ view }), view).filter(tag => tag.includes('aria-current="page"'));
    assert.equal(currentPage.length, 1, view);
  }
});

test('keeps the funding, released, and held amounts visible after partial payout', () => {
  const markup = render({ milestone: milestoneAt(stages[4]) });
  assert.match(markup, /Funded<\/span><strong>1,200 <small>MUSD/);
  assert.match(markup, /Released<\/span><strong>900 <small>MUSD/);
  assert.match(markup, /Held in escrow<\/span><strong>300 <small>MUSD/);
  assert.match(markup, /aria-label="75% of budget paid"/);
});

test('refunded funds close the milestone without inflating the paid percentage', () => {
  const markup = render({ milestone: milestoneAt(stages[6]) });
  assert.match(markup, /hero-status"><i><\/i>Complete/);
  assert.match(markup, /aria-label="75% of budget paid"/);
  assert.match(markup, /300 MUSD refunded/);
  assert.match(markup, /Held in escrow<\/span><strong>0 <small>MUSD/);
});

test('approved, disputed, paid, and refunded totals preserve BigInt precision', () => {
  const large = 2n ** 70n;
  const result = totals({
    lines: [
      { status: approved, budget: large },
      { status: approved, budget: 1n },
      { status: disputed, budget: 3n },
      { status: paid, budget: 4n },
      { status: refunded, budget: 5n },
      { status: pending, budget: 6n },
    ],
  });
  assert.deepEqual(result, { approved: large + 1n, disputed: 3n, paid: 4n, refunded: 5n });
});

test('shows a recipient’s settled mUSDC amount and the original MUSD budget', () => {
  const milestone = milestoneAt(stages[4]);
  milestone.lines[1].minMusdc = parseUnits('300', 6);
  milestone.lines[1].amountPaid = parseUnits('300.49', 6);
  const markup = render({ milestone });
  assert.match(markup, /table-payout">300\.49 mUSDC/);
  assert.match(markup, /Released<\/span><strong>900 <small>MUSD/);
});

test('keeps Testnet payouts unavailable during a request', () => {
  const milestone = milestoneAt(stages[2]);
  const ownerScreen = render({ milestone, session: { account: owner }, busy: true });
  const payeeScreen = render({ milestone, session: { account: installer }, busy: true });
  assert.match(buttons(ownerScreen, 'settle')[0], /\bdisabled\b/);
  assert.equal(buttons(payeeScreen, 'payout').length, 2);
  assert.ok(buttons(payeeScreen, 'payout').every(tag => /\bdisabled\b/.test(tag)));
});

test('escapes on-chain titles and item labels before rendering the milestone', () => {
  const milestone = milestoneAt(stages[1]);
  milestone.title = '<script>alert("title")</script>';
  milestone.lines[0].label = '<img src=x onerror="bad()">';
  const markup = render({ milestone, session: { account: supplier } });
  assert.ok(markup.includes('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;'));
  assert.ok(markup.includes('&lt;img src=x onerror=&quot;bad()&quot;&gt;'));
  assert.doesNotMatch(markup, /<script>|<img src=x/);
});

test('activity renders escaped text and a verified Mezo Explorer link', () => {
  const events = [{ title: 'Paid <item>', detail: 'Owner & reviewer', glyph: 'check', hash }];
  const markup = render({ view: 'activity', events });
  assert.ok(markup.includes('Paid &lt;item&gt;'));
  assert.ok(markup.includes('Owner &amp; reviewer'));
  assert.ok(markup.includes('https://explorer.test.mezo.org/tx/' + hash));
  assert.match(markup, /target="_blank" rel="noreferrer"/);
});

test('the milestone shows three recent records while Activity keeps the full history', () => {
  const events = ['Funded escrow', 'Reviewed items', 'Paid recipient', 'Older saved event'].map(title => ({ title }));
  assert.doesNotMatch(render({ events }), /Older saved event/);
  assert.match(render({ view: 'activity', events }), /Older saved event/);
});

test('an unconnected visitor can open a configured public milestone by ID', () => {
  const [load] = buttons(render({ view: 'setup', milestone: null }), 'load');
  assert.ok(load);
  assert.doesNotMatch(load, /\bdisabled\b/);
});
