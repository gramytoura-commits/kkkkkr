'use strict';
const $ = (selector) => document.querySelector(selector);
const state = { key: '', base: '', transactions: [], events: [], apps: [], groups: [], activeAppId: '', globalOrder: JSON.parse(localStorage.getItem('demo-ledger-order') || '[]'), balance: 0, filter: 'all', query: '', page: 0, view: 'transactions', editingId: null, deletingId: null, connected: false, busy: false, dark: localStorage.getItem('demo-ledger-theme') !== 'light' };
const PAGE_SIZE = 12;
let telegramAttempt;
const authorization = () => `${state.telegram ? 'Dashboard' : 'Bearer'} ${state.key}`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(value);
const date = (value) => new Date(value).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
let noticeTimer;
function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = `visible${error ? ' error' : ''}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('#notice').className = '', 5500);
}
async function request(path, options = {}) {
  const response = await fetch(`${state.base}${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: { authorization: authorization(), 'content-type': 'application/json' } });
  let result;
  try { result = await response.json(); } catch { throw new Error('The backend returned an invalid response. Check the address.'); }
  if (!response.ok) {
    if (response.status === 401) {
      if (state.telegram) {
        if (state.connected) disconnectDashboard();
        throw new Error('Your Telegram session expired. Sign in again.');
      }
      throw new Error('The backend key was not accepted.');
    }
    if (response.status === 404 && path.startsWith('/admin-api')) throw new Error('This backend needs the dashboard update before this action is available.');
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result;
}
function render() {
  renderApps();
  renderGroups();
  const activeApp = state.apps.find((app) => app.id === state.activeAppId) || null;
  renderProfilePanel(activeApp);
  const knownIds = new Set(state.transactions.map((tx) => tx.id));
  state.globalOrder = [...state.globalOrder.filter((id) => knownIds.has(id)), ...state.transactions.map((tx) => tx.id).filter((id) => !state.globalOrder.includes(id))];
  localStorage.setItem('demo-ledger-order', JSON.stringify(state.globalOrder));
  const appOrder = activeApp ? activeApp.transactionIds : state.globalOrder;
  const ordered = appOrder.map((id) => state.transactions.find((tx) => tx.id === id)).filter(Boolean);
  const confirmed = ordered.filter((tx) => tx.status === 'confirmed');
  state.balance = confirmed.reduce((sum, tx) => sum + (tx.direction === 'minus' ? -Number(tx.amount) : Number(tx.amount)), 0);
  $('#balance').textContent = money(state.balance);
  $('#moneyIn').textContent = money(confirmed.filter((tx) => tx.direction === 'plus').reduce((sum, tx) => sum + Number(tx.amount), 0));
  $('#moneyOut').textContent = money(confirmed.filter((tx) => tx.direction === 'minus').reduce((sum, tx) => sum + Number(tx.amount), 0));
  $('#pendingCount').textContent = ordered.filter((tx) => tx.status === 'pending').length;
  $('#orderHint').textContent = activeApp ? `Showing ${activeApp.label || 'this app'} · drag rows or use ↑ ↓ to change its order.` : 'Drag rows or use ↑ ↓ to change the general order.';
  const filtered = ordered.filter((tx) => (state.filter === 'all' || tx.status === state.filter) && `${tx.recipient} ${tx.note} ${tx.amount}`.toLowerCase().includes(state.query));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const visible = filtered.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  $('#transactionRows').innerHTML = visible.length ? visible.map((tx) => `<tr draggable="true" data-row-id="${escape(tx.id)}"><td><div class="transaction"><span class="drag-handle" title="Drag to reorder">⠿</span><span class="tx-icon">${escape(tx.icon || (tx.direction === 'minus' ? '↘' : '↗'))}</span><div class="tx-copy"><strong>${escape(tx.recipient)}</strong><small>${escape(tx.note || 'No note')}</small></div></div></td><td>${escape(date(tx.createdAt))}</td><td><span class="status ${['pending', 'confirmed', 'rejected'].includes(tx.status) ? tx.status : ''}">${escape(tx.status)}</span></td><td class="right amount ${tx.direction === 'plus' ? 'incoming' : ''}">${tx.direction === 'minus' ? '−' : '+'}${money(tx.amount)}</td><td><div class="actions"><button data-move="up" data-id="${escape(tx.id)}" ${ordered[0]?.id !== tx.id ? '' : 'disabled'}>↑</button><button data-move="down" data-id="${escape(tx.id)}" ${ordered[ordered.length - 1]?.id !== tx.id ? '' : 'disabled'}>↓</button><button data-edit="${escape(tx.id)}">Edit</button><button class="remove" data-delete="${escape(tx.id)}">Delete</button></div></td></tr>`).join('') : '<tr><td class="empty" colspan="5">No transactions found. Create one or change your search.</td></tr>';
  $('#resultCount').textContent = `${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`;
  $('#pageCount').textContent = `${state.page + 1} / ${pages}`;
  $('#previous').disabled = state.page === 0;
  $('#next').disabled = state.page >= pages - 1;
  $('#auditRows').innerHTML = state.events.length ? state.events.map((event) => `<article class="audit-entry"><time>${escape(date(event.createdAt))}</time><div><b>${escape(event.type)}</b><small>${escape([event.actor || event.source, event.transactionId, event.appId].filter(Boolean).join(' · '))}</small></div></article>`).join('') : '<div class="empty">No activity recorded yet.</div>';
}
async function refresh(connecting = false) {
  if ((!state.connected && !connecting) || state.busy) return;
  const activeAuthorization = authorization();
  const [account, ledger, audit, apps, groups] = await Promise.all([request('/account'), request('/transactions'), request('/logs'), request('/admin-api/apps'), request('/admin-api/groups')]);
  if (authorization() !== activeAuthorization || (!state.connected && !connecting)) return;
  state.apps=apps.apps||[];
  state.groups=groups.groups||[];
  if (state.activeAppId && !state.apps.some((app) => app.id === state.activeAppId)) state.activeAppId = '';
  renderAppSelector();
  state.transactions = ledger.transactions || [];
  state.balance = Number(account.balance || 0);
  state.events = audit.events || [];
  render();
  $('#connectionState').textContent = 'Connected';
}
function localInput(value) {
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function edit(tx) {
  state.editingId = tx?.id || null;
  const form = $('#transactionForm');
  form.reset();
  $('#editorTitle').textContent = tx ? 'Edit transaction' : 'New transaction';
  $('#editorError').textContent = '';
  const values = { recipient: '', amount: '', direction: 'plus', status: 'confirmed', icon: '↗', note: '', iban: '', bankName: '', bic: '', ...tx, createdAt: localInput(tx?.createdAt || new Date()) };
  for (const [key, value] of Object.entries(values)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  document.querySelectorAll('#iconPicker [data-icon]').forEach((button) => button.classList.toggle('selected', button.dataset.icon === values.icon));
  $('#editor').showModal();
}
async function mutation(form, errorSelector, action, success) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => button.disabled = true);
  $(errorSelector).textContent = '';
  let applied = false;
  let result;
  try {
    result = await action();
    applied = true;
    form.closest('dialog').close();
    notice(success);
  } catch (error) { $(errorSelector).textContent = error.message; }
  finally { state.busy = false; buttons.forEach((button) => button.disabled = false); }
  if (applied) {
    try { await refresh(); }
    catch { notice('Saved. The latest list could not load; use Refresh.', true); }
  }
  return result;
}
$('#timeZone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
try { const savedId = localStorage.getItem('demo-ledger-tgid'); if (savedId) $('#telegramIdInput').value = savedId; } catch {}

async function connectDashboard(base, key, telegram = false) {
  const submit = $('#connectForm button[type="submit"]');
  state.base = base;
  state.key = key;
  state.telegram = telegram;
  if (submit) submit.disabled = true;
  $('#telegramLogin').disabled = true;
  try { await refresh(true); }
  finally {
    if (submit) submit.disabled = false;
    $('#telegramLogin').disabled = false;
  }
  state.connected = true;
  $('#login').hidden = true;
  $('#dashboard').hidden = false;
  $('#newTransaction').disabled = false;
  $('#newProfile').disabled = false;
  $('#sectionNewProfile').disabled = false;
  $('#disconnect').hidden = false;
  document.body.classList.add('connected');
  notice('Backend connected');
}

async function telegramRequest(path, auth) {
  const response = await fetch(path, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: auth ? { authorization: auth } : {}
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Telegram sign-in is unavailable.');
  return result;
}

function resetTelegramAttempt() {
  telegramAttempt = undefined;
  $('#telegramLogin').disabled = false;
  $('#telegramLogin').hidden = false;
  $('#telegramOpen').hidden = true;
  $('#telegramOpen').removeAttribute('href');
  $('#telegramStatus').hidden = true;
}

$('#telegramLogin').addEventListener('click', async () => {
  const status = $('#telegramStatus');
  const attempt = {};
  telegramAttempt = attempt;
  $('#telegramLogin').disabled = true;
  status.hidden = false;
  status.textContent = 'Opening Telegram sign-in…';
  try {
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      throw new Error('Open the dashboard over HTTPS to sign in with Telegram.');
    }
    const userId = $('#telegramIdInput').value.trim();
    if (!userId) {
      throw new Error('Please enter your Telegram ID.');
    }
    try { localStorage.setItem('demo-ledger-tgid', userId); } catch {}
    const endpoint = `/admin-auth/telegram?userId=${encodeURIComponent(userId)}`;
    const login = await telegramRequest(endpoint);
    if (telegramAttempt !== attempt) return;
    $('#telegramOpen').href = login.telegramUrl;
    $('#telegramOpen').hidden = false;
    $('#telegramLogin').hidden = true;
    window.open(login.telegramUrl, '_blank', 'noopener');
    status.textContent = `Code ${login.code}. If Telegram didn't open, tap "Open Telegram" below, then confirm there and return here.`;

    while (telegramAttempt === attempt) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (telegramAttempt !== attempt) return;
      const result = await telegramRequest('/admin-auth/telegram/status', `Login ${login.browserToken}`);
      if (telegramAttempt !== attempt) return;
      if (result.status === 'approved') {
        await connectDashboard(location.origin, result.token, true);
        resetTelegramAttempt();
        return;
      }
      if (result.status === 'denied') throw new Error('Sign-in was declined.');
      if (result.status === 'expired') throw new Error('Sign-in expired. Start a new request.');
    }
  } catch (error) {
    if (telegramAttempt !== attempt) return;
    state.key = '';
    state.telegram = false;
    resetTelegramAttempt();
    status.hidden = false;
    status.textContent = error.message;
  }
});

