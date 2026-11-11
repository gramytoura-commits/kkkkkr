const crypto = require('node:crypto');

const STATUSES = ['pending', 'confirmed', 'rejected'];
const ICONS = ['↗', '↘', '🛍', '🎁', '🏦', '↔'];
const FIELDS = ['amount', 'recipient', 'note', 'icon', 'direction', 'date', 'status'];
const COMMANDS = [
  ['start', 'Open transaction manager'], ['transactions', 'Browse and edit all transactions'],
  ['add', 'Create a transaction step by step'], ['pending', 'Manage pending transactions'],
  ['history', 'Browse transaction history'], ['balance', 'View account balance'],
  ['setbalance', 'Change account balance'], ['edit', 'Edit a transaction'],
  ['remove', 'Delete a transaction'], ['transfer', 'Create a confirmed demo transfer'],
  ['search', 'Find transactions by name or note'], ['cancel', 'Cancel the current action'],
  ['logs', 'View audit log'], ['apk', 'Download Android demo APK'],
  ['deploy', 'Notify admins of deployment'], ['addadmin', 'Add an administrator'],
  ['admins', 'List administrators'], ['whoami', 'Show your Chat ID']
].map(([command, description]) => ({ command, description }));

function createTelegramManager(deps) {
  const { telegram, adminChatIds, getTransactions, accountBalance, createTransaction,
    editTransaction, removeTransaction, parseTransferInput, escapeHtml, recordEvent,
    timeZone = 'Europe/Prague' } = deps;
  const sessions = new Map();
  const drafts = new Map();
  const PAGE_SIZE = 6;
  const searches = new Map();
  const button = (text, callback_data) => ({ text, callback_data });
  const menuButton = () => [button('‹ Main menu', 'tm:home')];
  const cancelButton = (token) => [button('Cancel', `tm:cancel:${token}`)];
  const send = (chatId, text, rows = []) => telegram('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {})
  });
  const sessionKey = (chatId, userId) => `${chatId}:${userId}`;
  const find = (id) => {
    const tx = getTransactions().find((item) => item.id === id);
    if (!tx) throw new Error('This transaction no longer exists. Open /transactions to refresh.');
    return tx;
  };
  const money = (tx) => `${tx.direction === 'minus' ? '−' : '+'}${Number(tx.amount).toFixed(2)} EUR`;
  const dateText = (value) => new Intl.DateTimeFormat('en-GB', {
    timeZone, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23'
  }).format(new Date(value));
  const summary = (tx) => `${escapeHtml(tx.icon || '↔')} <b>${escapeHtml(tx.recipient)}</b>\n`
    + `${money(tx)} · ${escapeHtml(tx.status)}\n`
    + `Date: ${escapeHtml(dateText(tx.createdAt))} (${escapeHtml(timeZone)})\n`
    + `Note: ${tx.note ? escapeHtml(tx.note) : '—'}`;

  async function home(chatId) {
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://bless-huntington-encourages-impression.trycloudflare.com/admin/';
    await send(chatId, `<b>Demo Ledger dashboard</b> · Transaction manager\n\nOpen dashboard: <a href="${dashboardUrl}">${dashboardUrl}</a>\n\nBalance: <b>${accountBalance().toFixed(2)} EUR</b>\nManage the demo account here in Telegram or open the dashboard for the full interface.`, [
      [{ text: '🌐 Open dashboard', url: dashboardUrl }],
      [button('＋ Create transaction', 'tm:new')],
      [button('Transactions / edit / delete', 'tm:list:all:0')],
      [button('Pending', 'tm:list:pending:0'), button('History', 'tm:list:history:0')],
      [button('Balance', 'tm:balance'), button('Set balance', 'tm:setbalance')],
      [button('Search', 'tm:search'), button('Help', 'tm:help')]
    ]);
  }

  async function list(chatId, filter = 'all', requestedPage = 0, query = '', searchToken = '') {
    const items = getTransactions().filter((tx) => {
      if (filter === 'history') return tx.status !== 'pending';
      if (STATUSES.includes(filter)) return tx.status === filter;
      if (filter === 'search') return `${tx.recipient} ${tx.note} ${tx.id}`.toLowerCase().includes(query.toLowerCase());
      return true;
    });
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
    const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const rows = visible.map((tx) => [button(`${tx.icon || '↔'} ${tx.recipient.slice(0, 34)} · ${money(tx)} · ${tx.status}`, `tm:view:${tx.id}`)]);
    const navigation = [];
    const pageAction = filter === 'search' ? `tm:results:${searchToken}` : `tm:list:${filter}`;
    if (page > 0) navigation.push(button('‹ Previous', `${pageAction}:${page - 1}`));
    if (page + 1 < pageCount) navigation.push(button('Next ›', `${pageAction}:${page + 1}`));
    if (navigation.length) rows.push(navigation);
    rows.push([button('＋ Create', 'tm:new'), button('Search', 'tm:search')], menuButton());
    await send(chatId, `<b>${filter === 'search' ? 'Search results' : filter === 'all' ? 'Transactions' : `${filter[0].toUpperCase()}${filter.slice(1)} transactions`}</b>\n\n`
      + `${items.length} transactions · Page ${page + 1}/${pageCount}\n`
      + (visible.length ? 'Tap a transaction to edit or delete it.' : 'No transactions found.'), rows);
  }

  async function search(chatId, key, query) {
    const token = crypto.randomBytes(6).toString('hex');
    searches.set(token, { key, query, expiresAt: Date.now() + 30 * 60 * 1000 });
    for (const [oldToken, result] of searches) if (result.expiresAt < Date.now()) searches.delete(oldToken);
    return list(chatId, 'search', 0, query, token);
  }

  async function detail(chatId, id, heading = 'Transaction') {
    const tx = find(id);
    const rows = [
      [button('Edit amount', `tm:edit:${id}:amount`), button('Edit name / text', `tm:edit:${id}:recipient`)],
      [button('Edit note', `tm:edit:${id}:note`), button('Edit date & time', `tm:edit:${id}:date`)],
      [button('Change icon', `tm:edit:${id}:icon`), button('Change + / −', `tm:edit:${id}:direction`)],
      [button('Change status', `tm:edit:${id}:status`)]
    ];
    if (tx.status === 'pending') rows.push([button('✓ Confirm', `tm:status:${id}:confirmed`), button('✕ Reject', `tm:status:${id}:rejected`)]);
    rows.push([button('Delete transaction', `tm:delete:${id}`)], [button('‹ Transactions', 'tm:list:all:0')], menuButton());
    await send(chatId, `<b>${escapeHtml(heading)}</b>\n\n${summary(tx)}\n\nBalance: <b>${accountBalance().toFixed(2)} EUR</b>`, rows);
  }

  function startSession(key, values) {
    const previous = sessions.get(key);
    if (previous) drafts.delete(previous.token);
    const token = crypto.randomBytes(6).toString('hex');
    const session = { ...values, key, token, expiresAt: Date.now() + 30 * 60 * 1000 };
    sessions.set(key, session);
    drafts.set(token, session);
    for (const [oldToken, old] of drafts) {
      if (old.expiresAt < Date.now()) {
        drafts.delete(oldToken);
        if (sessions.get(old.key) === old) sessions.delete(old.key);
      }
    }
    return session;
  }
  function clearSession(session) {
    drafts.delete(session.token);
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }
  function validSession(key, token) {
    const session = drafts.get(token);
    if (!session || session.key !== key || session.expiresAt < Date.now()) throw new Error('This action expired. Start again from /transactions or /add.');
    return session;
  }
  const normalizeAmount = (text, allowZero = false) => {
    const value = String(text).trim().replace(',', '.');
    const amount = Number(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(amount) || amount > 1000000 || (allowZero ? amount < 0 : amount <= 0)) {
      throw new Error(`Enter an amount ${allowZero ? 'from 0' : 'from 0.01'} to 1,000,000 EUR, with up to two decimal places.`);
    }
    return Math.round(amount * 100) / 100;
  };
  function fieldValue(field, text) {
    const value = text.trim();
    if (field === 'amount') return normalizeAmount(value);
    if (field === 'direction') {
      if (!['plus', 'minus', '+', '-'].includes(value)) throw new Error('Choose + Money in or − Money out.');
      return value === '-' || value === 'minus' ? 'minus' : 'plus';
    }
    if (field === 'status') {
      if (!STATUSES.includes(value)) throw new Error('Choose pending, confirmed, or rejected.');
      return value;
    }
    if (field === 'date') {
      const local = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
      if (local) {
        const components = local.slice(1).map(Number);
        const [year, month, day, hour, minute] = components;
        const target = Date.UTC(year, month - 1, day, hour, minute);
        const formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const matches = [];
        for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
          const candidate = new Date(target - offset * 60000);
          const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
          if (['year', 'month', 'day', 'hour', 'minute'].every((part, index) => Number(parts[part]) === components[index])) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error(matches.length ? 'This time occurs twice when clocks change. Include an offset, e.g. +01:00 or +02:00.' : 'Enter a valid date/time. This time may be skipped when clocks change.');
        return matches[0].toISOString();
      }
      // Explicit offsets can disambiguate a time during the autumn clock change.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error('Send date and time with an offset, e.g. 2026-11-10T14:30+01:00 or 2026-11-10T13:30Z.');
      }
      const day = value.slice(0, 10);
      if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('Enter a valid calendar date.');
      return new Date(value).toISOString();
    }
    const limit = { recipient: 120, note: 240, icon: 16 }[field];
    if (!limit || (field !== 'note' && !value) || Array.from(value).length > limit) throw new Error(`Enter ${field === 'note' ? 'up to' : '1 to'} ${limit || 120} characters.`);
    return field === 'note' && value === '-' ? '' : value;
  }

  async function prompt(chatId, session) {
    const field = session.field;
    const token = session.token;
    const choose = (value) => `tm:value:${token}:${field}:${value}`;
    const rows = [];
    const prompts = {
      amount: 'Send the amount in EUR, for example <code>12.50</code>.',
      recipient: 'Send the recipient / transaction text (up to 120 characters).',
      note: 'Send the note (up to 240 characters). Send <code>-</code> to remove the note.',
      icon: 'Choose an icon below or send your own emoji.',
      direction: 'Choose the transaction direction.',
      status: 'Choose the status. Only confirmed transactions affect the balance.',
      date: `Send a date and time in ${escapeHtml(timeZone)}.\nExample: <code>2026-11-10 14:30</code>\nYou can also include an offset: <code>2026-11-10T14:30+01:00</code>.`,
      balance: 'Send the new account balance in EUR, for example <code>100.00</code>.',
      search: 'Send a name, note, or transaction ID to search.'
    };
    if (field === 'direction') rows.push([button('+ Money in', choose('plus')), button('− Money out', choose('minus'))]);
    if (field === 'status') rows.push(STATUSES.map((value) => button(value, choose(value))));
    if (field === 'icon') rows.push(ICONS.map((value, index) => button(value, choose(String(index)))));
    if (field === 'note') rows.push([button('No note', choose('skip'))]);
    if (field === 'date' && session.kind === 'create') rows.push([button('Use current date & time', choose('now'))]);
    rows.push(cancelButton(token));
    const current = session.id ? find(session.id) : null;
    const currentValue = current ? current[field === 'date' ? 'createdAt' : field] : null;
    await send(chatId, `<b>${session.kind === 'create' ? 'Create transaction' : session.kind === 'edit' ? `Edit ${field}` : field === 'balance' ? 'Set balance' : 'Search transactions'}</b>\n\n`
      + (current ? `Current: ${escapeHtml(currentValue || '—')}\n\n` : '') + prompts[field], rows);
  }

  async function acceptValue(chatId, session, text) {
    session.expiresAt = Date.now() + 30 * 60 * 1000;
    if (session.field === 'search') {
      if (!text.trim()) throw new Error('Enter a search term.');
      clearSession(session);
      await search(chatId, session.key, text.trim());
      return;
    }
    if (session.field === 'balance') {
      session.target = normalizeAmount(text, true);
      session.field = 'review';
      await send(chatId, `<b>Set balance to ${session.target.toFixed(2)} EUR?</b>\nCurrent balance: ${accountBalance().toFixed(2)} EUR\nThis records a balance adjustment.`, [
        [button('Save balance', `tm:save:${session.token}`)], cancelButton(session.token)
      ]);
      return;
    }
    const value = session.field === 'date' && text === 'now' ? new Date().toISOString() : fieldValue(session.field, text);
    if (session.kind === 'edit') {
      const tx = editTransaction(session.id, { [session.field === 'date' ? 'createdAt' : session.field]: value }, session.actor);
      clearSession(session);
      await detail(chatId, tx.id, 'Transaction updated');
      return;
    }
    session.input[session.field === 'date' ? 'createdAt' : session.field] = value;
    const order = ['direction', 'amount', 'recipient', 'note', 'icon', 'date', 'status'];
    session.field = order[order.indexOf(session.field) + 1] || 'review';
    if (session.field !== 'review') return prompt(chatId, session);
    await send(chatId, `<b>Save this transaction?</b>\n\n${summary(session.input)}`, [
      [button('Save transaction', `tm:save:${session.token}`)], cancelButton(session.token)
    ]);
  }

  async function setBalance(chatId, target, actor) {
    const delta = Math.round((target - accountBalance()) * 100) / 100;
    if (delta !== 0) {
      const tx = createTransaction({ amount: Math.abs(delta), recipient: 'Balance adjustment',
        direction: delta < 0 ? 'minus' : 'plus', note: `Set balance to ${target.toFixed(2)} EUR` }, actor, { notify: false });
      editTransaction(tx.id, { status: 'confirmed' }, actor);
      recordEvent('balance.adjusted', { transactionId: tx.id, actor, targetBalance: target });
    }
    await send(chatId, `<b>Balance: ${accountBalance().toFixed(2)} EUR</b>`, [menuButton()]);
  }

  async function askDelete(chatId, key, id, actor) {
    const tx = find(id);
    const session = startSession(key, { kind: 'delete', id, actor, field: 'review' });
    await send(chatId, `<b>Delete this transaction?</b>\n\n${summary(tx)}\n\nDeleting a confirmed transaction updates the balance.`, [
      [button('Yes, delete', `tm:save:${session.token}`)], cancelButton(session.token)
    ]);
  }

  async function handleCallback(chatId, key, actor, data) {
    const [, action, target, extra, selectedValue] = data.split(':');
    if (action === 'home') {
      const active = sessions.get(key);
      if (active) clearSession(active);
      return home(chatId);
    }
    if (action === 'list') return list(chatId, target, extra);
    if (action === 'results') {
      const result = searches.get(target);
      if (!result || result.key !== key || result.expiresAt < Date.now()) throw new Error('Search expired. Use /search again.');
      return list(chatId, 'search', extra, result.query, target);
    }
    if (action === 'view') return detail(chatId, target);
    if (action === 'balance') return send(chatId, `<b>Balance: ${accountBalance().toFixed(2)} EUR</b>`, [[button('Set balance', 'tm:setbalance')], menuButton()]);
    if (action === 'help') return send(chatId, '<b>Manage everything in Telegram</b>\n\nOpen /transactions, tap a transaction, then choose what to edit. You can change its amount, name, note, icon, direction, date/time, and status, or delete it.\n\n/add — guided creation\n/setbalance — guided balance change\n/search — find a transaction\n/cancel — cancel an action\n\nShortcuts:\n<code>/transfer + 25 "Beneficiary Name" note</code>\n<code>/edit tx_... note Updated text</code>\n<code>/edit tx_... date 2026-11-10T14:30+01:00</code>\n<code>/remove tx_...</code>\n\n/apk · /logs · /admins · /addadmin · /whoami', [menuButton()]);
    if (action === 'new' || action === 'setbalance' || action === 'search') {
      const kind = action === 'new' ? 'create' : action;
      const field = action === 'new' ? 'direction' : action === 'setbalance' ? 'balance' : 'search';
      return prompt(chatId, startSession(key, { kind, field, input: {}, actor }));
    }
    if (action === 'edit') {
      find(target);
      if (!FIELDS.includes(extra)) throw new Error('Unknown transaction field.');
      return prompt(chatId, startSession(key, { kind: 'edit', id: target, field: extra, actor }));
    }
    if (action === 'status') {
      const tx = find(target);
      if (tx.status !== 'pending') throw new Error('This transaction was already handled. Open it again to change its status.');
      editTransaction(target, { status: fieldValue('status', extra) }, actor);
      return detail(chatId, target, 'Status updated');
    }
    if (action === 'delete') return askDelete(chatId, key, target, actor);
    const session = validSession(key, target);
    if (action === 'cancel') {
      clearSession(session);
      return home(chatId);
    }
    if (action === 'value') {
      if (session.field !== extra || session.field === 'review') throw new Error('That step is already complete. Use the most recent prompt.');
      const value = session.field === 'icon' ? ICONS[Number(selectedValue)] : selectedValue === 'skip' && session.field === 'note' ? '-' : selectedValue;
      if (value === undefined) throw new Error('Choose a valid value.');
      return acceptValue(chatId, session, value);
    }
    if (action !== 'save' || session.field !== 'review') throw new Error('This action is no longer available.');
    // Consume before sending messages so a repeated click cannot apply a mutation twice.
    clearSession(session);
    if (session.kind === 'delete') {
      removeTransaction(session.id, actor);
      return send(chatId, `<b>Transaction deleted</b>\nBalance: ${accountBalance().toFixed(2)} EUR`, [[button('‹ Transactions', 'tm:list:all:0')], menuButton()]);
    }
    if (session.kind === 'setbalance') return setBalance(chatId, session.target, actor);
    if (session.kind !== 'create') throw new Error('Unknown action.');
    const tx = createTransaction(session.input, actor, { notify: false });
    if (session.input.createdAt) editTransaction(tx.id, { createdAt: session.input.createdAt }, actor);
    if (session.input.status !== 'pending') editTransaction(tx.id, { status: session.input.status }, actor);
    return detail(chatId, tx.id, 'Transaction created');
  }

  async function handleUpdate(update) {
    const callback = update.callback_query;
    const message = update.message;
    const chatId = String(callback?.message?.chat?.id ?? message?.chat?.id ?? '');
    const userId = String(callback?.from?.id ?? message?.from?.id ?? chatId);
    const key = sessionKey(chatId, userId);
    const actor = `telegram:${userId}`;
    if (!adminChatIds.has(chatId)) {
      if (callback) await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Administrator access required.', show_alert: true });
      return false;
    }
    if (callback) {
      // Keep notification buttons sent by older backend versions usable.
      let data = String(callback.data || '');
      if (/^(confirm|reject):/.test(data)) {
        const [action, id] = data.split(':');
        data = `tm:status:${id}:${action === 'confirm' ? 'confirmed' : 'rejected'}`;
      } else if (data.startsWith('worker:')) data = 'tm:home';
      else if (data === 'list:logs') return false;
      else if (data.startsWith('list:')) data = `tm:list:${data.split(':')[1]}:0`;
      else if (data === 'menu:transfer') data = 'tm:new';
      else if (['menu:balance', 'menu:setbalance', 'menu:help'].includes(data)) data = `tm:${data.split(':')[1]}`;
      if (!data.startsWith('tm:')) return false;
      await telegram('answerCallbackQuery', { callback_query_id: callback.id });
      try { await handleCallback(chatId, key, actor, data); }
      catch (error) { await send(chatId, escapeHtml(error.message), [menuButton()]); }
      return true;
    }
    if (!message?.text) return false;
    const text = message.text.trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@\w+$/, '');
    try {
      if (['/start', '/help', '/manage', '/menu'].includes(command)) {
        const active = sessions.get(key);
        if (active) clearSession(active);
        await home(chatId);
      } else if (command === '/cancel') {
        const active = sessions.get(key);
        if (active) clearSession(active);
        await home(chatId);
      } else if (['/transactions', '/pending', '/history', '/past'].includes(command)) {
        await list(chatId, command === '/pending' ? 'pending' : ['/history', '/past'].includes(command) ? 'history' : 'all', Number(args[0] || 1) - 1);
      } else if (command === '/balance') {
        await handleCallback(chatId, key, actor, 'tm:balance');
      } else if (command === '/setbalance') {
        if (args.length) await setBalance(chatId, normalizeAmount(args[0], true), actor);
        else await handleCallback(chatId, key, actor, 'tm:setbalance');
      } else if (command === '/search') {
        if (args.length) await search(chatId, key, args.join(' '));
        else await handleCallback(chatId, key, actor, 'tm:search');
      } else if (['/add', '/transfer'].includes(command)) {
        if (!args.length) await handleCallback(chatId, key, actor, 'tm:new');
        else {
          const input = parseTransferInput(args);
          input.amount = normalizeAmount(input.amount);
          const tx = createTransaction(input, actor, { notify: false });
          if (command === '/transfer') editTransaction(tx.id, { status: 'confirmed' }, actor);
          await detail(chatId, tx.id, 'Transaction created');
        }
      } else if (['/transaction', '/edit'].includes(command)) {
        if (!args[0]) await list(chatId);
        else if (command === '/edit' && args[1]) {
          const [id, field, ...value] = args;
          if (!FIELDS.includes(field)) throw new Error(`Choose a field: ${FIELDS.join(', ')}.`);
          if (value.length) {
            editTransaction(id, { [field === 'date' ? 'createdAt' : field]: fieldValue(field, value.join(' ')) }, actor);
            await detail(chatId, id, 'Transaction updated');
          } else await handleCallback(chatId, key, actor, `tm:edit:${id}:${field}`);
        } else await detail(chatId, args[0]);
      } else if (['/remove', '/delete'].includes(command)) {
        if (!args[0]) await list(chatId);
        else await askDelete(chatId, key, args[0], actor);
      } else if (['/confirm', '/reject'].includes(command)) {
        await handleCallback(chatId, key, actor, `tm:status:${args[0]}:${command === '/confirm' ? 'confirmed' : 'rejected'}`);
      } else if (command === '/deploy') {
        const name = args.join(' ') || 'Backend';
        const time = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
        const msg = `🚀 *${name}* deployed\n\n⏰ ${time}`;
        try {
          for (const id of adminChatIds) {
            await telegram('sendMessage', { chat_id: id, text: msg, parse_mode: 'Markdown' }).catch(() => {});
          }
          await send(chatId, '✅ Deployment notification sent to all admins', [menuButton()]);
        } catch (e) {
          await send(chatId, '❌ Failed to send deployment notification', [menuButton()]);
        }
        recordEvent('deployment.notified', { actor, deploymentName: name });
      } else if (!text.startsWith('/')) {
        const active = sessions.get(key);
        if (!active) await home(chatId);
        else {
          validSession(key, active.token);
          if (active.field === 'review') throw new Error('Use the Save or Cancel button above.');
          await acceptValue(chatId, active, text);
        }
      } else return false;
    } catch (error) { await send(chatId, escapeHtml(error.message), [menuButton()]); }
    return true;
  }
  return { handleUpdate, home };
}

module.exports = { createTelegramManager, COMMANDS };
