const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');

const REQUEST_MS = 5 * 60 * 1000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_REQUESTS = 256;
const MAX_SESSIONS = 256;
const MAX_DEVICE_DETAILS = 512;

const SYSTEMS = [
  [/\bAndroid\b/i, 'Android'],
  [/\b(?:iPadOS|iPad)\b/i, 'iPadOS'],
  [/\b(?:iOS|iPhone|iPod)\b/i, 'iOS'],
  [/\b(?:Chrome OS|CrOS)\b/i, 'ChromeOS'],
  [/\bWindows\b/i, 'Windows'],
  [/\b(?:macOS|Macintosh|Mac OS X)\b/i, 'macOS'],
  [/\bLinux\b/i, 'Linux']
];

function normalizeIp(value = '') {
  const address = value.trim();
  if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  return isIP(address) ? address : '';
}

async function readLoginDevice(req, resolveProxy = () => lookup('coolify-proxy', { all: true })) {
  let ip = normalizeIp(req.socket.remoteAddress);
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = typeof forwarded === 'string' ? normalizeIp(forwarded.split(',').at(-1)) : '';
  if (ip && forwardedIp) {
    // Traefik appends the address of its immediate client. A direct API client
    // can supply the same header, so only accept it from the proxy container.
    const proxyAddresses = await resolveProxy().catch(() => []);
    if (proxyAddresses.some(({ address }) => normalizeIp(address) === ip)) ip = forwardedIp;
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(req.headers['sec-ch-ua-platform'] || ''))?.[1]
    || SYSTEMS.find(([pattern]) => pattern.test(req.headers['user-agent'] || ''))?.[1]
    || 'Neznámý';
  return { ip: ip || 'Neznámá', system };
}

