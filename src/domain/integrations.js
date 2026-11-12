'use strict';

// Integrations: a revocable token that lets an external sender (e.g. a Klarna
// Companion) push booked transfers. Each integration targets one or more groups;
// an imported transfer becomes a confirmed transaction added to those groups.

const crypto = require('crypto');
const { store } = require('../store');
const { publicTransaction } = require('./transactions');

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

module.exports = {
  newIntegrationToken, integrationByToken, validGroupIds,
  integrationView, transferFingerprint, integrationTransfers
};
