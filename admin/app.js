'use strict';
const $ = (selector) => document.querySelector(selector);
const state = { key: '', base: '', transactions: [], events: [], apps: [], activeAppId: '', globalOrder: JSON.parse(localStorage.getItem('demo-ledger-order') || '[]'), balance: 0, filter: 'all', query: '', page: 0, view: 'transactions', editingId: null, deletingId: null, connected: false, busy: false, dark: localStorage.getItem('demo-ledger-theme') !== 'light' };
const PAGE_SIZE = 12;
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
  const response = await fetch(`${state.base}${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${state.key}`, 'content-type': 'application/json' } });
  let result;
  try { result = await response.json(); } catch { throw new Error('The backend returned an invalid response. Check the address.'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('The backend key was not accepted.');
    if (response.status === 404 && path.startsWith('/admin-api')) throw new Error('This backend needs the dashboard update before this action is available.');
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result;
}
function render() {
  renderApps();
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
async function refresh() {
  if (!state.connected || state.busy) return;
  const [account, ledger, audit, apps] = await Promise.all([request('/account'), request('/transactions'), request('/logs'), request('/admin-api/apps')]);
  state.apps=apps.apps||[];
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
  const values = { recipient: '', amount: '', direction: 'plus', status: 'confirmed', icon: '↗', note: '', ...tx, createdAt: localInput(tx?.createdAt || new Date()) };
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
$('#backendUrl').value = location.pathname.startsWith('/admin') ? location.origin : 'https://telegram-backend-57085978600.europe-west1.run.app';
$('#timeZone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) { $('#apiKey').required = false; $('#apiKey').closest('label').hidden = true; }
$('#connectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const url = new URL($('#backendUrl').value);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Enter a valid backend address.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for a remote backend.');
    state.base = url.href.replace(/\/$/, '');
    state.key = $('#apiKey').value;
    state.connected = true;
    await refresh();
    $('#apiKey').value = '';
    $('#login').hidden = true;
    $('#dashboard').hidden = false;
    $('#newTransaction').disabled = false;
    $('#newProfile').disabled = false;
    $('#sectionNewProfile').disabled = false;
    $('#disconnect').hidden = false;
    document.body.classList.add('connected');
    notice('Backend connected');
  } catch (error) { state.connected = false; state.key = ''; notice(error.message, true); }
  finally { submit.disabled = false; }
});
$('#disconnect').addEventListener('click', () => {
  state.key = ''; state.connected = false; state.transactions = []; state.events = []; state.balance = 0;
  render();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  $('#login').hidden = false; $('#dashboard').hidden = true; $('#disconnect').hidden = true; $('#newTransaction').disabled = true; $('#newProfile').disabled = true; $('#sectionNewProfile').disabled = true;
  $('#connectionState').textContent = 'Not connected'; document.body.classList.remove('connected');
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

const appsSection=document.createElement('section');appsSection.className='card';appsSection.style.cssText='padding:24px;margin-bottom:24px';appsSection.innerHTML='<div class="toolbar"><div><h2 style="margin-top:0">Connected apps</h2><p class="hint">Each profile has its own identity, balance, transaction selection and downloadable Android APK.</p></div><button id="sectionNewProfile" class="primary" type="button">＋ New profile</button></div><div id="appRows"></div>';document.querySelector('.stats').before(appsSection);
const appDialog=document.createElement('dialog');appDialog.id='appDialog';appDialog.innerHTML='<form id="appForm"><h2 id="appDialogTitle">New profile</h2><label>Test profile label<input name="label" required minlength="3" maxlength="60" placeholder="e.g. Pixel 7 test device"></label><p class="hint">DEMO only: profiles never store names, contact details or bank accounts.</p><label id="copySourceWrap">Copy transactions from profile<select name="copyFromAppId"><option value="">Do not copy transactions</option></select></label><h3>Transactions to show</h3><p class="hint">Only selected transactions appear in this profile and contribute to its balance. Their order is the order shown in the app.</p><div id="appTransactions" style="max-height:260px;overflow:auto"></div><p class="form-error" id="appError"></p><div class="dialog-footer"><button type="button" id="cancelApp">Cancel</button><button class="primary" id="saveAppButton">Save profile and generate APK</button></div></form>';document.body.appendChild(appDialog);
let editingApp='';
function profileTransactionList(app){
 document.querySelector('#appTransactions').innerHTML=state.transactions.map(tx=>'<label style="display:flex;flex-direction:row;align-items:center;gap:12px"><input style="flex:none" type="checkbox" name="transactionIds" value="'+escape(tx.id)+'" '+(app?.transactionIds?.includes(tx.id)?'checked':'')+'><span>'+escape(tx.recipient)+' · '+escape(money(tx.amount))+' · '+escape(tx.status)+'</span></label>').join('')||'<p>No transactions yet. You can save an empty selection.</p>';
}
function renderCopySources(){
 const select=document.querySelector('#appForm select[name="copyFromAppId"]'); if(!select)return;
 select.innerHTML='<option value="">Do not copy transactions</option>'+(state.apps||[]).filter(app=>app.id!==editingApp).map(app=>'<option value="'+escape(app.id)+'">'+escape(app.label||'Setup required')+' · '+app.transactionIds.length+' transactions</option>').join('');
}
function openNewProfile(){
 editingApp='';const form=document.querySelector('#appForm');form.reset();document.querySelector('#copySourceWrap').hidden=false;document.querySelector('#appDialogTitle').textContent='New profile';document.querySelector('#saveAppButton').textContent='Save profile and generate APK';renderCopySources();profileTransactionList(null);document.querySelector('#appError').textContent='';appDialog.showModal();
}
function openAppEditor(app){
 editingApp=app.id;const form=document.querySelector('#appForm');form.elements.label.value=app.label||'';document.querySelector('#appDialogTitle').textContent='Edit profile';document.querySelector('#saveAppButton').textContent='Save profile';document.querySelector('#copySourceWrap').hidden=true;profileTransactionList(app);document.querySelector('#appError').textContent='';appDialog.showModal();
}
function renderApps(){
 const list=document.querySelector('#appRows');if(!list)return;
 list.innerHTML=(state.apps||[]).map(app=>'<div class="app-row"><div><strong>'+escape(app.label||'Setup required')+'</strong><small>DEMO · App '+escape(app.id.slice(0,12))+' · '+app.transactionIds.length+' transactions</small></div><div class="app-row-actions"><button data-configure-app="'+escape(app.id)+'">'+(app.configured?'Edit setup':'Configure app')+'</button><button data-download-app="'+escape(app.id)+'">Download APK</button></div></div>').join('')||'<p class="hint">Create a profile or open the updated Android app to connect it.</p>';
}
async function downloadProfileApk(app){
 try { const response=await fetch(`${state.base}/admin-api/apps/${encodeURIComponent(app.id)}/apk`,{headers:{authorization:`Bearer ${state.key}`},signal:AbortSignal.timeout(30000)}); if(!response.ok)throw new Error('APK could not be generated.'); const blob=await response.blob(); const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`demo-ledger-${app.id}.apk`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);notice('APK generated and download started'); } catch(error){ notice(error.message,true); }
}
$('#newProfile').addEventListener('click',openNewProfile);document.querySelector('#sectionNewProfile').addEventListener('click',openNewProfile);
appsSection.addEventListener('click',event=>{const configure=event.target.closest('[data-configure-app]');if(configure){const app=state.apps.find(a=>a.id===configure.dataset.configureApp);if(app)openAppEditor(app);return;}const download=event.target.closest('[data-download-app]');if(download){const app=state.apps.find(a=>a.id===download.dataset.downloadApp);if(app)downloadProfileApk(app);}});
document.querySelector('#cancelApp').onclick=()=>{if(!state.busy)appDialog.close();};
document.querySelector('#appForm select[name="copyFromAppId"]').onchange=event=>{const source=state.apps.find(app=>app.id===event.target.value);if(source)profileTransactionList(source);};
document.querySelector('#appForm').onsubmit=async event=>{event.preventDefault();const data=new FormData(event.target);const payload={label:data.get('label'),transactionIds:data.getAll('transactionIds')};if(!editingApp)payload.copyFromAppId=data.get('copyFromAppId');const result=await mutation(event.target,'#appError',()=>request(editingApp?'/admin-api/apps/'+encodeURIComponent(editingApp):'/admin-api/apps',{method:editingApp?'PUT':'POST',body:JSON.stringify(payload)}),editingApp?'Profile saved':'Profile created');if(!editingApp&&result?.app){downloadProfileApk(result.app);}}
$('#newProfile').disabled=true;document.querySelector('#sectionNewProfile').disabled=true;
