'use strict';

// Entry point. Composes the modules in src/, applies startup migrations and (when
// run directly) starts the HTTP server plus Telegram polling. The source itself
// lives in src/: config, store, domain/, telegram/ and http/.
//
//   npm start        run the backend
//   npm run dev      run with local-friendly defaults (see package.json)
//   npm test         run the test suite
//
// The require() order below matters: the store must be initialised before the
// group/app migration, which in turn runs before the HTTP layer handles requests.

const { PORT, DEMO_MODE, DISABLE_TELEGRAM } = require('./src/config');
const { initStore } = require('./src/store');
initStore();

const { migrateGroupsAndApps } = require('./src/domain/groups');
migrateGroupsAndApps();

const transactions = require('./src/domain/transactions');
const { server } = require('./src/http/server');
const { handleTelegramUpdate, pollTelegram, checkAndNotifyDeployment } = require('./src/telegram/bot');

// Seed demo data, start listening and (unless disabled) begin Telegram polling.
function start() {
  transactions.seedFrontendExamples();
  server.listen(PORT, () => {
    console.log(`Demo backend listening on http://127.0.0.1:${PORT}`);
    if (DEMO_MODE) console.log('DEMO_MODE is enabled: no real money movement is performed.');
    if (!DISABLE_TELEGRAM) {
      pollTelegram();
      checkAndNotifyDeployment();
      setInterval(checkAndNotifyDeployment, 5 * 60 * 1000);
    }
  });
  return server;
}

// Public surface, unchanged from the previous single-file layout so existing
// importers (tests, tooling) keep working.
module.exports = {
  server,
  start,
  handleTelegramUpdate,
  createTransaction: transactions.createTransaction,
  editTransaction: transactions.editTransaction,
  updateTransaction: transactions.updateTransaction,
  removeTransaction: transactions.removeTransaction,
  accountBalance: transactions.accountBalance,
  seedFrontendExamples: transactions.seedFrontendExamples
};

if (require.main === module) start();
