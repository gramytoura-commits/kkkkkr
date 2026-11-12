'use strict';

// Telegram Bot API transport plus the message-formatting and notification
// helpers built on top of it. Safe to import even when no bot token is set:
// every send is a no-op without BOT_TOKEN.

const { BOT_TOKEN, ADMIN_CHAT_IDS } = require('../config');
const { escapeHtml } = require('../util');

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

function formatTx(tx) {
  return `${tx.direction === 'minus' ? '−' : '+'} ${escapeHtml(tx.icon || '↔')} ${escapeHtml(tx.id)} · ${tx.amount.toFixed(2)} ${escapeHtml(tx.currency)} · ${escapeHtml(tx.recipient)} · ${escapeHtml(tx.status)}`;
}

function formatTransactionList(items, emptyMessage = 'Žádné transakce.') {
  return items.length ? items.map((tx) => `<code>${formatTx(tx)}</code>`).join('\n') : emptyMessage;
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

module.exports = {
  telegram, telegramMessage,
  notifyAdmins, notifySupportAdmins, notifyTelegram,
  formatTx, formatTransactionList, sendTelegramChunks, parseTransferInput
};