function createDashboardAuth({ telegram, adminChatIds, enabled, now = Date.now }) {
  const requests = new Map();
  const deviceDetails = new Map();
  const sessions = new Map();
  const secret = randomBytes(32);
  let botUsername;
  let botLookup;

  function active(entries, key) {
    const entry = entries.get(key);
    if (entry && entry.expiresAt > now()) return entry;
    entries.delete(key);
  }

  function prune(entries) {
    for (const key of entries.keys()) active(entries, key);
  }

  function sign(purpose, value) {
    return createHmac('sha256', secret).update(purpose).update(value).digest();
  }

  function expiresAtFor(requestId) {
    const bytes = Buffer.from(requestId, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== requestId) return 0;
    const signature = sign('request', bytes.subarray(0, 20)).subarray(0, 12);
    if (!timingSafeEqual(bytes.subarray(20), signature)) return 0;
    return bytes.readUInt32BE(16) * 1000;
  }

  const browserProof = (requestId) => `${requestId}.${sign('browser', requestId).toString('base64url')}`;
  const displayCode = (requestId) => sign('display', requestId).subarray(0, 3).toString('hex').toUpperCase();

  async function start(device) {
    if (!enabled || ![...adminChatIds].some((id) => /^\d+$/.test(id))) {
      return { status: 503, body: { error: 'Telegram sign-in is unavailable. Use the backend key.' } };
    }
    if (!botUsername) {
      botLookup ||= telegram('getMe').then(({ result }) => {
        if (!/^[a-zA-Z0-9_]{5,32}$/.test(result?.username || '')) throw new Error('Missing bot username');
        botUsername = result.username;
      }).finally(() => { botLookup = undefined; });
      try { await botLookup; }
      catch { return { status: 503, body: { error: 'Telegram is unavailable. Try again or use the backend key.' } }; }
    }
    // Reserve approval state only after an allowed Telegram user opens the link.
    const payload = randomBytes(20);
    const expiry = Math.floor((now() + REQUEST_MS) / 1000);
    payload.writeUInt32BE(expiry, 16);
    const requestId = Buffer.concat([payload, sign('request', payload).subarray(0, 12)]).toString('base64url');
    const expiresAt = expiry * 1000;
    if (device) {
      prune(deviceDetails);
      if (deviceDetails.size >= MAX_DEVICE_DETAILS) deviceDetails.delete(deviceDetails.keys().next().value);
      deviceDetails.set(requestId, { ...device, expiresAt });
    }
    return { status: 201, body: {
      browserToken: browserProof(requestId), code: displayCode(requestId), expiresAt,
      telegramUrl: `https://t.me/${botUsername}?start=dashboard_${requestId}`
    } };
  }

  function status(authorization = '') {
    const browserToken = authorization.startsWith('Login ') ? authorization.slice(6) : '';
    const requestId = browserToken.split('.')[0];
    if (expiresAtFor(requestId) <= now() || browserProof(requestId) !== browserToken) return { status: 'expired' };
    const request = active(requests, requestId);
    if (!request) return { status: 'pending' };
    if (request.status === 'used') return { status: 'expired' };
    if (request.status !== 'approved') return { status: request.status };

    request.status = 'used';
    prune(sessions);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { adminId: request.adminId, expiresAt: now() + SESSION_MS });
    return { status: 'approved', token };
  }

  function authorize(req) {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Dashboard ')) return false;
    const session = active(sessions, authorization.slice(10));
    if (!session || !adminChatIds.has(session.adminId)) return false;
    if (req.url.startsWith('/admin-api/')) return true;
    if (req.method === 'GET') return ['/account', '/transactions', '/logs'].includes(req.url);
    return req.method === 'DELETE' && /^\/transactions\/tx_[a-f0-9]+$/.test(req.url);
  }

  function logout(authorization = '') {
    if (authorization.startsWith('Dashboard ')) sessions.delete(authorization.slice(10));
  }

  async function handleUpdate(update) {
    const callback = update.callback_query;
    const startMatch = String(update.message?.text || '').match(/^\/start(?:@\w+)? dashboard_([\w-]{43})$/);
    const callbackMatch = String(callback?.data || '').match(/^dashboard:(approve|deny):([\w-]{43})$/);
    if (!startMatch && !callbackMatch) return false;

    const chat = callback ? callback.message?.chat : update.message.chat;
    const user = callback ? callback.from : update.message.from;
    const userId = String(user?.id || '');
    const isAdmin = enabled && chat?.type === 'private' && String(chat.id) === userId && adminChatIds.has(userId);
    const requestId = startMatch ? startMatch[1] : callbackMatch[2];
    const request = active(requests, requestId);

    if (startMatch) {
      if (!isAdmin) return true;
      const expiresAt = expiresAtFor(requestId);
      if (expiresAt <= now() || (request && (request.status !== 'pending' || request.adminId !== userId))) {
        await telegram('sendMessage', { chat_id: userId, text: 'Tato žádost už není platná. Začni znovu v dashboardu.' });
        return true;
      }
      if (request) return true;
      prune(requests);
      if (requests.size >= MAX_REQUESTS) {
        await telegram('sendMessage', { chat_id: userId, text: 'Je tu příliš mnoho žádostí. Zkus to za pár minut.' });
        return true;
      }
      const device = active(deviceDetails, requestId);
      const summary = `IP adresa: ${device?.ip || 'Neznámá'}\nSystém: ${device?.system || 'Neznámý'}\nKód: ${displayCode(requestId)}`;
      requests.set(requestId, { adminId: userId, expiresAt, status: 'pending', summary });
      try {
        await telegram('sendMessage', {
          chat_id: userId,
          text: `Přihlášení do Demo Ledger\n\n${summary}\n\nPotvrď jen žádost, kterou jsi právě otevřel(a) v dashboardu se stejným kódem.`,
          reply_markup: { inline_keyboard: [[
            { text: '✅ Potvrdit', callback_data: `dashboard:approve:${requestId}` },
            { text: '❌ Zamítnout', callback_data: `dashboard:deny:${requestId}` }
          ]] }
        });
      } catch (error) {
        requests.delete(requestId);
        throw error;
      }
      deviceDetails.delete(requestId);
      return true;
    }

    if (!isAdmin || !request || request.status !== 'pending' || request.adminId !== userId) {
      await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Tuto žádost už nelze potvrdit.' });
      return true;
    }
    const approved = callbackMatch[1] === 'approve';
    request.status = approved ? 'approved' : 'denied';
    const text = approved ? 'Přihlášení potvrzeno. Vrať se do dashboardu.' : 'Přihlášení zamítnuto.';
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text });
    await telegram('editMessageText', {
      chat_id: userId, message_id: callback.message.message_id,
      text: `${text}\n\n${request.summary}`, reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    return true;
  }

  return { start, status, authorize, logout, handleUpdate };
}

module.exports = { createDashboardAuth, readLoginDevice };
