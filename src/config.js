'use strict';

// Central configuration: loads the local .env file (without overriding real
// environment variables) and exposes every tunable value as a named constant.
// Nothing else in the backend reads process.env directly.

const fs = require('fs');
const path = require('path');

// backend/ root, regardless of where this module lives (src/).
const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() !== 'false';
}

const PORT = Number(process.env.PORT || 8787);
const API_SECRET = process.env.API_SECRET || 'change-me-in-development';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DISABLE_TELEGRAM = process.env.DISABLE_TELEGRAM === 'true';
const ALLOW_LOCAL_ADMIN = process.env.ALLOW_LOCAL_ADMIN === 'true';
const DEMO_MODE = bool(process.env.DEMO_MODE, true);
const TIME_ZONE = process.env.ACCOUNT_TIMEZONE || 'Europe/Prague';

// Where the JSON ledger lives. Defaults to backend/data/ for local runs; the
// deployment sets DATA_DIR explicitly (e.g. the /app/data bind mount).
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'data.json');

// Optional Android APK served by /admin-api/apk. Falls back to the sibling
// android build output so a local checkout works without extra configuration.
const APK_PATH = path.resolve(
  process.env.APK_PATH ||
  path.join(ROOT, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
);

// Telegram admin chat ids. Mutable: /addadmin and stored ids merge into this Set.
const ADMIN_CHAT_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map((value) => value.trim()).filter(Boolean)
);

// Test data only: profiles never hold real names, contact details or bank accounts.
const DEMO_NOTICE = 'DEMO – not real money. Test data only.';
function demoWorker(label = 'Demo profile') {
  return Object.freeze({
    firstName: 'DEMO', lastName: label, fullName: `DEMO · ${label}`,
    email: 'demo@example.invalid', phone: '', beneficiaryName: 'DEMO', iban: 'DEMO-NOT-A-REAL-ACCOUNT'
  });
}
const WORKER = demoWorker();

// Transaction fields that carry bank details, validated on write.
const BANK_FIELDS = ['iban', 'bankName', 'bic'];
// Profile fields that must never be exposed for a connected app (demo only).
const PERSONAL_FIELDS = ['fullName', 'email', 'phone', 'beneficiaryName', 'iban'];

module.exports = {
  ROOT,
  PORT,
  API_SECRET,
  BOT_TOKEN,
  DISABLE_TELEGRAM,
  ALLOW_LOCAL_ADMIN,
  DEMO_MODE,
  TIME_ZONE,
  DATA_DIR,
  STORE_PATH,
  APK_PATH,
  ADMIN_CHAT_IDS,
  DEMO_NOTICE,
  demoWorker,
  WORKER,
  BANK_FIELDS,
  PERSONAL_FIELDS
};
