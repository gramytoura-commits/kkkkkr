const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTelegramManager } = require('./telegram-manager');

// Use an isolated ledger and intercept every Telegram call; tests never contact the bot.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-manager-test-'));
process.env.DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_CHAT_IDS = '42';
process.env.API_SECRET = 'test-secret';
process.env.APK_PATH = path.join(dataDir, 'test.apk');
fs.writeFileSync(process.env.APK_PATH, 'not a real apk');
const ledger = require('./server');
const sent = [];
let sequence = 0;
const telegram = async (method, payload) => {
  sent.push({ method, ...payload });
  for (const row of payload.reply_markup?.inline_keyboard || []) {
    for (const button of row) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  if (payload.text) assert.ok(payload.text.length <= 4096);
  return { ok: true, result: { message_id: ++sequence } };
};
const transactions = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8')).transactions;
const manager = createTelegramManager({
  telegram, adminChatIds: new Set(['42']), getTransactions: transactions,
  accountBalance: ledger.accountBalance, createTransaction: ledger.createTransaction,
  editTransaction: ledger.editTransaction, removeTransaction: ledger.removeTransaction,
  parseTransferInput: (args) => {
    const direction = args[0] === '-' ? 'minus' : 'plus';
    const tokens = args.join(' ').match(/"[^"]*"|\S+/g);
    if (['+', '-'].includes(tokens[0])) tokens.shift();
    return { direction, amount: tokens.shift(), recipient: (tokens.shift() || '').replace(/^"|"$/g, ''), note: tokens.join(' ') };
  },
  escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  recordEvent: () => {}
});
const message = (text, from = 42, chat = 42) => manager.handleUpdate({ message: { text, from: { id: from }, chat: { id: chat } } });
const callback = (data, from = 42, chat = 42) => manager.handleUpdate({ callback_query: { id: `callback-${++sequence}`, from: { id: from }, message: { message_id: 1, chat: { id: chat } }, data } });
const lastMessage = () => sent.filter((item) => item.method === 'sendMessage').at(-1);
const action = (label) => {
  const button = lastMessage().reply_markup.inline_keyboard.flat().find((item) => item.text === label);
  assert.ok(button, `Missing button: ${label}`);
  return button.callback_data;
};
const create = (input = {}) => ledger.createTransaction({ amount: 10, recipient: 'Example', direction: 'plus', ...input }, 'test', { notify: false });

test('start opens actual transaction controls without numeric worker IDs', async () => {
  create();
  await message('/start@ExampleBot');
  assert.match(lastMessage().text, /Transaction manager/);
  assert.ok(action('Transactions / edit / delete'));
  assert.doesNotMatch(lastMessage().text, /Worker 42/);
});

test('guided creation supports quoted text, custom time, icon and status; repeated Save is harmless', async () => {
  await message('/add');
  const oldDirection = action('+ Money in');
  await callback(oldDirection);
  await message('12,50');
  await callback(oldDirection);
  assert.match(lastMessage().text, /step is already complete/);
  await message('A <test> recipient');
  await message('A <note> & text');
  await callback(action('🎁'));
  await message('2026-11-10 14:30');
  await callback(action('confirmed'));
  const save = action('Save transaction');
  const count = transactions().length;
  await callback(save);
  const tx = transactions().find((item) => item.recipient === 'A <test> recipient');
  assert.equal(tx.amount, 12.5);
  assert.equal(tx.createdAt, '2026-11-10T13:30:00.000Z');
  assert.equal(tx.icon, '🎁');
  assert.equal(tx.status, 'confirmed');
  assert.match(lastMessage().text, /A &lt;test&gt; recipient/);
  assert.match(lastMessage().text, /A &lt;note&gt; &amp; text/);
  await callback(save);
  assert.equal(transactions().length, count + 1);
});

test('guided creation can use current time and skip notes', async () => {
  await message('/add');
  await callback(action('− Money out'));
  await message('3');
  await message('No note');
  await callback(action('No note'));
  await callback(action('↘'));
  await callback(action('Use current date & time'));
  await callback(action('pending'));
  await callback(action('Save transaction'));
  const tx = transactions().find((item) => item.recipient === 'No note');
  assert.equal(tx.note, '');
  assert.equal(tx.direction, 'minus');
  assert.equal(tx.status, 'pending');
});

test('edits persist all mutable fields and recompute the balance', async () => {
  const tx = create();
  const before = ledger.accountBalance();
  await callback(`tm:edit:${tx.id}:amount`);
  await message('15.25');
  await message(`/edit ${tx.id} recipient Name with spaces`);
  await message(`/edit ${tx.id} note Something new`);
  await message(`/edit ${tx.id} note -`);
  await message(`/edit ${tx.id} icon 🏦`);
  await message(`/edit ${tx.id} direction minus`);
  await message(`/edit ${tx.id} date 2026-11-09 18:45`);
  await message(`/edit ${tx.id} status confirmed`);
  const edited = transactions().find((item) => item.id === tx.id);
  assert.equal(edited.amount, 15.25);
  assert.equal(edited.recipient, 'Name with spaces');
  assert.equal(edited.note, '');
  assert.equal(edited.icon, '🏦');
  assert.equal(edited.direction, 'minus');
  assert.equal(edited.createdAt, '2026-11-09T17:45:00.000Z');
  assert.equal(ledger.accountBalance(), before - 15.25);
  await message(`/edit ${tx.id} status rejected`);
  assert.equal(ledger.accountBalance(), before);
  await message(`/edit ${tx.id} status pending`);
  assert.equal(transactions().find((item) => item.id === tx.id).confirmedAt, null);
  const events = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8')).events;
  assert.ok(events.some((event) => event.type === 'transaction.edited' && event.before.recipient === 'Example'));
});

test('pending approval buttons work and stale approvals cannot reject an already confirmed entry', async () => {
  const tx = create();
  await callback(`confirm:${tx.id}`);
  assert.equal(tx.status, 'confirmed');
  await callback(`reject:${tx.id}`);
  assert.equal(tx.status, 'confirmed');
  assert.match(lastMessage().text, /already handled/);
});

test('delete requires confirmation, supports cancel, updates balance, and cannot be replayed', async () => {
  const tx = create();
  ledger.editTransaction(tx.id, { status: 'confirmed' });
  const before = ledger.accountBalance();
  await message(`/remove ${tx.id}`);
  assert.ok(transactions().some((item) => item.id === tx.id));
  await callback(action('Cancel'));
  assert.ok(transactions().some((item) => item.id === tx.id));
  await callback(`tm:delete:${tx.id}`);
  const save = action('Yes, delete');
  await callback(save);
  assert.ok(!transactions().some((item) => item.id === tx.id));
  assert.equal(ledger.accountBalance(), before - 10);
  await callback(save);
  assert.equal(ledger.accountBalance(), before - 10);
});

test('lists and searches paginate beyond the old twenty-transaction limit', async () => {
  for (let index = 0; index < 25; index++) create({ recipient: `Paginated ${index}` });
  await message('/transactions');
  let pages = 1;
  let seen = [];
  while (true) {
    const buttons = lastMessage().reply_markup.inline_keyboard.flat();
    seen.push(...buttons.filter((item) => item.callback_data.startsWith('tm:view:')).map((item) => item.callback_data));
    const next = buttons.find((item) => item.text === 'Next ›');
    if (!next) break;
    await callback(next.callback_data);
    pages++;
  }
  assert.ok(pages > 3);
  assert.equal(new Set(seen).size, transactions().length);
  await message('/search Paginated');
  const next = action('Next ›');
  await callback(next);
  assert.match(lastMessage().text, /25 transactions · Page 2\/5/);
});

test('guided set balance records an adjustment once', async () => {
  await message('/setbalance');
  await message('100.20');
  const save = action('Save balance');
  await callback(save);
  assert.equal(ledger.accountBalance(), 100.2);
  const count = transactions().length;
  await callback(save);
  assert.equal(transactions().length, count);
  await message('/setbalance 0');
  assert.equal(ledger.accountBalance(), 0);
});

test('invalid money/date/status inputs cannot mutate an entry; user can retry', async () => {
  const tx = create();
  for (const invalid of ['0', '-1', '0.001', '1e3', '1000001', 'text']) {
    await message(`/edit ${tx.id} amount ${invalid}`);
    assert.equal(tx.amount, 10);
  }
  await message(`/edit ${tx.id} status imaginary`);
  assert.equal(tx.status, 'pending');
  for (const date of ['2026-02-30 12:00', '2026-03-29 02:30', '2026-10-25 02:30']) {
    const before = tx.createdAt;
    await message(`/edit ${tx.id} date ${date}`);
    assert.equal(tx.createdAt, before);
  }
  await message(`/edit ${tx.id} date 2026-10-25T02:30+02:00`);
  assert.equal(tx.createdAt, '2026-10-25T00:30:00.000Z');
  await callback(`tm:edit:${tx.id}:amount`);
  await message('bad');
  await message('9.99');
  assert.equal(tx.amount, 9.99);
  assert.throws(() => ledger.updateTransaction(tx.id, 'arbitrary'), /status/);
});

test('unauthorized chats cannot view or change transactions', async () => {
  const tx = create();
  const before = sent.length;
  await message('/transactions', 999, 999);
  assert.equal(sent.length, before);
  await callback(`tm:status:${tx.id}:confirmed`, 999, 999);
  assert.equal(tx.status, 'pending');
  assert.equal(sent.at(-1).show_alert, true);
});

test('users in a shared chat have separate drafts and cannot save each other’s work', async () => {
  await message('/add', 101);
  const direction = action('+ Money in');
  await message('/add', 102);
  await callback(direction, 102);
  assert.match(lastMessage().text, /expired/);
  await callback(direction, 101);
  await message('3', 101);
  await message('Shared draft', 101);
  await message('/cancel', 101);
});

test('seeded examples deleted from the ledger stay deleted on restart', () => {
  ledger.seedFrontendExamples();
  const tx = transactions()[0];
  ledger.removeTransaction(tx.id);
  const count = transactions().length;
  ledger.seedFrontendExamples();
  assert.equal(transactions().length, count);
  assert.ok(!transactions().some((item) => item.id === tx.id));
});

test('account API reflects Telegram edits and deletion without rejected placeholders', async () => {
  const tx = create({ recipient: 'API sync' });
  ledger.editTransaction(tx.id, { amount: 22.5, status: 'confirmed', createdAt: '2026-11-10T09:00:00Z' });
  await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${ledger.server.address().port}`;
  try {
    const get = async () => (await fetch(`${url}/account`, { headers: { authorization: 'Bearer test-secret' } })).json();
    const account = await get();
    assert.equal(account.transactions.find((item) => item.id === tx.id).amount, 22.5);
    assert.equal(account.balance, ledger.accountBalance());
    assert.equal(account.timeZone, 'Europe/Prague');
    ledger.editTransaction(tx.id, { status: 'rejected' });
    assert.ok(!(await get()).transactions.some((item) => item.id === tx.id));
    ledger.removeTransaction(tx.id);
    assert.ok(!(await get()).transactions.some((item) => item.id === tx.id));
    const response = await fetch(`${url}/transactions/missing`, { method: 'POST', headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bad' }) });
    assert.equal(response.status, 400);
  } finally { await new Promise((resolve) => ledger.server.close(resolve)); }
});

test('web admin API requires a key, validates before mutation, and saves edits and balance adjustments', async () => {
  await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${ledger.server.address().port}`;
  const call = (route, method = 'GET', value, key = 'test-secret') => fetch(base + route, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    const page = await call('/admin/', 'GET', undefined, '');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Demo Ledger/);
    assert.equal((await call('/admin-api/transactions', 'POST', { amount: 10, recipient: 'Blocked' }, '')).status, 401);
    const before = transactions().length;
    assert.equal((await call('/admin-api/transactions', 'POST', { amount: 10, recipient: 'Invalid', status: 'invalid' })).status, 400);
    assert.equal(transactions().length, before);
    const response = await call('/admin-api/transactions', 'POST', { amount: 15.5, recipient: 'Web <admin>', note: 'A note', status: 'confirmed', direction: 'plus', icon: '🎁', createdAt: '2026-11-10T10:30:00Z' });
    assert.equal(response.status, 201);
    const tx = (await response.json()).transaction;
    assert.equal(tx.status, 'confirmed');
    const route = `/admin-api/transactions/${tx.id}`;
    assert.equal((await call(route, 'PATCH', { amount: 40, note: '', recipient: 'Renamed', createdAt: '2026-11-09T12:15:00Z', direction: 'minus' })).status, 200);
    const edited = transactions().find((item) => item.id === tx.id);
    assert.equal(edited.note, '');
    assert.equal(edited.amount, 40);
    assert.equal(edited.createdAt, '2026-11-09T12:15:00.000Z');
    assert.equal((await call(route, 'PATCH', { amount: 0.001 })).status, 400);
    assert.equal((await call(route, 'PATCH', { actor: 'forged', amount: 20 })).status, 400);
    assert.equal(transactions().find((item) => item.id === tx.id).amount, 40);
    assert.equal((await call('/admin-api/balance', 'POST', { balance: 123.45 })).status, 200);
    assert.equal(ledger.accountBalance(), 123.45);
    assert.equal((await call('/admin-api/balance', 'POST', { balance: -1 })).status, 400);
    assert.equal(ledger.accountBalance(), 123.45);
    const preflight = await call('/admin-api/transactions', 'OPTIONS');
    assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
    assert.equal((await call(`/transactions/${tx.id}`, 'DELETE')).status, 200);
  } finally { await new Promise((resolve) => ledger.server.close(resolve)); }
});

