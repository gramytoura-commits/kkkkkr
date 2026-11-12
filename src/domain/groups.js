'use strict';

// Linked groups: a group owns the shared transaction selection, balance override
// and currency. Every app belongs to exactly one group; apps in the same group
// share that data.

const crypto = require('crypto');
const { store, saveStore, now } = require('../store');

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

function groupOf(app) { return app && store.groups[app.groupId] ? store.groups[app.groupId] : null; }
function appTransactionIds(app) { const g = groupOf(app); return g ? g.transactionIds : (app?.transactionIds || []); }

function computedGroupBalance(group) {
  const ids = new Set(group.transactionIds);
  return Math.round(store.transactions
    .filter((tx) => ids.has(tx.id) && tx.status === 'confirmed')
    .reduce((sum, tx) => sum + (tx.direction === 'minus' ? -tx.amount : tx.amount), 0) * 100) / 100;
}

function groupBalance(group) {
  return group.balanceOverride !== null && group.balanceOverride !== undefined ? group.balanceOverride : computedGroupBalance(group);
}

function appsInGroup(groupId) { return Object.values(store.apps).filter((a) => a.groupId === groupId); }

function groupView(group) {
  return { ...group, balance: groupBalance(group), computedBalance: computedGroupBalance(group), appCount: appsInGroup(group.id).length };
}

function appView(app) {
  const g = groupOf(app);
  return { ...app, transactionIds: appTransactionIds(app), balance: g ? groupBalance(g) : 0, currency: g ? g.currency : 'EUR', groupName: g ? g.name : '' };
}

// Migrate apps to groups: each existing app that has no group gets its own solo
// group seeded from its current transactionIds, so prior per-app behavior is
// preserved. Also backfills newer app fields. Runs once at startup.
function migrateGroupsAndApps() {
  let changed = false;
  for (const app of Object.values(store.apps)) {
    if (!app.groupId || !store.groups[app.groupId]) {
      const group = createGroup({ name: app.label || 'Account', transactionIds: app.transactionIds || [] });
      app.groupId = group.id;
      changed = true;
    }
    if (!app.status) { app.status = 'active'; changed = true; }
    if (app.bankName === undefined) app.bankName = '';
    if (app.bic === undefined) app.bic = '';
    if (app.accountHolder === undefined) app.accountHolder = '';
  }
  if (changed) saveStore();
}

module.exports = {
  newGroupId, createGroup, groupOf, appTransactionIds,
  computedGroupBalance, groupBalance, appsInGroup, groupView, appView,
  migrateGroupsAndApps
};