function disconnectDashboard() {
  resetTelegramAttempt();
  state.key = ''; state.connected = false; state.transactions = []; state.events = []; state.balance = 0;
  state.telegram = false; state.apps = []; state.activeAppId = '';
  renderAppSelector();
  render();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  $('#login').hidden = false; $('#dashboard').hidden = true; $('#disconnect').hidden = true; $('#newTransaction').disabled = true; $('#newProfile').disabled = true; $('#sectionNewProfile').disabled = true;
  $('#connectionState').textContent = 'Not connected'; document.body.classList.remove('connected');
}
$('#disconnect').addEventListener('click', () => {
  if (state.telegram) telegramRequest('/admin-auth/logout', authorization()).catch(() => {});
  disconnectDashboard();
});
$('#newTransaction').addEventListener('click', () => edit());
$('#transactionForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  values.amount = Number(values.amount);
  values.createdAt = new Date(values.createdAt).toISOString();
  if (!state.editingId && state.activeAppId) values.appId = state.activeAppId;
  mutation(event.target, '#editorError', () => request(state.editingId ? `/admin-api/transactions/${encodeURIComponent(state.editingId)}` : '/admin-api/transactions', { method: state.editingId ? 'PATCH' : 'POST', body: JSON.stringify(values) }), 'Transaction saved');
});
$('#transactionRows').addEventListener('click', (event) => {
  const moveButton = event.target.closest('[data-move]');
  if (moveButton) return moveTransaction(moveButton.dataset.id, moveButton.dataset.move);
  const editButton = event.target.closest('[data-edit]');
  if (editButton) return edit(state.transactions.find((tx) => tx.id === editButton.dataset.edit));
  const remove = event.target.closest('[data-delete]');
  if (remove) {
    const tx = state.transactions.find((item) => item.id === remove.dataset.delete);
    state.deletingId = tx.id;
    $('#deleteDescription').textContent = `${tx.recipient} · ${tx.direction === 'minus' ? '−' : '+'}${money(tx.amount)}`;
    $('#deleteError').textContent = '';
    $('#deleteDialog').showModal();
  }
});
$('#deleteForm').addEventListener('submit', (event) => { event.preventDefault(); mutation(event.target, '#deleteError', () => request(`/transactions/${encodeURIComponent(state.deletingId)}`, { method: 'DELETE' }), 'Transaction deleted'); });
$('#setBalance').addEventListener('click', () => { $('#balanceTarget').value = state.balance.toFixed(2); $('#balanceError').textContent = ''; $('#balanceDialog').showModal(); });
$('#balanceForm').addEventListener('submit', (event) => { event.preventDefault(); mutation(event.target, '#balanceError', () => request('/admin-api/balance', { method: 'POST', body: JSON.stringify({ balance: Number($('#balanceTarget').value) }) }), 'Balance updated'); });
document.querySelectorAll('#iconPicker [data-icon]').forEach((button) => button.addEventListener('click', () => { $('#transactionForm').elements.icon.value = button.dataset.icon; document.querySelectorAll('#iconPicker [data-icon]').forEach((item) => item.classList.toggle('selected', item === button)); }));
$('#appSelect').addEventListener('change', (event) => { state.activeAppId = event.target.value; state.page = 0; state.filter = 'all'; document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('selected', item.dataset.filter === 'all')); render(); });
$('#themeToggle').addEventListener('click', () => { state.dark = !state.dark; applyTheme(); });
$('#pingBackend').addEventListener('click', async () => { const consoleEl=$('#pingConsole'); consoleEl.hidden=false; const started=performance.now(); consoleEl.textContent='Pinging backend…'; try { const result=await request('/health'); consoleEl.textContent=`${new Date().toLocaleTimeString()}  OK  ${Math.round(performance.now()-started)} ms\n${JSON.stringify(result,null,2)}`; } catch(error) { consoleEl.textContent=`${new Date().toLocaleTimeString()}  ERROR\n${error.message}`; } });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => { if (!state.busy) document.getElementById(button.dataset.close).close(); }));
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; state.page = 0; document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('selected', item === button)); render(); }));
$('#search').addEventListener('input', (event) => { state.query = event.target.value.toLowerCase().trim(); state.page = 0; render(); });
$('#previous').addEventListener('click', () => { state.page--; render(); });
$('#next').addEventListener('click', () => { state.page++; render(); });
for (const id of ['#refresh', '#refreshAudit']) $(id).addEventListener('click', () => refresh().catch((error) => notice(error.message, true)));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  $('#pageTitle').textContent = state.view === 'audit' ? 'Audit log' : 'Transactions';
  $('#transactionsPanel').hidden = state.view !== 'transactions'; $('#auditPanel').hidden = state.view !== 'audit';
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item === button));
}));
setInterval(() => { if (state.connected && !document.hidden && !document.querySelector('dialog[open]')) refresh().catch(() => { $('#connectionState').textContent = 'Connection interrupted'; }); }, 15000);

