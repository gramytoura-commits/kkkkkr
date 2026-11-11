const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createTelegramManager, COMMANDS } = require('./telegram-manager');
let createDashboardAuth, readLoginDevice;
try {
  ({ createDashboardAuth, readLoginDevice } = require('./dashboard-auth'));
} catch (e) {
  createDashboardAuth = () => ({ authorize: () => false, handleUpdate: async () => false, start: async () => ({ status: 401 }) });
  readLoginDevice = () => ({});
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const API_SECRET = process.env.API_SECRET || 'change-me-in-development';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const APK_PATH = path.resolve(process.env.APK_PATH || path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
const ADMIN_CHAT_IDS = new Set((process.env.TELEGRAM_ADMIN_CHAT_IDS || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const STORE_PATH = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const DEMO_MODE = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';
// Test data only: profiles never hold real names, contact details or bank accounts.
const DEMO_NOTICE = 'DEMO – not real money. Test data only.';
function demoWorker(label = 'Demo profile') {
  return Object.freeze({
    firstName: 'DEMO', lastName: label, fullName: `DEMO · ${label}`,
    email: 'demo@example.invalid', phone: '', beneficiaryName: 'DEMO', iban: 'DEMO-NOT-A-REAL-ACCOUNT'
  });
}
const WORKER = demoWorker();

fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { transactions: [], events: [], support: {} }; }
}

let store = loadStore();
store.transactions ||= [];
store.events ||= [];
store.support ||= {};
store.apps ||= {};
store.groups ||= {};
store.integrations ||= {};
store.klarnaEvents ||= {};
store.adminChatIds ||= [];
store.lastDeploymentCommit = store.lastDeploymentCommit || '';
store.adminChatIds.forEach((chatId) => ADMIN_CHAT_IDS.add(String(chatId)));
// Migrate old profiles: initialize profile data if missing
for (const app of Object.values(store.apps)) {
  app.label ||= app.configured ? `Test profile ${app.id.slice(-6)}` : '';
  if (!app.label) app.configured = false;
  // Initialize profile fields if not present
  if (!app.profile) {
    app.profile = {
      fullName: '',
      email: '',
      phone: '',
      beneficiaryName: '',
      iban: '',
      address: '',
      dateOfBirth: '',
      taxId: ''
    };
  }
}
function saveStore() { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function now() { return new Date().toISOString(); }
// Linked groups: a group owns the shared transaction selection, balance override and
// currency. Every app belongs to one group; apps in the same group share that data.
function newGroupId() { return `grp_${crypto.randomBytes(8).toString('hex')}`; }
function createGroup({ name = '', currency = 'EUR', balanceOverride = null, transactionIds = [] } = {}) {
  const groupId = newGroupId();
  store.groups[groupId] = {
    id: groupId,
    name: String(name || '').trim().slice(0, 80),
    currency: String(currency || 'EUR').trim().slice(0, 8) || 'EUR',
    balanceOverride: balanceOverride === null || balanceOverride === '' || balanceOverride === undefined ? null : Number(balanceOverride),
    transactionIds: [...new Set((transactionIds || []).filter((t) => store.transactions.some((tx) => tx.id === t)))],
    createdAt: now(), updatedAt: now()
  };
  return store.groups[groupId];
}
// Migrate apps to groups: each existing app that has no group gets its own solo group
// seeded from its current transactionIds, so prior per-app behavior is preserved.
let groupsMigrated = false;
for (const app of Object.values(store.apps)) {
  if (!app.groupId || !store.groups[app.groupId]) {
    const group = createGroup({ name: app.label || 'Account', transactionIds: app.transactionIds || [] });
    app.groupId = group.id;
    groupsMigrated = true;
  }
  if (!app.status) { app.status = 'active'; groupsMigrated = true; }
  if (app.bankName === undefined) app.bankName = '';
  if (app.bic === undefined) app.bic = '';
  if (app.accountHolder === undefined) app.accountHolder = '';
}
if (groupsMigrated) saveStore();
function groupOf(app) { return app && store.groups[app.groupId] ? store.groups[app.groupId] : null; }
function appTransactionIds(app) { const g = groupOf(app); return g ? g.transactionIds : (app?.transactionIds || []); }
function computedGroupBalance(group) {
  const ids = new Set(group.transactionIds);
  return Math.round(store.transactions
    .filter((tx) => ids.has(tx.id) && tx.status === 'confirmed')
    .reduce((sum, tx) => sum + (tx.direction === 'minus' ? -tx.amount : tx.amount), 0) * 100) / 100;
}
function groupBalance(group) { return group.balanceOverride !== null && group.balanceOverride !== undefined ? group.balanceOverride : computedGroupBalance(group); }
function appsInGroup(groupId) { return Object.values(store.apps).filter((a) => a.groupId === groupId); }
function groupView(group) {
  return { ...group, balance: groupBalance(group), computedBalance: computedGroupBalance(group), appCount: appsInGroup(group.id).length };
}
function appView(app) {
  const g = groupOf(app);
  return { ...app, transactionIds: appTransactionIds(app), balance: g ? groupBalance(g) : 0, currency: g ? g.currency : 'EUR', groupName: g ? g.name : '' };
}
// Integrations: a revocable token that lets an external sender (e.g. Klarna Companion)
// push booked transfers. Each integration targets one or more groups; an imported
// transfer becomes a confirmed transaction added to those groups.
function newIntegrationToken() { return `klarna_live_${crypto.randomBytes(24).toString('hex')}`; }
function integrationByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return Object.values(store.integrations).find((i) => !i.revoked && i.token === token) || null;
}
function validGroupIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((g) => store.groups[g]))];
}
function integrationView(i) {
  return {
    id: i.id, name: i.name, token: i.token, revoked: !!i.revoked,
    groupIds: i.groupIds || [], groupNames: (i.groupIds || []).map((g) => store.groups[g]?.name).filter(Boolean),
    createdAt: i.createdAt, lastUsedAt: i.lastUsedAt || null, importCount: i.importCount || 0
  };
}
function transferFingerprint(input) {
  const canonical = JSON.stringify({
    amount: String(input.amount ?? ''), currency: String(input.currency ?? '').toUpperCase(),
    booking_date: String(input.booking_date ?? ''), sender_name: String(input.sender_name ?? ''),
    payment_reference: String(input.payment_reference ?? ''), sender_iban_masked: String(input.sender_iban_masked ?? '')
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
// Imported transfers belonging to an integration, newest first (for the dashboard).
function integrationTransfers(integrationId) {
  return Object.entries(store.klarnaEvents)
    .filter(([, e]) => e.integrationId === integrationId)
    .map(([key, e]) => {
      const tx = store.transactions.find((t) => t.id === e.transactionId);
      return { eventKey: key, eventId: key.slice(integrationId.length + 1), transactionId: e.transactionId, createdAt: e.createdAt, transaction: tx ? publicTransaction(tx) : null };
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function recordEvent(type, payload = {}) {
  store.events.unshift({ id: id('evt'), type, createdAt: now(), ...payload });
  store.events = store.events.slice(0, 1000);
  saveStore();
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function authorized(req) {
  if (process.env.ALLOW_LOCAL_ADMIN === 'true' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return true;
  return req.headers.authorization === `Bearer ${API_SECRET}` || dashboardAuth.authorize(req);
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function publicTransaction(tx) {
  return { ...tx };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function formatTx(tx) {
  return `${tx.direction === 'minus' ? '−' : '+'} ${escapeHtml(tx.icon || '↔')} ${escapeHtml(tx.id)} · ${tx.amount.toFixed(2)} ${escapeHtml(tx.currency)} · ${escapeHtml(tx.recipient)} · ${escapeHtml(tx.status)}`;
}
function transactionHistory() {
  return store.transactions.filter((tx) => tx.status !== 'pending');
}
function formatTransactionList(items, emptyMessage = 'Žádné transakce.') {
  return items.length
    ? items.map((tx) => `<code>${formatTx(tx)}</code>`).join('\n')
    : emptyMessage;
}
function accountBalance() {
  const total = store.transactions
    .filter((tx) => tx.status === 'confirmed')
    .reduce((sum, tx) => sum + (tx.direction === 'minus' ? -tx.amount : tx.amount), 0);
  return Math.round(total * 100) / 100;
}
function parseTransferInput(args) {
  const parts = [...args];
  const direction = parts[0] === '+' || parts[0] === '-' ? (parts.shift() === '-' ? 'minus' : 'plus') : 'plus';
  const amount = parts.shift();
  const remainder = parts.join(' ').trim();
  if (!amount || !remainder) throw new Error('beneficiary name is required: /transfer + 25 "Beneficiary Name" note');
  const quoted = remainder.match(/^"([^"\n]{1,120})"(?:\s+(.+))?$/);
  const recipient = (quoted ? quoted[1] : remainder.split(/\s+/)[0]).trim();
  const note = (quoted ? quoted[2] || '' : remainder.split(/\s+/).slice(1).join(' ')).trim();
  if (!recipient) throw new Error('beneficiary name is required');
  return { amount, recipient, note, direction };
}
async function sendTelegramChunks(chatId, heading, items, emptyMessage) {
  const lines = items.map((tx) => `<code>${formatTx(tx)}</code>`);
  if (!lines.length) return telegramMessage(chatId, `${heading}\n\n${emptyMessage}`);
  let chunk = `${heading}\n\n`;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3800) {
      await telegramMessage(chatId, chunk);
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk) await telegramMessage(chatId, chunk);
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram request failed');
  return result;
}
async function telegramMessage(chatId, text) {
  if (BOT_TOKEN) await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}
async function notifyAdmins(text) {
  const txId = text.match(/tx_[a-f0-9]+/)?.[0];
  const replyMarkup = txId ? { inline_keyboard: [[
    { text: '✅ Potvrdit', callback_data: `confirm:${txId}` },
    { text: '❌ Zamítnout', callback_data: `reject:${txId}` }
  ]] } : undefined;
  await Promise.all([...ADMIN_CHAT_IDS].map((chatId) => BOT_TOKEN && telegram('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup
  }).catch(() => {})));
}

async function notifySupportAdmins(conversation) {
  await Promise.all([...ADMIN_CHAT_IDS].map((chatId) => BOT_TOKEN && telegram('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `<b>Nová support zpráva</b>\n<code>${escapeHtml(conversation.id)}</code>\n\n${escapeHtml(conversation.messages.at(-1).text)}\n\nOdpověď: /reply ${conversation.id} vaše zpráva`
  }).catch(() => {})));
}

async function notifyTelegram(text) {
  await Promise.all([...ADMIN_CHAT_IDS].map((chatId) => BOT_TOKEN && telegram('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown'
  }).catch(() => {})));
}

async function getRecentCommits(count = 5) {
  try {
    const output = execSync(`git log -${count} --format=%H|%s|%aI 2>/dev/null || echo ""`, { cwd: __dirname, encoding: 'utf8', shell: '/bin/bash' });
    if (!output.trim()) return [];
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, timestamp] = line.split('|');
      if (!hash || !message) return null;
      return { hash, message, timestamp };
    }).filter(Boolean);
  } catch { return []; }
}

async function checkAndNotifyDeployment() {
  if (!BOT_TOKEN || ADMIN_CHAT_IDS.size === 0) return;
  try {
    const commits = await getRecentCommits(5);
    if (!commits || !commits.length) return;
    const latestHash = commits[0]?.hash;
    if (latestHash && latestHash !== store.lastDeploymentCommit) {
      const time = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
      let msg = `🚀 *Backend* deployed\n\n⏰ ${time}\n\n*Latest commits:*`;
      commits.slice(0, 5).forEach((c, i) => {
        if (!c || !c.timestamp) return;
        const commitTime = new Date(c.timestamp).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
        const commitMsg = (c.message || '').split('\n')[0] || 'No message';
        msg += `\n${i + 1}. ${commitMsg}\n   _${commitTime}_`;
      });
      await notifyTelegram(msg);
      store.lastDeploymentCommit = latestHash;
      saveStore();
      recordEvent('deployment.auto-notified', { commits: commits.length });
    }
  } catch (error) {
    console.error('Deployment check error:', error.message);
  }
}

const BANK_FIELDS = ['iban', 'bankName', 'bic'];
function bankField(field, value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`invalid ${field}`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (field === 'iban' && !/^[A-Za-z0-9 ]{0,42}$/.test(text)) throw new Error('IBAN may contain only letters, digits and spaces (max 34 characters).');
  if (field === 'bic' && !/^[A-Za-z0-9]{0,11}$/.test(text)) throw new Error('BIC may contain only letters and digits (max 11 characters).');
  if (field === 'bankName' && Array.from(text).length > 120) throw new Error('Bank name must be 120 characters or fewer.');
  return field === 'bankName' ? text : text.toUpperCase();
}
function createTransaction(input, source = 'api', options = {}) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || Math.round(amount * 100) < 1 || amount > 1000000) throw new Error('amount must be between 0.01 and 1,000,000');
  const tx = {
    id: id('tx'), amount: Math.round(amount * 100) / 100,
    currency: String(input.currency || 'EUR').toUpperCase().slice(0, 3),
    direction: input.direction === 'minus' ? 'minus' : 'plus',
    icon: String(input.icon || (input.direction === 'minus' ? '↘' : '↗')).slice(0, 32),
    recipient: String(input.recipient || '').trim().slice(0, 120),
    note: String(input.note || '').trim().slice(0, 240),
    status: 'pending', source, createdAt: now(), confirmedAt: null
  };
  if (!tx.recipient) throw new Error('recipient is required');
  for (const field of BANK_FIELDS) {
    const value = bankField(field, input[field]);
    if (value) tx[field] = value;
  }
  store.transactions.unshift(tx); saveStore();
  recordEvent('transaction.created', { transactionId: tx.id, source, amount: tx.amount, currency: tx.currency });
  if (options.notify !== false) {
    const origin = source === 'frontend' ? ' z frontendu' : '';
    notifyAdmins(`<b>Nová demo transakce${origin}</b> čeká na potvrzení\n\n<code>${formatTx(tx)}</code>`);
  }
  return tx;
}
function updateTransaction(transactionId, status, actor = 'telegram') {
  if (!['confirmed', 'rejected'].includes(status)) throw new Error('status must be confirmed or rejected');
  const tx = store.transactions.find((item) => item.id === transactionId);
  if (!tx) throw new Error('transaction not found');
  if (tx.status !== 'pending') throw new Error(`transaction is already ${tx.status}`);
  tx.status = status; tx.confirmedAt = now();
  saveStore(); recordEvent(`transaction.${status}`, { transactionId, actor });
  return tx;
}
function editTransaction(transactionId, changes, actor = 'telegram') {
  const tx = store.transactions.find((item) => item.id === transactionId);
  if (!tx) throw new Error('transaction not found');
  const next = { ...tx };
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'amount') {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000000) throw new Error('amount must be between 0.01 and 1,000,000');
      next.amount = Math.round(amount * 100) / 100;
    } else if (field === 'direction') {
      if (!['plus', 'minus'].includes(value)) throw new Error('invalid direction');
      next.direction = value;
    } else if (field === 'status') {
      if (!['pending', 'confirmed', 'rejected'].includes(value)) throw new Error('invalid status');
      next.status = value;
      next.confirmedAt = value === 'pending' ? null : now();
    } else if (field === 'createdAt') {
      if (!Number.isFinite(Date.parse(value))) throw new Error('invalid date');
      next.createdAt = new Date(value).toISOString();
    } else if (['recipient', 'note', 'icon'].includes(field)) {
      const text = String(value).trim();
      const limit = { recipient: 120, note: 240, icon: 16 }[field];
      if ((field !== 'note' && !text) || Array.from(text).length > limit) throw new Error(`invalid ${field}`);
      next[field] = text;
    } else if (BANK_FIELDS.includes(field)) {
      const text = bankField(field, value);
      if (text) next[field] = text; else delete next[field];
    } else throw new Error(`unsupported transaction field: ${field}`);
  }
  const before = Object.fromEntries(Object.keys(changes).map((field) => [field, tx[field]]));
  for (const field of BANK_FIELDS) if (!(field in next)) delete tx[field];
  Object.assign(tx, next, { updatedAt: now() });
  store.transactions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  saveStore();
  recordEvent('transaction.edited', { transactionId, actor, before, changes, balance: accountBalance() });
  return tx;
}
function removeTransaction(transactionId, actor = 'telegram') {
  const index = store.transactions.findIndex((item) => item.id === transactionId);
  if (index < 0) throw new Error('transaction not found');
  const [tx] = store.transactions.splice(index, 1);
  saveStore();
  recordEvent('transaction.deleted', { transactionId, actor, amount: tx.amount, currency: tx.currency });
  return tx;
}
function createConfirmedTransaction(input, actor = 'telegram') {
  const tx = createTransaction(input, actor, { notify: false });
  tx.status = 'confirmed';
  tx.confirmedAt = now();
  saveStore();
  recordEvent('transaction.confirmed', { transactionId: tx.id, actor });
  return tx;
}
function seedFrontendExamples() {
  // Seed once: deleted or edited examples must not reappear on the next restart.
  if (store.frontendExamplesSeeded) return;
  if (store.transactions.length || store.events.some((event) => event.type.startsWith('transaction.'))) {
    store.frontendExamplesSeeded = true;
    saveStore();
    return;
  }
  const examples = [
    { amount: 1, recipient: 'Test Recipient A', direction: 'minus', icon: '↘', note: 'Demo example transaction' },
    { amount: 1, recipient: 'Test Recipient B', direction: 'plus', icon: '↗', note: 'Demo example transaction' },
    { amount: 0.02, recipient: 'Test Recipient C', direction: 'minus', icon: '↘', note: 'Demo example transaction' },
    { amount: 0.02, recipient: 'Test Recipient A', direction: 'plus', icon: '↗', note: 'Demo example transaction' }
  ];
  let changed = false;
  for (const example of examples) {
    const exists = store.transactions.some((tx) => tx.source === 'frontend-example' && tx.recipient === example.recipient && tx.amount === example.amount);
    if (exists) continue;
    const tx = createTransaction(example, 'frontend-example', { notify: false });
    tx.status = 'confirmed';
    tx.confirmedAt = now();
    changed = true;
  }
  store.frontendExamplesSeeded = true;
  if (changed) saveStore();
}
const transactionManager = createTelegramManager({
  telegram, adminChatIds: ADMIN_CHAT_IDS, getTransactions: () => store.transactions,
  accountBalance, createTransaction, editTransaction, removeTransaction,
  parseTransferInput, escapeHtml, recordEvent,
  timeZone: process.env.ACCOUNT_TIMEZONE || 'Europe/Prague'
});
const dashboardAuth = createDashboardAuth({
  telegram, adminChatIds: ADMIN_CHAT_IDS,
  enabled: Boolean(BOT_TOKEN) && process.env.DISABLE_TELEGRAM !== 'true'
});

