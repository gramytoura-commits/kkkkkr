'use strict';

// Connected apps (customer-app instances) and their test profiles. A new app id
// either claims a pre-generated profile or creates an unconfigured one; the
// dashboard must configure it before the app shows account data.

const { store, saveStore, recordEvent, now } = require('../store');
const { createGroup, groupOf, appTransactionIds } = require('./groups');

function connectedApp(req) {
  const key = String(req.headers['x-demo-app-id'] || '');
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key)) return null;
  if (!store.apps[key]) {
    const generated = Object.values(store.apps).find((app) => app.generatedApk && !app.claimed);
    if (generated) {
      const profile = { ...generated, id: key, claimed: true, claimedFrom: generated.id, generatedApk: false, connectedAt: now(), updatedAt: now() };
      delete store.apps[generated.id]; store.apps[key] = profile; recordEvent('app.claimed', { appId: key, profileId: generated.id, source: 'android' });
    } else {
      const group = createGroup({ name: 'Account' });
      store.apps[key] = { id: key, label: '', groupId: group.id, status: 'active', bankName: '', bic: '', accountHolder: '', configured: false, connectedAt: now() };
      saveStore();
    }
  }
  return store.apps[key];
}

function profileInput(input) {
  const label = String(input.label || '').trim();
  if (label.length < 3 || label.length > 60) throw new Error('Enter a test profile label (3–60 characters).');
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

module.exports = { connectedApp, profileInput, resolveGroupForInput };