function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  localStorage.setItem('demo-ledger-theme', state.dark ? 'dark' : 'light');
  $('#themeToggle').textContent = state.dark ? '☀ Light mode' : '◐ Dark mode';
  $('#themeToggle').setAttribute('aria-label', state.dark ? 'Switch to light mode' : 'Switch to dark mode');
}
function renderAppSelector() {
  const select = $('#appSelect');
  if (!select) return;
  select.disabled = !state.apps.length;
  select.innerHTML = '<option value="">All transactions</option>' + state.apps.map((app) => `<option value="${escape(app.id)}">${escape(app.label || 'Setup required')} · ${app.transactionIds.length} shown</option>`).join('');
  select.value = state.activeAppId;
}
function renderProfilePanel(app) {
  const panel = $('#profilePanel'); if (!panel) return;
  if (!app) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = `<strong>${escape(app.label || 'Setup required')}</strong><small>DEMO test profile · no personal or bank details</small>`;
}
async function saveAppOrder(app, ids) {
  await request(`/admin-api/apps/${encodeURIComponent(app.id)}`, { method: 'PUT', body: JSON.stringify({ label: app.label, transactionIds: ids }) });
  app.transactionIds = ids;
  notice('Transaction order saved');
}
async function moveTransaction(id, direction) {
  const app = state.apps.find((item) => item.id === state.activeAppId);
  const ids = app ? [...app.transactionIds] : [...state.globalOrder];
  const index = ids.indexOf(id); if (index < 0) return;
  const next = direction === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= ids.length) return;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  try { if (app) await saveAppOrder(app, ids); else { state.globalOrder = ids; localStorage.setItem('demo-ledger-order', JSON.stringify(ids)); notice('General transaction order saved'); } render(); } catch (error) { notice(error.message, true); }
}
let draggedId = '';
$('#transactionRows').addEventListener('dragstart', (event) => { const row = event.target.closest('tr[data-row-id]'); draggedId = row?.dataset.rowId || ''; row?.classList.add('dragging'); });
$('#transactionRows').addEventListener('dragover', (event) => { const row = event.target.closest('tr[data-row-id]'); if (row && draggedId) { event.preventDefault(); row.classList.add('drag-over'); } });
$('#transactionRows').addEventListener('dragleave', (event) => event.target.closest('tr[data-row-id]')?.classList.remove('drag-over'));
$('#transactionRows').addEventListener('dragend', (event) => { event.target.closest('tr[data-row-id]')?.classList.remove('dragging'); draggedId = ''; });
$('#transactionRows').addEventListener('drop', async (event) => {
  event.preventDefault();
  const target = event.target.closest('tr[data-row-id]');
  document.querySelectorAll('#transactionRows tr').forEach((row) => row.classList.remove('drag-over', 'dragging'));
  const app = state.apps.find((item) => item.id === state.activeAppId);
  if (!target || !draggedId || draggedId === target.dataset.rowId) return;
  const ids = app ? [...app.transactionIds] : [...state.globalOrder]; const from = ids.indexOf(draggedId); const to = ids.indexOf(target.dataset.rowId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1); ids.splice(to, 0, draggedId);
  draggedId = '';
  try { if (app) await saveAppOrder(app, ids); else { state.globalOrder = ids; localStorage.setItem('demo-ledger-order', JSON.stringify(ids)); notice('General transaction order saved'); } render(); } catch (error) { notice(error.message, true); }
});
applyTheme();