async function handleTelegramUpdate(update) {
  if (await dashboardAuth.handleUpdate(update)) return;
  if (await transactionManager.handleUpdate(update)) return;
  const callback = update.callback_query;
  const message = update.message;
  const chatId = String(callback?.message?.chat?.id ?? message?.chat?.id ?? '');
  const [rawCommand, ...rest] = String(message?.text || '').trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@\w+$/, '');
  if (command === '/whoami') {
    await telegramMessage(chatId, `Chat ID: <code>${escapeHtml(chatId)}</code>`);
    return;
  }
  if (!ADMIN_CHAT_IDS.has(chatId)) return;
  try {
    if (callback?.data === 'list:logs') {
      await telegram('answerCallbackQuery', { callback_query_id: callback.id });
      await sendLogs(chatId);
    } else if (callback?.data === 'menu:addadmin') {
      await telegram('answerCallbackQuery', { callback_query_id: callback.id });
      await telegramMessage(chatId, 'Add an administrator: <code>/addadmin 123456789</code>');
    } else if (command === '/apk') {
      if (!fs.existsSync(APK_PATH)) throw new Error('APK file was not found on the server.');
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', 'Android demo APK');
      form.append('document', new Blob([fs.readFileSync(APK_PATH)]), path.basename(APK_PATH));
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram could not send the APK.');
    } else if (command === '/addadmin' || command === '/addid') {
      const newChatId = String(rest[0] || '').trim();
      if (!/^-?\d+$/.test(newChatId)) throw new Error('Use /addadmin <numeric Telegram chat id>');
      ADMIN_CHAT_IDS.add(newChatId);
      if (!store.adminChatIds.includes(newChatId)) store.adminChatIds.push(newChatId);
      saveStore();
      recordEvent('admin.added', { chatId: newChatId, actor: `telegram:${chatId}` });
      await telegramMessage(chatId, `Chat ID <code>${escapeHtml(newChatId)}</code> added.`);
    } else if (command === '/admins') {
      await telegramMessage(chatId, `<b>Bot admins</b>\n\n${[...ADMIN_CHAT_IDS].map((id) => `<code>${escapeHtml(id)}</code>`).join('\n')}`);
    } else if (command === '/logs') {
      await sendLogs(chatId);
    } else if (command === '/reply') {
      const conversationId = rest.shift();
      const text = rest.join(' ').trim();
      const conversation = store.support[conversationId];
      if (!conversation || !text) throw new Error('Conversation or message missing');
      conversation.messages.push({ id: id('msg'), sender: 'support', text: text.slice(0, 1000), createdAt: now() });
      conversation.updatedAt = now(); saveStore();
      recordEvent('support.reply', { conversationId, actor: `telegram:${chatId}` });
      await telegramMessage(chatId, `Reply sent to <code>${escapeHtml(conversationId)}</code>`);
    } else if (message?.text?.startsWith('/')) {
      await telegramMessage(chatId, 'Open /start for the transaction manager.');
    }
  } catch (error) { await telegramMessage(chatId, `Error: ${escapeHtml(error.message)}`); }
}

