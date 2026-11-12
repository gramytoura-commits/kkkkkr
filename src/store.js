'use strict';

// The JSON ledger: a single in-memory object persisted to disk. One writer only
// (never run multiple backend replicas against the same file). All domain modules
// import `store` by reference and mutate it in place, then call saveStore().

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STORE_PATH, ADMIN_CHAT_IDS } = require('./config');

fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { transactions: [], events: [], support: {} }; }
}

const store = loadStore();

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function id(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function now() { return new Date().toISOString(); }

function recordEvent(type, payload = {}) {
  store.events.unshift({ id: id('evt'), type, createdAt: now(), ...payload });
  store.events = store.events.slice(0, 1000);
  saveStore();
}

// Ensure every collection exists and migrate legacy records that predate the
// current shape. Group/app migration that needs domain helpers runs separately
// (see domain/groups.migrateGroupsAndApps), called from server.js after wiring.
function initStore() {
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
  for (const app of Object.values(store.apps)) {
    app.label ||= app.configured ? `Test profile ${app.id.slice(-6)}` : '';
    if (!app.label) app.configured = false;
    if (!app.profile) {
      app.profile = { fullName: '', email: '', phone: '', beneficiaryName: '', iban: '', address: '', dateOfBirth: '', taxId: '' };
    }
  }
}

module.exports = { store, saveStore, recordEvent, id, now, initStore };
