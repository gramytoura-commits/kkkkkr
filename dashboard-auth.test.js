const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createDashboardAuth, readLoginDevice } = require('./dashboard-auth');

const admin = { id: 42 };
const chat = { id: 42, type: 'private' };

function startUpdate(telegramUrl, from = admin, destination = chat) {
  return { message: { text: `/start ${new URL(telegramUrl).searchParams.get('start')}`, from, chat: destination } };
}

function buttonUpdate(data, from = admin, destination = chat) {
  return { callback_query: { id: 'test-callback', data, from, message: { message_id: 1, chat: destination } } };
}

test('Telegram approval grants a single browser-scoped dashboard session and logout revokes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-auth-test-'));
  process.env.DATA_DIR = directory;
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_ADMIN_CHAT_IDS = '42';
  process.env.API_SECRET = 'test-backend-key';
  process.env.DISABLE_TELEGRAM = 'false';
  process.env.ALLOW_LOCAL_ADMIN = 'false';

  const fetchHttp = global.fetch;
  const messages = [];
  const editedMessages = [];
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    const method = new URL(url).pathname.split('/').pop();
    if (method === 'sendMessage') messages.push(JSON.parse(options.body));
    if (method === 'editMessageText') editedMessages.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: method === 'getMe' ? { username: 'demo_ledger_test_bot' } : true });
  };

  const { server, handleTelegramUpdate } = require('./server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    global.fetch = fetchHttp;
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', authorization) => fetchHttp(base + path, {
    method, headers: authorization ? { authorization } : {}
  });

  assert.equal((await request('/account')).status, 401);
  const response = await fetchHttp(base + '/admin-auth/telegram', {
    method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  assert.equal(response.status, 201);
  const login = await response.json();
  const poll = () => request('/admin-auth/telegram/status', 'POST', `Login ${login.browserToken}`).then((result) => result.json());
  assert.deepEqual(await poll(), { status: 'pending' });
  assert.equal(messages.length, 0);
  await handleTelegramUpdate(startUpdate(login.telegramUrl, { id: 43 }, { id: 43, type: 'private' }));
  assert.equal(messages.length, 0);
  await handleTelegramUpdate(startUpdate(login.telegramUrl));
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes(login.code));
  assert.match(messages[0].text, /IP adresa: 127\.0\.0\.1\nSystém: Windows/);
  assert.deepEqual(messages[0].reply_markup.inline_keyboard[0].map(({ text }) => text), ['✅ Potvrdit', '❌ Zamítnout']);
  const approve = messages[0].reply_markup.inline_keyboard[0][0].callback_data;
  await handleTelegramUpdate(buttonUpdate(approve, { id: 43 }));
  await handleTelegramUpdate(buttonUpdate(approve, admin, { id: 42, type: 'group' }));
  assert.deepEqual(await poll(), { status: 'pending' });
  await handleTelegramUpdate(buttonUpdate(approve));
  assert.match(editedMessages[0].text, /Přihlášení potvrzeno.*\n\nIP adresa: 127\.0\.0\.1\nSystém: Windows/);
  assert.deepEqual(editedMessages[0].reply_markup.inline_keyboard, []);

  const requestId = login.browserToken.split('.')[0];
  const wrongBrowser = await request('/admin-auth/telegram/status', 'POST', `Login ${requestId}.other-browser`);
  assert.deepEqual(await wrongBrowser.json(), { status: 'expired' });
  const session = await poll();
  assert.equal(session.status, 'approved');
  assert.deepEqual(await poll(), { status: 'expired' });
  const authorization = `Dashboard ${session.token}`;
  assert.equal((await request('/admin-api/apps', 'GET', authorization)).status, 200);
  assert.equal((await request('/account', 'GET', authorization)).status, 200);
  assert.equal((await request('/app-events', 'POST', authorization)).status, 401);
  assert.equal((await request('/account', 'GET', 'Bearer test-backend-key')).status, 200);
  assert.equal((await request('/admin-auth/logout', 'POST', authorization)).status, 200);
  assert.equal((await request('/account', 'GET', authorization)).status, 401);
});

test('login details trust forwarded IPs only from the Coolify proxy and infer the browser platform', async () => {
  const resolveProxy = async () => [{ address: '172.18.0.2' }];
  const headers = {
    'x-forwarded-for': '203.0.113.111, 2001:db8::5',
    'user-agent': 'Mozilla/5.0 (Linux; Android 13)'
  };
  const req = (remoteAddress, requestHeaders = headers) => ({ socket: { remoteAddress }, headers: requestHeaders });

  assert.deepEqual(await readLoginDevice(req('::ffff:172.18.0.2'), resolveProxy), {
    ip: '2001:db8::5', system: 'Android'
  });
  assert.deepEqual(await readLoginDevice(req('::ffff:192.0.2.8'), resolveProxy), {
    ip: '192.0.2.8', system: 'Android'
  });
  assert.deepEqual(await readLoginDevice(req('192.0.2.8', { 'sec-ch-ua-platform': '"macOS"' }), resolveProxy), {
    ip: '192.0.2.8', system: 'macOS'
  });
  assert.deepEqual(await readLoginDevice(req(undefined, {}), resolveProxy), {
    ip: 'Neznámá', system: 'Neznámý'
  });
});

test('expired and declined requests cannot grant sessions', async () => {
  let time = 0;
  let buttons;
  const auth = createDashboardAuth({
    adminChatIds: new Set(['42']), enabled: true, now: () => time,
    telegram: async (method, options) => {
      if (method === 'sendMessage' && options.reply_markup) buttons = options.reply_markup.inline_keyboard[0];
      return { result: { username: 'demo_ledger_test_bot' } };
    }
  });
  const { body: expired } = await auth.start();
  await auth.handleUpdate(startUpdate(expired.telegramUrl));
  time += 5 * 60 * 1000;
  await auth.handleUpdate(buttonUpdate(buttons[0].callback_data));
  assert.deepEqual(auth.status(`Login ${expired.browserToken}`), { status: 'expired' });

  const { body: declined } = await auth.start();
  await auth.handleUpdate(startUpdate(declined.telegramUrl));
  await auth.handleUpdate(buttonUpdate(buttons[1].callback_data));
  await auth.handleUpdate(buttonUpdate(buttons[0].callback_data));
  assert.deepEqual(auth.status(`Login ${declined.browserToken}`), { status: 'denied' });
});
