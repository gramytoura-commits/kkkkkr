'use strict';

// HTTP API surface. One Node http server that serves the admin dashboard static
// files, the public /health endpoint, the Telegram sign-in endpoints, the Klarna
// integration webhook and the authenticated admin + customer-app APIs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ROOT, API_SECRET, APK_PATH, DEMO_MODE, DEMO_NOTICE, WORKER, ALLOW_LOCAL_ADMIN, TIME_ZONE, ADMIN_CHAT_IDS } = require('../config');
const { store, saveStore, recordEvent, id, now } = require('../store');
const { sendJson, readBody, escapeHtml } = require('../util');
const tx = require('../domain/transactions');
const groups = require('../domain/groups');
const integrations = require('../domain/integrations');
const apps = require('../domain/apps');
const { notifyAdmins, notifyTelegram, notifySupportAdmins } = require('../telegram/api');
const { dashboardAuth, readLoginDevice } = require('../telegram/bot');

const ADMIN_FILES = ['/admin', '/admin/', '/admin/index.html', '/admin/app.js', '/admin/style.css'];

function authorized(req) {
  if (ALLOW_LOCAL_ADMIN && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return true;
  return req.headers.authorization === `Bearer ${API_SECRET}` || dashboardAuth.authorize(req);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-demo-app-id', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }); return res.end(); }
  if (req.method === 'GET' && ADMIN_FILES.includes(req.url)) {
    const file = req.url.endsWith('.js') ? 'app.js' : req.url.endsWith('.css') ? 'style.css' : 'index.html';
    const type = { 'app.js': 'text/javascript', 'style.css': 'text/css', 'index.html': 'text/html' }[file];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    return res.end(fs.readFileSync(path.join(ROOT, 'admin', file)));
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
    const integration = integrations.integrationByToken(token);
    if (!integration) return sendJson(res, 401, { error: 'invalid or revoked integration token' });
    let input;
    try { input = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    if (Number(input.schema_version) !== 1) return sendJson(res, 400, { error: 'unsupported schema_version' });
    const eventId = String(input.event_id || '').trim();
    if (!eventId) return sendJson(res, 400, { error: 'event_id is required' });
    const idemHeader = String(req.headers['idempotency-key'] || '').trim();
    if (idemHeader && idemHeader !== eventId) return sendJson(res, 400, { error: 'Idempotency-Key must equal event_id' });
    // Only booked transfers create a transaction; earlier notifications are acknowledged and ignored.
    if (input.event_type !== 'klarna.incoming_transfer.booked') return sendJson(res, 202, { ignored: true, reason: 'not a booked transfer event' });
    const key = `${integration.id}:${eventId}`;
    const fingerprint = integrations.transferFingerprint(input);
    const existing = store.klarnaEvents[key];
    if (existing) {
      if (existing.payloadHash === fingerprint) {
        const found = store.transactions.find((t) => t.id === existing.transactionId);
        return sendJson(res, 200, { duplicate: true, transaction: found ? tx.publicTransaction(found) : null });
      }
      return sendJson(res, 409, { error: 'event_id already used with different data' });
    }
    let transaction;
    try {
      transaction = tx.createTransaction({
        amount: input.amount, currency: input.currency, direction: 'plus',
        recipient: String(input.sender_name || '').trim() || 'Klarna transfer',
        note: String(input.payment_reference || '').trim(), icon: '↙'
      }, 'klarna', { notify: false });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
    // The masked IBAN keeps its masking characters, so it is stored separately from
    // the validated full-IBAN bank field.
    const maskedIban = String(input.sender_iban_masked || '').trim().slice(0, 42);
    if (maskedIban) transaction.senderIbanMasked = maskedIban;
    // A booked transfer is already settled: mark confirmed and use the booking date.
    transaction.status = 'confirmed'; transaction.confirmedAt = now();
    const bookingDate = String(input.booking_date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) transaction.createdAt = new Date(`${bookingDate}T12:00:00.000Z`).toISOString();
    transaction.integrationId = integration.id; transaction.eventId = eventId;
    for (const gid of integration.groupIds || []) {
      const g = store.groups[gid];
      if (g && !g.transactionIds.includes(transaction.id)) { g.transactionIds.push(transaction.id); g.updatedAt = now(); }
    }
    store.klarnaEvents[key] = { integrationId: integration.id, eventId, payloadHash: fingerprint, transactionId: transaction.id, createdAt: now() };
    integration.importCount = (integration.importCount || 0) + 1;
    integration.lastUsedAt = now();
    saveStore();
    recordEvent('klarna.transfer.imported', { integrationId: integration.id, eventId, transactionId: transaction.id, amount: transaction.amount });
    return sendJson(res, 201, { transaction: tx.publicTransaction(transaction) });
  }
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && req.url === '/admin-api/apps') return sendJson(res, 200, { apps: Object.values(store.apps).map(groups.appView) });
    if (req.method === 'GET' && req.url === '/admin-api/groups') return sendJson(res, 200, { groups: Object.values(store.groups).map(groups.groupView) });
    if (req.method === 'POST' && req.url === '/admin-api/groups') {
      const input = await readBody(req);
      if (String(input.name || '').trim().length < 2) throw new Error('Enter a group name (2+ characters).');
      const group = groups.createGroup(input);
      recordEvent('group.created', { groupId: group.id, actor: 'web-admin' });
      return sendJson(res, 201, { group: groups.groupView(group) });
    }
    if (req.method === 'PUT' && req.url.startsWith('/admin-api/groups/')) {
      const group = store.groups[req.url.split('/')[3]]; if (!group) throw new Error('Group not found');
      const input = await readBody(req);
      if (input.name !== undefined) group.name = String(input.name || '').trim().slice(0, 80);
      if (input.currency !== undefined) group.currency = String(input.currency || 'EUR').trim().slice(0, 8) || 'EUR';
      if (input.balanceOverride !== undefined) group.balanceOverride = (input.balanceOverride === null || input.balanceOverride === '') ? null : Number(input.balanceOverride);
      if (Array.isArray(input.transactionIds)) group.transactionIds = [...new Set(input.transactionIds.filter((t) => store.transactions.some((item) => item.id === t)))];
      group.updatedAt = now();
      recordEvent('group.updated', { groupId: group.id, actor: 'web-admin' });
      return sendJson(res, 200, { group: groups.groupView(group) });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/admin-api/groups/')) {
      const groupId = req.url.split('/')[3]; const group = store.groups[groupId]; if (!group) throw new Error('Group not found');
      const attached = groups.appsInGroup(groupId);
      if (attached.length) throw new Error(`Cannot delete: ${attached.length} app(s) still use this group.`);
      delete store.groups[groupId]; recordEvent('group.deleted', { groupId, actor: 'web-admin' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/admin-api/integrations') return sendJson(res, 200, { integrations: Object.values(store.integrations).map(integrations.integrationView) });
    if (req.method === 'POST' && req.url === '/admin-api/integrations') {
      const input = await readBody(req);
      if (String(input.name || '').trim().length < 2) throw new Error('Enter an integration name (2+ characters).');
      const integrationId = `int_${crypto.randomBytes(8).toString('hex')}`;
      const integration = { id: integrationId, name: String(input.name).trim().slice(0, 80), token: integrations.newIntegrationToken(), groupIds: integrations.validGroupIds(input.groupIds), revoked: false, createdAt: now(), lastUsedAt: null, importCount: 0 };
      store.integrations[integrationId] = integration; recordEvent('integration.created', { integrationId, actor: 'web-admin' }); saveStore();
      return sendJson(res, 201, { integration: integrations.integrationView(integration) });
    }
    if (req.method === 'GET' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/transfers$/)) {
      const integrationId = req.url.split('/')[3];
      if (!store.integrations[integrationId]) throw new Error('Integration not found');
      return sendJson(res, 200, { transfers: integrations.integrationTransfers(integrationId) });
    }
    if (req.method === 'DELETE' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/transfers\/[^/]+$/)) {
      const parts = req.url.split('/'); const integrationId = parts[3]; const txId = decodeURIComponent(parts[5]);
      const key = `${integrationId}:${Object.entries(store.klarnaEvents).find(([, e]) => e.integrationId === integrationId && e.transactionId === txId)?.[1]?.eventId || ''}`;
      if (!store.klarnaEvents[key]) throw new Error('Transfer not found');
      delete store.klarnaEvents[key];
      for (const g of Object.values(store.groups)) { const i = g.transactionIds.indexOf(txId); if (i >= 0) { g.transactionIds.splice(i, 1); g.updatedAt = now(); } }
      try { tx.removeTransaction(txId, 'web-admin'); } catch { /* already gone */ }
      saveStore(); recordEvent('klarna.transfer.removed', { integrationId, transactionId: txId, actor: 'web-admin' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url.match(/^\/admin-api\/integrations\/[^/]+\/rotate$/)) {
      const integration = store.integrations[req.url.split('/')[3]]; if (!integration) throw new Error('Integration not found');
      integration.token = integrations.newIntegrationToken(); integration.revoked = false; saveStore(); recordEvent('integration.rotated', { integrationId: integration.id, actor: 'web-admin' });
      return sendJson(res, 200, { integration: integrations.integrationView(integration) });
    }
    if (req.method === 'PUT' && req.url.startsWith('/admin-api/integrations/')) {
      const integration = store.integrations[req.url.split('/')[3]]; if (!integration) throw new Error('Integration not found');
      const input = await readBody(req);
      if (input.name !== undefined) { if (String(input.name).trim().length < 2) throw new Error('Enter an integration name (2+ characters).'); integration.name = String(input.name).trim().slice(0, 80); }
      if (input.groupIds !== undefined) integration.groupIds = integrations.validGroupIds(input.groupIds);
      if (input.revoked !== undefined) integration.revoked = !!input.revoked;
      saveStore(); recordEvent('integration.updated', { integrationId: integration.id, actor: 'web-admin' });
      return sendJson(res, 200, { integration: integrations.integrationView(integration) });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/admin-api/integrations/')) {
      const integrationId = req.url.split('/')[3]; if (!store.integrations[integrationId]) throw new Error('Integration not found');
      delete store.integrations[integrationId]; recordEvent('integration.deleted', { integrationId, actor: 'web-admin' }); saveStore();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/admin-api/apps') {
      const input = await readBody(req);
      const sourceId = String(input.copyFromAppId || '');
      if (sourceId && !store.apps[sourceId]) throw new Error('Source profile not found.');
      const fields = apps.profileInput(input);
      const group = apps.resolveGroupForInput(input, null);
      const appId = `app_profile_${crypto.randomBytes(10).toString('hex')}`;
      const app = { id: appId, ...fields, groupId: group.id, configured: true, generatedApk: true, claimed: false, connectedAt: now(), updatedAt: now() };
      store.apps[appId] = app; recordEvent('app.created', { appId, actor: 'web-admin', groupId: group.id, copiedFrom: sourceId || undefined });
      return sendJson(res, 201, { app: groups.appView(app), apkUrl: `/admin-api/apps/${encodeURIComponent(appId)}/apk` });
    }
    if (req.method === 'GET' && req.url === '/admin-api/apk') {
      if (!fs.existsSync(APK_PATH)) throw new Error('APK file was not found on the server.');
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="FakeKlarna.apk"', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(APK_PATH));
    }
    if (req.method === 'GET' && req.url.startsWith('/admin-api/apps/') && req.url.endsWith('/apk')) {
      const appId = req.url.split('/')[3];
      if (!store.apps[appId]) throw new Error('App not found');
      if (!fs.existsSync(APK_PATH)) throw new Error('APK file was not found on the server.');
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="demo-ledger-${appId}.apk"`, 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(APK_PATH));
    }
    if (req.method === 'PUT' && req.url.startsWith('/admin-api/apps/')) {
      const app = store.apps[req.url.split('/')[3]]; if (!app) throw new Error('App not found');
      const input = await readBody(req); const fields = apps.profileInput(input);
      const group = apps.resolveGroupForInput(input, app);
      Object.assign(app, fields, { groupId: group.id, configured: true, updatedAt: now() }); recordEvent('app.configured', { appId: app.id, actor: 'web-admin', groupId: group.id }); return sendJson(res, 200, { app: groups.appView(app) });
    }
    if (req.method === 'POST' && req.url === '/admin-api/transactions') {
      const rawInput = await readBody(req); const appId = String(rawInput.appId || '');
      const input = tx.adminChanges(rawInput);
      if (!input.amount || !input.recipient) throw new Error('amount and recipient are required');
      const app = appId ? store.apps[appId] : null;
      if (appId && !app) throw new Error('App not found');
      const transaction = tx.createTransaction(input, 'web-admin', { notify: false });
      if (app) { const g = groups.groupOf(app); if (g) { g.transactionIds.push(transaction.id); g.updatedAt = now(); saveStore(); } }
      const extra = {};
      if (input.status) extra.status = input.status;
      if (input.createdAt) extra.createdAt = input.createdAt;
      if (Object.keys(extra).length) tx.editTransaction(transaction.id, extra, 'web-admin');
      return sendJson(res, 201, { transaction: tx.publicTransaction(transaction), balance: tx.accountBalance() });
    }
    if (req.method === 'PATCH' && /^\/admin-api\/transactions\/tx_[a-f0-9]+$/.test(req.url)) {
      const transaction = tx.editTransaction(req.url.split('/')[3], tx.adminChanges(await readBody(req)), 'web-admin');
      return sendJson(res, 200, { transaction: tx.publicTransaction(transaction), balance: tx.accountBalance() });
    }
    if (req.method === 'POST' && req.url === '/admin-api/balance') {
      const { balance } = await readBody(req);
      if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0 || balance > 1000000 || Math.abs(balance * 100 - Math.round(balance * 100)) > 0.000001) throw new Error('Enter a balance from 0 to 1,000,000 with up to two decimal places.');
      let deltaCents = Math.round(balance * 100) - Math.round(tx.accountBalance() * 100);
      while (deltaCents !== 0) {
        const adjustment = Math.sign(deltaCents) * Math.min(Math.abs(deltaCents), 100000000);
        const transaction = tx.createConfirmedTransaction({ amount: Math.abs(adjustment) / 100, direction: adjustment < 0 ? 'minus' : 'plus', recipient: 'Balance adjustment', note: `Set balance to ${balance.toFixed(2)} EUR` }, 'web-admin');
        recordEvent('balance.adjusted', { actor: 'web-admin', transactionId: transaction.id, targetBalance: balance });
        deltaCents -= adjustment;
      }
      return sendJson(res, 200, { balance: tx.accountBalance(), currency: 'EUR' });
    }
    if (req.method === 'POST' && req.url === '/admin-api/deploy-notification') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const input = await readBody(req);
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
        if (commits.length > 10) notifyTelegram(`_… and ${commits.length - 10} more commits_`);
      }
      recordEvent('deployment.notified', { actor: 'admin-api', deploymentName, commitCount: commits.length });
      return sendJson(res, 200, { ok: true, messagesQueued: ADMIN_CHAT_IDS.size });
    }
    if (req.method === 'GET' && req.url === '/transactions') return sendJson(res, 200, { transactions: store.transactions.map(tx.publicTransaction) });
    if (req.method === 'GET' && req.url === '/history') return sendJson(res, 200, { transactions: tx.transactionHistory().map(tx.publicTransaction) });
    if (req.method === 'GET' && req.url === '/account') {
      const app = apps.connectedApp(req);
      if (app && !app.configured) return sendJson(res, 200, { demo: true, notice: DEMO_NOTICE, configured: false, appId: app.id, worker: { ...WORKER }, balance: 0, transactions: [] });
      const txIds = app ? new Set(groups.appTransactionIds(app)) : null;
      const selected = app ? store.transactions.filter((item) => txIds.has(item.id)) : store.transactions;
      // Statuses are reported as stored: a pending transaction is never shown as sent.
      const visible = selected
        .filter((item) => item.status === 'confirmed' || (item.status === 'pending' && item.source === 'frontend'))
        .slice(0, 30);
      const worker = app && app.profile ? app.profile : { ...WORKER };
      const group = app ? groups.groupOf(app) : null;
      return sendJson(res, 200, {
        demo: true, notice: DEMO_NOTICE,
        configured: true, appId: app?.id, balance: group ? groups.groupBalance(group) : (app ? 0 : tx.accountBalance()), currency: group ? group.currency : 'EUR', timeZone: TIME_ZONE,
        worker,
        transactions: visible.map(tx.publicTransaction)
      });
    }
    if (req.method === 'PUT' && req.url === '/account') {
      const app = apps.connectedApp(req);
      if (!app) return sendJson(res, 401, { error: 'Unauthorized' });
      if (!app.configured) return sendJson(res, 400, { error: 'Profile not configured' });
      const input = await readBody(req);
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
      const current = apps.connectedApp(req); const input = await readBody(req); const profileId = String(input.profileId || ''); const source = store.apps[profileId];
      if (!current) throw new Error('Invalid app ID.');
      if (!source || !source.configured) throw new Error('Profile not found or not configured.');
      Object.assign(current, { label: source.label, groupId: source.groupId, profile: source.profile, bankName: source.bankName, bic: source.bic, accountHolder: source.accountHolder, configured: true, linkedProfileId: source.id, updatedAt: now() });
      saveStore(); recordEvent('app.reconnected', { appId: current.id, profileId: source.id, groupId: source.groupId, source: 'android' });
      return sendJson(res, 200, { ok: true, appId: current.id, profileId: source.id });
    }
    if (req.method === 'GET' && req.url === '/balance') return sendJson(res, 200, { balance: tx.accountBalance(), currency: 'EUR' });
    if (req.method === 'GET' && req.url === '/logs') return sendJson(res, 200, { events: store.events });
    if (req.method === 'POST' && req.url === '/logs') {
      const input = await readBody(req);
      const type = String(input.type || 'ui.event').slice(0, 40);
      const action = String(input.action || '').slice(0, 80);
      const details = input.details && typeof input.details === 'object' ? input.details : {};
      recordEvent(type, { action, details, source: 'frontend' });
      return sendJson(res, 201, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/app-events') {
      // Accepted for compatibility with existing app builds, but app opens and
      // resumes are not stored or forwarded anywhere.
      await readBody(req);
      return sendJson(res, 202, { ok: true, tracked: false });
    }
    if (req.method === 'POST' && req.url === '/transfers/notify') {
      // Alert-only: fires a Telegram notification for a frontend-initiated transfer.
      // Deliberately does NOT create or modify any transaction, balance or ledger entry.
      const app = apps.connectedApp(req);
      const input = await readBody(req);
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
      const input = await readBody(req);
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
      const app = apps.connectedApp(req); if (app && !app.configured) return sendJson(res, 409, { error: 'Configure this app in the dashboard first.' });
      const input = await readBody(req); const transaction = tx.createTransaction(input, 'frontend');
      if (app) { const g = groups.groupOf(app); if (g) { g.transactionIds.push(transaction.id); g.updatedAt = now(); saveStore(); } }
      return sendJson(res, 201, { transaction: tx.publicTransaction(transaction), demoMode: DEMO_MODE });
    }
    if (req.method === 'POST' && req.url.startsWith('/transactions/')) {
      const transactionId = req.url.split('/')[2]; const input = await readBody(req);
      const transaction = tx.updateTransaction(transactionId, input.status, input.actor || 'api');
      return sendJson(res, 200, { transaction: tx.publicTransaction(transaction), demoMode: DEMO_MODE });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/transactions/')) {
      const transactionId = req.url.split('/')[2];
      const transaction = tx.removeTransaction(transactionId, 'api');
      return sendJson(res, 200, { transaction: tx.publicTransaction(transaction), balance: tx.accountBalance(), demoMode: DEMO_MODE });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) { return sendJson(res, 400, { error: error.message }); }
});

module.exports = { server };
