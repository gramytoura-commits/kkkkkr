'use strict';

// Telegram bot orchestration: wires the transaction manager and dashboard-auth
// modules, routes incoming updates, long-polls for new ones and posts deployment
// notifications. Everything here is inert when no bot token is configured.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { BOT_TOKEN, APK_PATH, ADMIN_CHAT_IDS, TIME_ZONE, DISABLE_TELEGRAM, ROOT } = require('../config');
const { store, saveStore, recordEvent, id, now } = require('../store');
const { escapeHtml } = require('../util');
const { telegram, telegramMessage, notifyTelegram, parseTransferInput } = require('./api');
const { createTransaction, editTransaction, removeTransaction, accountBalance } = require('../domain/transactions');
const { createTelegramManager, COMMANDS } = require('../../telegram-manager');

// dashboard-auth is optional: fall back to a disabled stub if it cannot load.
let createDashboardAuth, readLoginDevice;
try {
  ({ createDashboardAuth, readLoginDevice } = require('../../dashboard-auth'));
} catch {
  createDashboardAuth = () => ({ authorize: () => false, handleUpdate: async () => false, start: async () => ({ status: 401 }) });
  readLoginDevice = () => ({});
}

const transactionManager = createTelegramManager({
  telegram, adminChatIds: ADMIN_CHAT_IDS, getTransactions: () => store.transactions,
  accountBalance, createTransaction, editTransaction, removeTransaction,
  parseTransferInput, escapeHtml, recordEvent,
  timeZone: TIME_ZONE
});

const dashboardAuth = createDashboardAuth({
  telegram, adminChatIds: ADMIN_CHAT_IDS,
  enabled: Boolean(BOT_TOKEN) && !DISABLE_TELEGRAM
});

async function sendLogs(chatId) {
  await telegramMessage(chatId, `<b>Audit log</b>\n\n${store.events.slice(0, 20).map((event) => `<code>${escapeHtml(event.createdAt)} · ${escapeHtml(event.type)}</code>`).join('\n') || 'No events.'}`);
}

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
      await telegramMessage(chatId, `<b>Bot admins</b>\n\n${[...ADMIN_CHAT_IDS].map((adminId) => `<code>${escapeHtml(adminId)}</code>`).join('\n')}`);
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

async function getRecentCommits(count = 5) {
  try {
    const output = execSync(`git log -${count} --format=%H|%s|%aI 2>/dev/null || echo ""`, { cwd: ROOT, encoding: 'utf8', shell: '/bin/bash' });
    if (!output.trim()) return [];
    return output.trim().split('\n').filter(Boolean).map((line) => {
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

module.exports = {
  dashboardAuth, readLoginDevice, transactionManager,
  handleTelegramUpdate, pollTelegram, checkAndNotifyDeployment
};