async function sendLogs(chatId) {
  await telegramMessage(chatId, `<b>Audit log</b>\n\n${store.events.slice(0, 20).map((event) => `<code>${escapeHtml(event.createdAt)} · ${escapeHtml(event.type)}</code>`).join('\n') || 'No events.'}`);
}

async function pollTelegram() {
  if (!BOT_TOKEN) return;
  await telegram('setMyCommands', { commands: COMMANDS }).catch(() => {});
  let offset = Number(store.telegramOffset || 0);
  // One long poll at a time: overlapping intervals can deliver a mutation twice.
  while (true) {
    try {
      const result = await telegram('getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] });
      for (const update of result.result || []) {
        offset = update.update_id + 1;
        store.telegramOffset = offset;
        saveStore();
        try { await handleTelegramUpdate(update); }
        catch (error) { console.error('Telegram update failed:', error.message); }
      }
    } catch (error) {
      console.error('Telegram polling failed:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function adminChanges(input) {
  const changes = {};
  for (const field of Object.keys(input)) {
    if (!['amount', 'recipient', 'note', 'icon', 'direction', 'status', 'createdAt', ...BANK_FIELDS].includes(field)) throw new Error(`unsupported field: ${field}`);
    const value = input[field];
    if (BANK_FIELDS.includes(field)) {
      bankField(field, value);
    } else if (field === 'amount') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw new Error('Enter an amount from 0.01 to 1,000,000 with up to two decimal places.');
    } else if (field === 'direction') {
      if (!['plus', 'minus'].includes(value)) throw new Error('invalid direction');
    } else if (field === 'status') {
      if (!['pending', 'confirmed', 'rejected'].includes(value)) throw new Error('invalid status');
    } else if (field === 'createdAt') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid date and time');
    } else if (typeof value !== 'string' || (field !== 'note' && !value.trim()) || Array.from(value).length > ({ recipient: 120, note: 240, icon: 16 }[field])) throw new Error(`invalid ${field}`);
    changes[field] = value;
  }
  return changes;
}

function connectedApp(req) {
 const key=String(req.headers['x-demo-app-id']||'');
 if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key)) return null;
 if(!store.apps[key]) {
   const generated=Object.values(store.apps).find((app) => app.generatedApk && !app.claimed);
   if (generated) {
     const profile={...generated,id:key,claimed:true,claimedFrom:generated.id,generatedApk:false,connectedAt:now(),updatedAt:now()};
     delete store.apps[generated.id]; store.apps[key]=profile; recordEvent('app.claimed',{appId:key,profileId:generated.id,source:'android'});
   } else {
     const group=createGroup({name:'Account'});
     store.apps[key]={id:key,label:'',groupId:group.id,status:'active',bankName:'',bic:'',accountHolder:'',configured:false,connectedAt:now()};saveStore();
   }
 }
 return store.apps[key];
}
const PERSONAL_FIELDS = ['fullName', 'email', 'phone', 'beneficiaryName', 'iban'];
function profileInput(input) {
  const label=String(input.label||'').trim();
  if(label.length<3||label.length>60)throw new Error('Enter a test profile label (3–60 characters).');
  const profile = {
    fullName: String(input.fullName || '').trim().slice(0, 200),
    email: String(input.email || '').trim().slice(0, 200),
    phone: String(input.phone || '').trim().slice(0, 50),
    beneficiaryName: String(input.beneficiaryName || '').trim().slice(0, 200),
    iban: String(input.iban || '').trim().slice(0, 50),
    address: String(input.address || '').trim().slice(0, 500),
    dateOfBirth: String(input.dateOfBirth || '').trim().slice(0, 20),
    taxId: String(input.taxId || '').trim().slice(0, 100)
  };
  const bankName = String(input.bankName || '').trim().slice(0, 120);
  const bic = String(input.bic || '').trim().slice(0, 16);
  const accountHolder = String(input.accountHolder || '').trim().slice(0, 200);
  const status = ['active', 'paused'].includes(String(input.status)) ? String(input.status) : 'active';
  return { label, profile, bankName, bic, accountHolder, status };
}
// Resolve which group an app create/edit should use: an explicit groupId, or a new
// solo group seeded from transactionIds (keeps the old transactionIds API working).
function resolveGroupForInput(input, existingApp) {
  const groupId = String(input.groupId || '');
  if (groupId) {
    if (!store.groups[groupId]) throw new Error('Group not found.');
    return store.groups[groupId];
  }
  if (existingApp && groupOf(existingApp)) {
    if (Array.isArray(input.transactionIds)) {
      const g = groupOf(existingApp);
      g.transactionIds = [...new Set(input.transactionIds.filter((t) => store.transactions.some((tx) => tx.id === t)))];
      g.updatedAt = now();
    }
    return groupOf(existingApp);
  }
  const sourceId = String(input.copyFromAppId || '');
  const source = sourceId ? store.apps[sourceId] : null;
  const seed = Array.isArray(input.transactionIds) ? input.transactionIds : (source ? appTransactionIds(source) : []);
  return createGroup({ name: String(input.label || 'Account'), transactionIds: seed });
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-demo-app-id', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }); return res.end(); }
  if (req.method === 'GET' && ['/admin', '/admin/', '/admin/index.html', '/admin/app.js', '/admin/style.css'].includes(req.url)) {
    const file = req.url.endsWith('.js') ? 'app.js' : req.url.endsWith('.css') ? 'style.css' : 'index.html';
    const type = { 'app.js': 'text/javascript', 'style.css': 'text/css', 'index.html': 'text/html' }[file];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    return res.end(fs.readFileSync(path.join(__dirname, 'admin', file)));
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) return sendJson(res, 200, { ok: true, service: 'demo-telegram-backend', demoMode: DEMO_MODE });
  if ((req.method === 'POST' || req.method === 'GET') && req.url.split('?')[0] === '/admin-auth/telegram') {
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://localhost');
    const userId = url.searchParams.get('userId');
    const device = await readLoginDevice(req);
    const result = await dashboardAuth.start(device, userId);
    return sendJson(res, result.status, result.body);
  }
  if (req.method === 'POST' && req.url === '/admin-auth/telegram/status') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, dashboardAuth.status(req.headers.authorization));
  }
  if (req.method === 'POST' && req.url === '/admin-auth/logout') {
    dashboardAuth.logout(req.headers.authorization);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/integrations/klarna/transfers') {
    res.setHeader('Cache-Control', 'no-store');
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const integration = integrationByToken(token);
    if (!integration) return sendJson(res, 401, { error: 'invalid or revoked integration token' });
    let input;
    try { input = await body(req); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    if (Number(input.schema_version) !== 1) return sendJson(res, 400, { error: 'unsupported schema_version' });
    const eventId = String(input.event_id || '').trim();
    if (!eventId) return sendJson(res, 400, { error: 'event_id is required' });
    const idemHeader = String(req.headers['idempotency-key'] || '').trim();
    if (idemHeader && idemHeader !== eventId) return sendJson(res, 400, { error: 'Idempotency-Key must equal event_id' });
    // Only booked transfers create a transaction; earlier notifications are acknowledged and ignored.
    if (input.event_type !== 'klarna.incoming_transfer.booked') return sendJson(res, 202, { ignored: true, reason: 'not a booked transfer event' });
    const key = `${integration.id}:${eventId}`;
    const fingerprint = transferFingerprint(input);
    const existing = store.klarnaEvents[key];
    if (existing) {
      if (existing.payloadHash === fingerprint) {
        const tx = store.transactions.find((t) => t.id === existing.transactionId);
        return sendJson(res, 200, { duplicate: true, transaction: tx ? publicTransaction(tx) : null });
      }
      return sendJson(res, 409, { error: 'event_id already used with different data' });
    }
    let tx;
    try {
      tx = createTransaction({
        amount: input.amount, currency: input.currency, direction: 'plus',
        recipient: String(input.sender_name || '').trim() || 'Klarna transfer',
        note: String(input.payment_reference || '').trim(), icon: '↙'
      }, 'klarna', { notify: false });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
    // The masked IBAN keeps its masking characters, so it is stored separately from
    // the validated full-IBAN bank field.
    const maskedIban = String(input.sender_iban_masked || '').trim().slice(0, 42);
    if (maskedIban) tx.senderIbanMasked = maskedIban;
    // A booked transfer is already settled: mark confirmed and use the booking date.
    tx.status = 'confirmed'; tx.confirmedAt = now();
    const bookingDate = String(input.booking_date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) tx.createdAt = new Date(`${bookingDate}T12:00:00.000Z`).toISOString();
    tx.integrationId = integration.id; tx.eventId = eventId;
    for (const gid of integration.groupIds || []) {
      const g = store.groups[gid];
      if (g && !g.transactionIds.includes(tx.id)) { g.transactionIds.push(tx.id); g.updatedAt = now(); }
    }
    store.klarnaEvents[key] = { integrationId: integration.id, eventId, payloadHash: fingerprint, transactionId: tx.id, createdAt: now() };
    integration.importCount = (integration.importCount || 0) + 1;
    integration.lastUsedAt = now();
    saveStore();
    recordEvent('klarna.transfer.imported', { integrationId: integration.id, eventId, transactionId: tx.id, amount: tx.amount });
    return sendJson(res, 201, { transaction: publicTransaction(tx) });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if(req.method==='GET' && req.url==='/admin-api/apps')return sendJson(res,200,{apps:Object.values(store.apps).map(appView)});
    if(req.method==='GET' && req.url==='/admin-api/groups')return sendJson(res,200,{groups:Object.values(store.groups).map(groupView)});
    if(req.method==='POST' && req.url==='/admin-api/groups') {
      const input=await body(req);
      if(String(input.name||'').trim().length<2)throw new Error('Enter a group name (2+ characters).');
      const group=createGroup(input);
      recordEvent('group.created',{groupId:group.id,actor:'web-admin'});
      return sendJson(res,201,{group:groupView(group)});
    }
    if(req.method==='PUT' && req.url.startsWith('/admin-api/groups/')) {
      const group=store.groups[req.url.split('/')[3]];if(!group)throw new Error('Group not found');
      const input=await body(req);
      if(input.name!==undefined)group.name=String(input.name||'').trim().slice(0,80);
      if(input.currency!==undefined)group.currency=String(input.currency||'EUR').trim().slice(0,8)||'EUR';
      if(input.balanceOverride!==undefined)group.balanceOverride=(input.balanceOverride===null||input.balanceOverride==='')?null:Number(input.balanceOverride);
      if(Array.isArray(input.transactionIds))group.transactionIds=[...new Set(input.transactionIds.filter(t=>store.transactions.some(tx=>tx.id===t)))];
      group.updatedAt=now();
      recordEvent('group.updated',{groupId:group.id,actor:'web-admin'});
      return sendJson(res,200,{group:groupView(group)});
    }
    if(req.method==='DELETE' && req.url.startsWith('/admin-api/groups/')) {
      const groupId=req.url.split('/')[3];const group=store.groups[groupId];if(!group)throw new Error('Group not found');
      const attached=appsInGroup(groupId);
      if(attached.length)throw new Error(`Cannot delete: ${attached.length} app(s) still use this group.`);
      delete store.groups[groupId];recordEvent('group.deleted',{groupId,actor:'web-admin'});
      return sendJson(res,200,{ok:true});
    }
    if(req.method==='GET' && req.url==='/admin-api/integrations')return sendJson(res,200,{integrations:Object.values(store.integrations).map(integrationView)});
    if(req.method==='POST' && req.url==='/admin-api/integrations') {
      const input=await body(req);
      if(String(input.name||'').trim().length<2)throw new Error('Enter an integration name (2+ characters).');
      const integrationId=`int_${crypto.randomBytes(8).toString('hex')}`;
      const integration={id:integrationId,name:String(input.name).trim().slice(0,80),token:newIntegrationToken(),groupIds:validGroupIds(input.groupIds),revoked:false,createdAt:now(),lastUsedAt:null,importCount:0};
      store.integrations[integrationId]=integration;recordEvent('integration.created',{integrationId,actor:'web-admin'});saveStore();
      return sendJson(res,201,{integration:integrationView(integration)});
    }
    if(req.method==='GET' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/transfers$/)) {
      const integrationId=req.url.split('/')[3];
      if(!store.integrations[integrationId])throw new Error('Integration not found');
      return sendJson(res,200,{transfers:integrationTransfers(integrationId)});
    }
    if(req.method==='DELETE' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/transfers\/[^/]+$/)) {
      const parts=req.url.split('/');const integrationId=parts[3];const txId=decodeURIComponent(parts[5]);
      const key=`${integrationId}:${Object.entries(store.klarnaEvents).find(([k,e])=>e.integrationId===integrationId&&e.transactionId===txId)?.[1]?.eventId||''}`;
      if(!store.klarnaEvents[key])throw new Error('Transfer not found');
      delete store.klarnaEvents[key];
      for(const g of Object.values(store.groups)){const i=g.transactionIds.indexOf(txId);if(i>=0){g.transactionIds.splice(i,1);g.updatedAt=now();}}
      try{removeTransaction(txId,'web-admin');}catch{}
      saveStore();recordEvent('klarna.transfer.removed',{integrationId,transactionId:txId,actor:'web-admin'});
      return sendJson(res,200,{ok:true});
    }
    if(req.method==='POST' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/rotate$/)) {
      const integration=store.integrations[req.url.split('/')[3]];if(!integration)throw new Error('Integration not found');
      integration.token=newIntegrationToken();integration.revoked=false;saveStore();recordEvent('integration.rotated',{integrationId:integration.id,actor:'web-admin'});
      return sendJson(res,200,{integration:integrationView(integration)});
    }
    if(req.method==='PUT' && req.url.startsWith('/admin-api/integrations/')) {
      const integration=store.integrations[req.url.split('/')[3]];if(!integration)throw new Error('Integration not found');
      const input=await body(req);
      if(input.name!==undefined){if(String(input.name).trim().length<2)throw new Error('Enter an integration name (2+ characters).');integration.name=String(input.name).trim().slice(0,80);}
      if(input.groupIds!==undefined)integration.groupIds=validGroupIds(input.groupIds);
      if(input.revoked!==undefined)integration.revoked=!!input.revoked;
      saveStore();recordEvent('integration.updated',{integrationId:integration.id,actor:'web-admin'});
      return sendJson(res,200,{integration:integrationView(integration)});
    }
    if(req.method==='DELETE' && req.url.startsWith('/admin-api/integrations/')) {
      const integrationId=req.url.split('/')[3];if(!store.integrations[integrationId])throw new Error('Integration not found');
      delete store.integrations[integrationId];recordEvent('integration.deleted',{integrationId,actor:'web-admin'});saveStore();
      return sendJson(res,200,{ok:true});
    }
    if(req.method==='POST' && req.url==='/admin-api/apps') {
      const input=await body(req);
      const sourceId=String(input.copyFromAppId||'');
      if(sourceId&&!store.apps[sourceId])throw new Error('Source profile not found.');
      const fields=profileInput(input);
      const group=resolveGroupForInput(input,null);
      const appId=`app_profile_${crypto.randomBytes(10).toString('hex')}`;
      const app={id:appId,...fields,groupId:group.id,configured:true,generatedApk:true,claimed:false,connectedAt:now(),updatedAt:now()};
      store.apps[appId]=app;recordEvent('app.created',{appId,actor:'web-admin',groupId:group.id,copiedFrom:sourceId||undefined});
      return sendJson(res,201,{app:appView(app),apkUrl:`/admin-api/apps/${encodeURIComponent(appId)}/apk`});
    }
    if(req.method==='GET' && req.url.startsWith('/admin-api/apps/') && req.url.endsWith('/apk')) {
      const appId=req.url.split('/')[3];
      if(!store.apps[appId])throw new Error('App not found');
      if(!fs.existsSync(APK_PATH))throw new Error('APK file was not found on the server.');
      res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-disposition':`attachment; filename="demo-ledger-${appId}.apk"`,'cache-control':'no-store'});
      return res.end(fs.readFileSync(APK_PATH));
    }
    if(req.method==='PUT' && req.url.startsWith('/admin-api/apps/')) {
      const app=store.apps[req.url.split('/')[3]];if(!app)throw new Error('App not found');
      const input=await body(req);const fields=profileInput(input);
      const group=resolveGroupForInput(input,app);
      Object.assign(app,fields,{groupId:group.id,configured:true,updatedAt:now()});recordEvent('app.configured',{appId:app.id,actor:'web-admin',groupId:group.id});return sendJson(res,200,{app:appView(app)});
    }
    if (req.method === 'POST' && req.url === '/admin-api/transactions') {
      const rawInput = await body(req); const appId = String(rawInput.appId || '');
      const input = adminChanges(rawInput);
      if (!input.amount || !input.recipient) throw new Error('amount and recipient are required');
      const app = appId ? store.apps[appId] : null;
      if (appId && !app) throw new Error('App not found');
      const tx = createTransaction(input, 'web-admin', { notify: false });
      if (app) { const g = groupOf(app); if (g) { g.transactionIds.push(tx.id); g.updatedAt = now(); saveStore(); } }
      const extra = {};
      if (input.status) extra.status = input.status;
      if (input.createdAt) extra.createdAt = input.createdAt;
      if (Object.keys(extra).length) editTransaction(tx.id, extra, 'web-admin');
      return sendJson(res, 201, { transaction: publicTransaction(tx), balance: accountBalance() });
    }
    if (req.method === 'PATCH' && /^\/admin-api\/transactions\/tx_[a-f0-9]+$/.test(req.url)) {
      const tx = editTransaction(req.url.split('/')[3], adminChanges(await body(req)), 'web-admin');
      return sendJson(res, 200, { transaction: publicTransaction(tx), balance: accountBalance() });
    }
    if (req.method === 'POST' && req.url === '/admin-api/balance') {
      const { balance } = await body(req);
      if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0 || balance > 1000000 || Math.abs(balance * 100 - Math.round(balance * 100)) > 0.000001) throw new Error('Enter a balance from 0 to 1,000,000 with up to two decimal places.');
      let deltaCents = Math.round(balance * 100) - Math.round(accountBalance() * 100);
      while (deltaCents !== 0) {
        const adjustment = Math.sign(deltaCents) * Math.min(Math.abs(deltaCents), 100000000);
        const tx = createConfirmedTransaction({ amount: Math.abs(adjustment) / 100, direction: adjustment < 0 ? 'minus' : 'plus', recipient: 'Balance adjustment', note: `Set balance to ${balance.toFixed(2)} EUR` }, 'web-admin');
        recordEvent('balance.adjusted', { actor: 'web-admin', transactionId: tx.id, targetBalance: balance });
        deltaCents -= adjustment;
      }
      return sendJson(res, 200, { balance: accountBalance(), currency: 'EUR' });
    }
    if (req.method === 'POST' && req.url === '/admin-api/deploy-notification') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const input = await body(req);
      const commits = Array.isArray(input.commits) ? input.commits : [];
      const deploymentName = String(input.deploymentName || 'Backend').slice(0, 100);
      const deploymentTime = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
      if (!commits.length) {
        notifyTelegram(`🚀 *${deploymentName}* deployed\n\n⏰ ${deploymentTime}\n\nNo commit information available.`);
      } else {
        let message = `🚀 *${deploymentName}* deployed\n\n⏰ ${deploymentTime}\n\n*Latest commits:*\n`;
        commits.slice(0, 10).forEach((commit, idx) => {
          const time = new Date(commit.timestamp).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
          message += `\n${idx + 1}. ${commit.message.split('\n')[0]}\n   _${time}_`;
        });
        notifyTelegram(message);
        if (commits.length > 10) {
          notifyTelegram(`_… and ${commits.length - 10} more commits_`);
        }
      }
      recordEvent('deployment.notified', { actor: 'admin-api', deploymentName, commitCount: commits.length });
      return sendJson(res, 200, { ok: true, messagesQueued: ADMIN_CHAT_IDS.size });
    }
    if (req.method === 'GET' && req.url === '/transactions') return sendJson(res, 200, { transactions: store.transactions.map(publicTransaction) });
    if (req.method === 'GET' && req.url === '/history') return sendJson(res, 200, { transactions: transactionHistory().map(publicTransaction) });
    if (req.method === 'GET' && req.url === '/account') {
      const app=connectedApp(req);
      if(app&&!app.configured)return sendJson(res,200,{demo:true,notice:DEMO_NOTICE,configured:false,appId:app.id,worker:{...WORKER},balance:0,transactions:[]});
      const txIds=app?new Set(appTransactionIds(app)):null;
      const selected=app?store.transactions.filter(tx=>txIds.has(tx.id)):store.transactions;
      // Statuses are reported as stored: a pending transaction is never shown as sent.
      const visible = selected
        .filter((tx) => tx.status === 'confirmed' || (tx.status === 'pending' && tx.source === 'frontend'))
        .slice(0, 30);
      const worker = app && app.profile ? app.profile : {...WORKER};
      const group = app ? groupOf(app) : null;
      return sendJson(res, 200, {
        demo:true, notice:DEMO_NOTICE,
        configured:true, appId:app?.id, balance:group?groupBalance(group):(app?0:accountBalance()), currency: group?group.currency:'EUR', timeZone: process.env.ACCOUNT_TIMEZONE || 'Europe/Prague',
        worker,
        transactions: visible.map(publicTransaction)
      });
    }
    if (req.method === 'PUT' && req.url === '/account') {
      const app = connectedApp(req);
      if (!app) return sendJson(res, 401, { error: 'Unauthorized' });
      if (!app.configured) return sendJson(res, 400, { error: 'Profile not configured' });
      const input = await body(req);
      app.profile = {
        fullName: String(input.fullName || '').trim().slice(0, 200),
        email: String(input.email || '').trim().slice(0, 200),
        phone: String(input.phone || '').trim().slice(0, 50),
        beneficiaryName: String(input.beneficiaryName || '').trim().slice(0, 200),
        iban: String(input.iban || '').trim().slice(0, 50),
        address: String(input.address || '').trim().slice(0, 500),
        dateOfBirth: String(input.dateOfBirth || '').trim().slice(0, 20),
        taxId: String(input.taxId || '').trim().slice(0, 100)
      };
      app.updatedAt = now();
      saveStore();
      recordEvent('profile.updated', { appId: app.id, source: 'frontend' });
      return sendJson(res, 200, { ok: true, worker: app.profile });
    }
    if (req.method === 'POST' && req.url === '/reconnect') {
      const current=connectedApp(req); const input=await body(req); const profileId=String(input.profileId||''); const source=store.apps[profileId];
      if(!current) throw new Error('Invalid app ID.');
      if(!source||!source.configured) throw new Error('Profile not found or not configured.');
      Object.assign(current,{label:source.label,groupId:source.groupId,profile:source.profile,bankName:source.bankName,bic:source.bic,accountHolder:source.accountHolder,configured:true,linkedProfileId:source.id,updatedAt:now()});
      saveStore(); recordEvent('app.reconnected',{appId:current.id,profileId:source.id,groupId:source.groupId,source:'android'});
      return sendJson(res,200,{ok:true,appId:current.id,profileId:source.id});
    }
    if (req.method === 'GET' && req.url === '/balance') return sendJson(res, 200, { balance: accountBalance(), currency: 'EUR' });
    if (req.method === 'GET' && req.url === '/logs') return sendJson(res, 200, { events: store.events });
    if (req.method === 'POST' && req.url === '/logs') {
      const input = await body(req);
      const type = String(input.type || 'ui.event').slice(0, 40);
      const action = String(input.action || '').slice(0, 80);
      const details = input.details && typeof input.details === 'object' ? input.details : {};
      recordEvent(type, { action, details, source: 'frontend' });
      return sendJson(res, 201, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/app-events') {
      // Accepted for compatibility with existing app builds, but app opens and
      // resumes are not stored or forwarded anywhere.
      await body(req);
      return sendJson(res, 202, { ok: true, tracked: false });
    }
    if (req.method === 'POST' && req.url === '/transfers/notify') {
      // Alert-only: fires a Telegram notification for a frontend-initiated transfer.
      // Deliberately does NOT create or modify any transaction, balance or ledger entry.
      const app = connectedApp(req);
      const input = await body(req);
      const recipient = String(input.recipient || '').trim().slice(0, 120);
      const amount = Number(input.amount);
      if (!recipient) throw new Error('recipient is required');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
      const iban = String(input.iban || '').trim().slice(0, 50);
      const bankName = String(input.bankName || '').trim().slice(0, 120);
      const bic = String(input.bic || '').trim().slice(0, 16);
      const lines = [
        '💸 <b>Transfer sent</b>',
        `To: ${escapeHtml(recipient)}`,
        `Amount: ${amount.toFixed(2)} €`
      ];
      if (iban) lines.push(`IBAN: ${escapeHtml(iban)}`);
      if (bankName) lines.push(`Bank: ${escapeHtml(bankName)}`);
      if (bic) lines.push(`BIC: ${escapeHtml(bic)}`);
      await notifyAdmins(lines.join('\n'));
      recordEvent('transfer.notified', { appId: app?.id, amount, source: 'frontend' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/support/messages') {
      const input = await body(req);
      const text = String(input.text || '').trim().slice(0, 1000);
      if (!text) throw new Error('message is required');
      const conversation = { id: id('support'), status: 'open', createdAt: now(), updatedAt: now(), messages: [{ id: id('msg'), sender: 'user', text, createdAt: now() }] };
      store.support[conversation.id] = conversation; saveStore();
      recordEvent('support.message', { conversationId: conversation.id });
      await notifySupportAdmins(conversation);
      return sendJson(res, 201, { conversation });
    }
    if (req.method === 'GET' && req.url.startsWith('/support/')) {
      const conversationId = req.url.split('/')[2];
      return sendJson(res, 200, { conversation: store.support[conversationId] || null });
    }
    if (req.method === 'POST' && req.url === '/transactions') {
      const app=connectedApp(req);if(app&&!app.configured)return sendJson(res,409,{error:'Configure this app in the dashboard first.'});
      const input = await body(req); const tx = createTransaction(input, 'frontend');
      if(app){const g=groupOf(app);if(g){g.transactionIds.push(tx.id);g.updatedAt=now();saveStore();}}
      return sendJson(res, 201, { transaction: publicTransaction(tx), demoMode: DEMO_MODE });
    }
    if (req.method === 'POST' && req.url.startsWith('/transactions/')) {
      const transactionId = req.url.split('/')[2]; const input = await body(req);
      const tx = updateTransaction(transactionId, input.status, input.actor || 'api');
      return sendJson(res, 200, { transaction: publicTransaction(tx), demoMode: DEMO_MODE });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/transactions/')) {
      const transactionId = req.url.split('/')[2];
      const tx = removeTransaction(transactionId, 'api');
      return sendJson(res, 200, { transaction: publicTransaction(tx), balance: accountBalance(), demoMode: DEMO_MODE });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) { return sendJson(res, 400, { error: error.message }); }
});

if (require.main === module) {
seedFrontendExamples();
server.listen(PORT, () => {
  console.log(`Demo backend listening on http://127.0.0.1:${PORT}`);
  if (DEMO_MODE) console.log('DEMO_MODE is enabled: no real money movement is performed.');
  if (process.env.DISABLE_TELEGRAM !== 'true') {
    pollTelegram();
    checkAndNotifyDeployment();
    setInterval(checkAndNotifyDeployment, 5 * 60 * 1000);
  }
});

}

module.exports = { server, handleTelegramUpdate, createTransaction, editTransaction, updateTransaction, removeTransaction, accountBalance, seedFrontendExamples };
