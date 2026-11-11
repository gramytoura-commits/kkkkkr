const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated ledger; Telegram polling is off and the server never contacts the bot.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klarna-integration-test-'));
process.env.DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_CHAT_IDS = '42';
process.env.API_SECRET = 'test-secret';
process.env.DISABLE_TELEGRAM = 'true';
process.env.APK_PATH = path.join(dataDir, 'test.apk');
fs.writeFileSync(process.env.APK_PATH, 'not a real apk');
const ledger = require('./server');

let base;
async function listen() {
  if (!ledger.server.listening) await new Promise((resolve) => ledger.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${ledger.server.address().port}`;
}
const admin = (route, method = 'GET', value) => fetch(base + route, {
  method, headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) })
});
const postTransfer = (token, payload, extraHeaders = {}) => fetch(`${base}/api/integrations/klarna/transfers`, {
  method: 'POST',
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(payload)
});

const booked = (overrides = {}) => ({
  schema_version: 1, event_id: 'evt-1', event_type: 'klarna.incoming_transfer.booked',
  amount: '125.50', currency: 'EUR', booking_date: '2026-11-11',
  sender_name: 'Example Sender', payment_reference: 'Invoice 123', sender_iban_masked: 'DE••••1234',
  ...overrides
});

async function setup() {
  await listen();
  const group = await (await admin('/admin-api/groups', 'POST', { name: 'Klarna group' })).json();
  const integration = await (await admin('/admin-api/integrations', 'POST', { name: 'Companion', groupIds: [group.group.id] })).json();
  return { groupId: group.group.id, token: integration.integration.token, integrationId: integration.integration.id };
}

test('successful import returns 201 and creates a confirmed transfer in the target group', async () => {
  const { token, groupId, integrationId } = await setup();
  const res = await postTransfer(token, booked({ event_id: 'ok-1' }), { 'idempotency-key': 'ok-1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.transaction.amount, 125.5);
  assert.equal(body.transaction.status, 'confirmed');
  assert.equal(body.transaction.direction, 'plus');
  assert.equal(body.transaction.recipient, 'Example Sender');
  const groups = await (await admin('/admin-api/groups')).json();
  const group = groups.groups.find((g) => g.id === groupId);
  assert.ok(group.transactionIds.includes(body.transaction.id), 'transfer is attached to the target group');
  const transfers = await (await admin(`/admin-api/integrations/${integrationId}/transfers`)).json();
  assert.equal(transfers.transfers.length, 1);
});

test('duplicate delivery with identical data returns 200 and does not double-create', async () => {
  const { token, integrationId } = await setup();
  const first = await postTransfer(token, booked({ event_id: 'dup-1' }));
  assert.equal(first.status, 201);
  const second = await postTransfer(token, booked({ event_id: 'dup-1' }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  const transfers = await (await admin(`/admin-api/integrations/${integrationId}/transfers`)).json();
  assert.equal(transfers.transfers.length, 1, 'only one transfer stored after a retry');
});

test('conflicting data for the same event_id returns 409 without overwriting', async () => {
  const { token } = await setup();
  const first = await postTransfer(token, booked({ event_id: 'conf-1', amount: '10.00' }));
  assert.equal(first.status, 201);
  const firstId = (await first.json()).transaction.id;
  const conflict = await postTransfer(token, booked({ event_id: 'conf-1', amount: '999.00' }));
  assert.equal(conflict.status, 409);
  // original is untouched: a matching retry still resolves to the original transaction
  const retry = await postTransfer(token, booked({ event_id: 'conf-1', amount: '10.00' }));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).transaction.id, firstId);
});

test('missing optional fields still imports (201)', async () => {
  const { token } = await setup();
  const res = await postTransfer(token, {
    schema_version: 1, event_id: 'min-1', event_type: 'klarna.incoming_transfer.booked',
    amount: '50.00', currency: 'EUR', booking_date: '2026-11-11'
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.transaction.amount, 50);
  assert.equal(body.transaction.recipient, 'Klarna transfer');
});

test('unauthorized request (missing or invalid token) returns 401', async () => {
  await setup();
  assert.equal((await postTransfer('', booked({ event_id: 'na-1' }))).status, 401);
  assert.equal((await postTransfer('klarna_live_not_a_real_token', booked({ event_id: 'na-2' }))).status, 401);
});

test('non-booked event is acknowledged and ignored (202), no transaction created', async () => {
  const { token, integrationId } = await setup();
  const res = await postTransfer(token, booked({ event_id: 'notif-1', event_type: 'klarna.incoming_transfer.notification' }));
  assert.equal(res.status, 202);
  assert.equal((await res.json()).ignored, true);
  const transfers = await (await admin(`/admin-api/integrations/${integrationId}/transfers`)).json();
  assert.equal(transfers.transfers.length, 0);
});

test('a revoked integration token is rejected (401)', async () => {
  const { token, integrationId } = await setup();
  await admin(`/admin-api/integrations/${integrationId}`, 'PUT', { revoked: true });
  assert.equal((await postTransfer(token, booked({ event_id: 'rev-1' }))).status, 401);
});

test('an imported transfer can be removed, detaching it from the group', async () => {
  const { token, groupId, integrationId } = await setup();
  const created = await (await postTransfer(token, booked({ event_id: 'rm-1' }))).json();
  const txId = created.transaction.id;
  const del = await admin(`/admin-api/integrations/${integrationId}/transfers/${txId}`, 'DELETE');
  assert.equal(del.status, 200);
  const groups = await (await admin('/admin-api/groups')).json();
  const group = groups.groups.find((g) => g.id === groupId);
  assert.ok(!group.transactionIds.includes(txId), 'removed transfer is detached from the group');
  const transfers = await (await admin(`/admin-api/integrations/${integrationId}/transfers`)).json();
  assert.equal(transfers.transfers.length, 0);
});

after(() => { try { ledger.server.close(); } catch {} });
