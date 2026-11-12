'use strict';

// Transaction ledger: creation, validation, edits, deletion and balance maths.
// A transaction is pending until an admin confirms or rejects it; only confirmed
// transactions count toward balances.

const { store, saveStore, recordEvent, id, now } = require('../store');
const { BANK_FIELDS } = require('../config');
const { notifyAdmins, formatTx } = require('../telegram/api');

function bankField(field, value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`invalid ${field}`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (field === 'iban' && !/^[A-Za-z0-9 ]{0,42}$/.test(text)) throw new Error('IBAN may contain only letters, digits and spaces (max 34 characters).');
  if (field === 'bic' && !/^[A-Za-z0-9]{0,11}$/.test(text)) throw new Error('BIC may contain only letters and digits (max 11 characters).');
  if (field === 'bankName' && Array.from(text).length > 120) throw new Error('Bank name must be 120 characters or fewer.');
  return field === 'bankName' ? text : text.toUpperCase();
}

function publicTransaction(tx) { return { ...tx }; }

function accountBalance() {
  const total = store.transactions
    .filter((tx) => tx.status === 'confirmed')
    .reduce((sum, tx) => sum + (tx.direction === 'minus' ? -tx.amount : tx.amount), 0);
  return Math.round(total * 100) / 100;
}

function transactionHistory() {
  return store.transactions.filter((tx) => tx.status !== 'pending');
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

// Validate an admin's partial transaction edit, returning the accepted changes.
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

// Seed once: deleted or edited examples must not reappear on the next restart.
function seedFrontendExamples() {
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

module.exports = {
  bankField, publicTransaction, accountBalance, transactionHistory,
  createTransaction, updateTransaction, editTransaction, removeTransaction,
  createConfirmedTransaction, adminChanges, seedFrontendExamples
};