const groupsSection=document.createElement('section');groupsSection.className='card';groupsSection.style.cssText='padding:24px;margin-bottom:24px';groupsSection.innerHTML='<div class="toolbar"><div><h2 style="margin-top:0">Shared accounts</h2><p class="hint">An account owns the shared transactions, balance and currency. Apps in the same account show the same data.</p></div><button id="newGroupButton" class="primary" type="button">＋ New account</button></div><div id="groupRows"></div>';
const appsSection=document.createElement('section');appsSection.className='card';appsSection.style.cssText='padding:24px;margin-bottom:24px';appsSection.innerHTML='<div class="toolbar"><div><h2 style="margin-top:0">Connected apps</h2><p class="hint">Each app has its own identity, bank details and status, and belongs to one account.</p></div><button id="sectionNewProfile" class="primary" type="button">＋ New app</button></div><div id="appRows"></div>';
document.querySelector('.stats').before(groupsSection);groupsSection.after(appsSection);
const groupDialog=document.createElement('dialog');groupDialog.id='groupDialog';groupDialog.innerHTML='<form id="groupForm"><h2 id="groupDialogTitle">New account</h2><label>Account name<input name="name" required minlength="2" maxlength="80" placeholder="e.g. Main account"></label><div class="form-grid"><label>Currency<input name="currency" maxlength="8" placeholder="EUR" value="EUR"></label><label>Balance override <span class="optional">blank = auto</span><input name="balanceOverride" type="number" step="0.01" placeholder="Auto from transactions"></label></div><h3>Transactions in this account</h3><p class="hint">Every app in this account shows these transactions and this balance.</p><div id="groupTransactions" style="max-height:240px;overflow:auto"></div><p class="form-error" id="groupError"></p><div class="dialog-footer"><button type="button" id="cancelGroup">Cancel</button><button class="primary" id="saveGroupButton">Save account</button></div></form>';document.body.appendChild(groupDialog);
const appDialog=document.createElement('dialog');appDialog.id='appDialog';appDialog.innerHTML='<form id="appForm"><h2 id="appDialogTitle">New app</h2><label>App label<input name="label" required minlength="3" maxlength="60" placeholder="e.g. Pixel 7 test device"></label><label>Account<select name="groupId" id="appGroupSelect"></select></label><h3>User details</h3><label>Full name<input name="fullName" maxlength="200" placeholder="e.g. John Doe"></label><label>Email<input name="email" type="email" maxlength="200" placeholder="user@example.com"></label><label>Phone number<input name="phone" type="tel" maxlength="50" placeholder="+49 123 456789"></label><label>IBAN<input name="iban" maxlength="50" placeholder="DE35 1001 0300 0000 2990 22"></label><label>Beneficiary name<input name="beneficiaryName" maxlength="200" placeholder="Full name for transfers"></label><label>Address<input name="address" maxlength="500" placeholder="Street, city, country"></label><div class="form-grid"><label>Date of birth<input name="dateOfBirth" type="date" maxlength="20"></label><label>Tax ID<input name="taxId" maxlength="100" placeholder="Tax ID or VAT number"></label></div><h3>Bank details</h3><label>Bank name<input name="bankName" maxlength="120" placeholder="e.g. Revolut"></label><div class="form-grid"><label>BIC / SWIFT<input name="bic" maxlength="16" placeholder="REVOLT21"></label><label>Account holder<input name="accountHolder" maxlength="200" placeholder="Name on the account"></label></div><h3>Status</h3><label>App status<select name="status"><option value="active">Active</option><option value="paused">Paused</option></select></label><p class="form-error" id="appError"></p><div class="dialog-footer"><button type="button" id="cancelApp">Cancel</button><button class="primary" id="saveAppButton">Save app and generate APK</button></div></form>';document.body.appendChild(appDialog);
let editingApp='';let editingGroup='';
function renderAppGroupSelect(selectedId){const sel=document.querySelector('#appGroupSelect');if(!sel)return;sel.innerHTML='<option value="">＋ New independent account</option>'+(state.groups||[]).map(g=>'<option value="'+escape(g.id)+'">'+escape(g.name||'Account')+' · '+money(g.balance||0)+' '+escape(g.currency||'')+' · '+g.appCount+' app'+(g.appCount===1?'':'s')+'</option>').join('');sel.value=selectedId||'';}
function groupTransactionList(group){document.querySelector('#groupTransactions').innerHTML=state.transactions.map(tx=>'<label style="display:flex;flex-direction:row;align-items:center;gap:12px"><input style="flex:none" type="checkbox" name="transactionIds" value="'+escape(tx.id)+'" '+(group?.transactionIds?.includes(tx.id)?'checked':'')+'><span>'+escape(tx.recipient)+' · '+escape(money(tx.amount))+' · '+escape(tx.status)+'</span></label>').join('')||'<p>No transactions yet. Create transactions first, then add them here.</p>';}
function openNewProfile(){editingApp='';const form=document.querySelector('#appForm');form.reset();form.elements.status.value='active';document.querySelector('#appDialogTitle').textContent='New app';document.querySelector('#saveAppButton').textContent='Save app and generate APK';renderAppGroupSelect('');document.querySelector('#appError').textContent='';appDialog.showModal();}
function openAppEditor(app){editingApp=app.id;const form=document.querySelector('#appForm');const profile=app.profile||{};form.elements.label.value=app.label||'';form.elements.fullName.value=profile.fullName||'';form.elements.email.value=profile.email||'';form.elements.phone.value=profile.phone||'';form.elements.iban.value=profile.iban||'';form.elements.beneficiaryName.value=profile.beneficiaryName||'';form.elements.address.value=profile.address||'';form.elements.dateOfBirth.value=profile.dateOfBirth||'';form.elements.taxId.value=profile.taxId||'';form.elements.bankName.value=app.bankName||'';form.elements.bic.value=app.bic||'';form.elements.accountHolder.value=app.accountHolder||'';form.elements.status.value=app.status||'active';renderAppGroupSelect(app.groupId||'');document.querySelector('#appDialogTitle').textContent='Edit app';document.querySelector('#saveAppButton').textContent='Save app';document.querySelector('#appError').textContent='';appDialog.showModal();}
function openNewGroup(){editingGroup='';const form=document.querySelector('#groupForm');form.reset();form.elements.currency.value='EUR';document.querySelector('#groupDialogTitle').textContent='New account';groupTransactionList(null);document.querySelector('#groupError').textContent='';groupDialog.showModal();}
function openGroupEditor(group){editingGroup=group.id;const form=document.querySelector('#groupForm');form.elements.name.value=group.name||'';form.elements.currency.value=group.currency||'EUR';form.elements.balanceOverride.value=(group.balanceOverride!==null&&group.balanceOverride!==undefined)?group.balanceOverride:'';document.querySelector('#groupDialogTitle').textContent='Edit account';groupTransactionList(group);document.querySelector('#groupError').textContent='';groupDialog.showModal();}
function renderApps(){const list=document.querySelector('#appRows');if(!list)return;list.innerHTML=(state.apps||[]).map(app=>{const statusColor=app.status==='paused'?'#b4690e':'#1a7f37';const bank=[app.bankName,app.bic].filter(Boolean).join(' · ');return '<div class="app-row"><div><strong>'+escape(app.label||'Setup required')+'</strong><small>'+escape(app.groupName||'No account')+' · '+money(app.balance||0)+' '+escape(app.currency||'')+' · <span style="color:'+statusColor+'">●</span> '+escape(app.status||'active')+(bank?' · '+escape(bank):'')+'</small></div><div class="app-row-actions"><button data-configure-app="'+escape(app.id)+'">'+(app.configured?'Edit':'Configure')+'</button><button data-download-app="'+escape(app.id)+'">APK</button></div></div>';}).join('')||'<p class="hint">Create an app or open the updated Android app to connect it.</p>';}
function renderGroups(){const list=document.querySelector('#groupRows');if(!list)return;list.innerHTML=(state.groups||[]).map(g=>{const override=g.balanceOverride!==null&&g.balanceOverride!==undefined;return '<div class="app-row"><div><strong>'+escape(g.name||'Account')+'</strong><small>'+money(g.balance||0)+' '+escape(g.currency||'')+(override?' (manual)':'')+' · '+g.transactionIds.length+' transaction'+(g.transactionIds.length===1?'':'s')+' · '+g.appCount+' app'+(g.appCount===1?'':'s')+'</small></div><div class="app-row-actions"><button data-edit-group="'+escape(g.id)+'">Edit</button><button class="remove" data-delete-group="'+escape(g.id)+'">Delete</button></div></div>';}).join('')||'<p class="hint">No accounts yet. Create one, then assign apps to it.</p>';}
async function downloadProfileApk(app){ try { const response=await fetch(`${state.base}/admin-api/apps/${encodeURIComponent(app.id)}/apk`,{headers:{authorization:authorization()},signal:AbortSignal.timeout(30000)}); if(!response.ok)throw new Error('APK could not be generated.'); const blob=await response.blob(); const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`demo-ledger-${app.id}.apk`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);notice('APK generated and download started'); } catch(error){ notice(error.message,true); }
}
async function deleteGroup(group){if(!confirm('Delete account "'+group.name+'"? Move its apps to another account first.'))return;try{await request('/admin-api/groups/'+encodeURIComponent(group.id),{method:'DELETE'});notice('Account deleted');await refresh();}catch(error){notice(error.message,true);}}
$('#newProfile').addEventListener('click',openNewProfile);document.querySelector('#sectionNewProfile').addEventListener('click',openNewProfile);
document.querySelector('#newGroupButton').addEventListener('click',openNewGroup);
appsSection.addEventListener('click',event=>{const configure=event.target.closest('[data-configure-app]');if(configure){const app=state.apps.find(a=>a.id===configure.dataset.configureApp);if(app)openAppEditor(app);return;}const download=event.target.closest('[data-download-app]');if(download){const app=state.apps.find(a=>a.id===download.dataset.downloadApp);if(app)downloadProfileApk(app);}});
groupsSection.addEventListener('click',event=>{const edit=event.target.closest('[data-edit-group]');if(edit){const g=state.groups.find(x=>x.id===edit.dataset.editGroup);if(g)openGroupEditor(g);return;}const del=event.target.closest('[data-delete-group]');if(del){const g=state.groups.find(x=>x.id===del.dataset.deleteGroup);if(g)deleteGroup(g);}});
document.querySelector('#cancelApp').onclick=()=>{if(!state.busy)appDialog.close();};
document.querySelector('#cancelGroup').onclick=()=>{if(!state.busy)groupDialog.close();};
document.querySelector('#groupForm').onsubmit=async event=>{event.preventDefault();const data=new FormData(event.target);const payload={name:data.get('name'),currency:data.get('currency')||'EUR',balanceOverride:data.get('balanceOverride')===''?null:data.get('balanceOverride'),transactionIds:data.getAll('transactionIds')};await mutation(event.target,'#groupError',()=>request(editingGroup?'/admin-api/groups/'+encodeURIComponent(editingGroup):'/admin-api/groups',{method:editingGroup?'PUT':'POST',body:JSON.stringify(payload)}),editingGroup?'Account saved':'Account created');};
document.querySelector('#appForm').onsubmit=async event=>{event.preventDefault();const data=new FormData(event.target);const payload={label:data.get('label'),groupId:data.get('groupId'),fullName:data.get('fullName'),email:data.get('email'),phone:data.get('phone'),iban:data.get('iban'),beneficiaryName:data.get('beneficiaryName'),address:data.get('address'),dateOfBirth:data.get('dateOfBirth'),taxId:data.get('taxId'),bankName:data.get('bankName'),bic:data.get('bic'),accountHolder:data.get('accountHolder'),status:data.get('status')};const result=await mutation(event.target,'#appError',()=>request(editingApp?'/admin-api/apps/'+encodeURIComponent(editingApp):'/admin-api/apps',{method:editingApp?'PUT':'POST',body:JSON.stringify(payload)}),editingApp?'App saved':'App created');if(!editingApp&&result?.app){downloadProfileApk(result.app);}}
$('#newProfile').disabled=true;document.querySelector('#sectionNewProfile').disabled=true;