test('connected app profiles hold only a test label, are marked demo and expose their own balance and selection', async () => {
  const appId = 'app_profile_test_123456';
  const appCall = (body, key = 'test-secret') => fetch(`http://127.0.0.1:${ledger.server.address().port}/admin-api/apps/${appId}`, { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  try {
    await fetch(`http://127.0.0.1:${ledger.server.address().port}/account`, { headers: { authorization: 'Bearer test-secret', 'x-demo-app-id': appId } });
    const transaction = ledger.createTransaction({ amount: 8, recipient: 'Profile selection', direction: 'plus' }, 'test', { notify: false });
    ledger.editTransaction(transaction.id, { status: 'confirmed' });
    assert.equal((await appCall({ label: 'Test device', iban: 'DE89370400440532013000', transactionIds: [transaction.id] })).status, 400);
    assert.equal((await appCall({ label: 'Test device', email: 'owner@example.com', transactionIds: [transaction.id] })).status, 400);
    const saved = await appCall({ label: 'Test device', transactionIds: [transaction.id] });
    assert.equal(saved.status, 200);
    const stored = (await saved.json()).app;
    for (const field of ['fullName', 'email', 'phone', 'beneficiaryName', 'iban']) assert.equal(stored[field], undefined);
    const account = await (await fetch(`http://127.0.0.1:${ledger.server.address().port}/account`, { headers: { authorization: 'Bearer test-secret', 'x-demo-app-id': appId } })).json();
    assert.equal(account.demo, true);
    assert.match(account.notice, /DEMO – not real money/);
    assert.equal(account.worker.iban, 'DEMO-NOT-A-REAL-ACCOUNT');
    assert.match(account.worker.fullName, /^DEMO · Test device$/);
    assert.equal(account.balance, 8);
    assert.equal(account.transactions[0].id, transaction.id);
    const pending = ledger.createTransaction({ amount: 3, recipient: 'Pending from app' }, 'frontend', { notify: false });
    await appCall({ label: 'Test device', transactionIds: [transaction.id, pending.id] });
    const again = await (await fetch(`http://127.0.0.1:${ledger.server.address().port}/account`, { headers: { authorization: 'Bearer test-secret', 'x-demo-app-id': appId } })).json();
    assert.equal(again.transactions.find((tx) => tx.id === pending.id).status, 'pending');
    assert.ok(!again.transactions.some((tx) => tx.status === 'sent'));
  } finally { await new Promise((resolve) => ledger.server.close(resolve)); }
});

test('dashboard can create a profile by copying another profile and serve its APK', async () => {
  await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${ledger.server.address().port}`;
    const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
    const first = await (await fetch(`${base}/admin-api/apps`, { method: 'POST', headers, body: JSON.stringify({ label: 'First test profile', transactionIds: [] }) })).json();
    assert.ok(first.app.id);
    const copied = await (await fetch(`${base}/admin-api/apps`, { method: 'POST', headers, body: JSON.stringify({ label: 'Second test profile', copyFromAppId: first.app.id }) })).json();
    assert.equal(copied.app.transactionIds.length, 0);
    const apk = await fetch(`${base}${copied.apkUrl}`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(apk.status, 200);
    assert.match(apk.headers.get('content-type'), /android/);
  } finally { await new Promise((resolve) => ledger.server.close(resolve)); }
});

test('app open/resume events are accepted but not stored or sent to Telegram', async () => {
  await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  try {
    const eventsBefore = ledger.server && (await (await fetch(`http://127.0.0.1:${ledger.server.address().port}/logs`, { headers: { authorization: 'Bearer test-secret' } })).json()).events.length;
    const messagesBefore = sent.length;
    const response = await fetch(`http://127.0.0.1:${ledger.server.address().port}/app-events`, { method: 'POST', headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ event: 'app.resumed', inactiveSeconds: 120 }) });
    assert.equal(response.status, 202);
    const eventsAfter = (await (await fetch(`http://127.0.0.1:${ledger.server.address().port}/logs`, { headers: { authorization: 'Bearer test-secret' } })).json()).events.length;
    assert.equal(eventsAfter, eventsBefore);
    assert.equal(sent.length, messagesBefore);
  } finally { await new Promise((resolve) => ledger.server.close(resolve)); }
});

after(() => {
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('telegram-manager-test-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
