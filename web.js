import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { isJidGroup, jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const CONTACTS_DB = path.resolve(__dirname, 'contatos_cache.json');
const AVATAR_TTL_MS = 15 * 60 * 1000;
const GROUP_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS_PER_CHAT = 60;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

export function criarGerenciadorWeb(ctx) {
  const contatos = carregarContatos();
  const avatarCache = new Map();
  const groupCache = new Map();
  const chatEvents = new Map();
  const chatStats = new Map();
  let agendaSincronizada = false;
  let lastQrText = '';
  let lastQrSvg = '';

  function gerarQrSvg(qrText) {
    if (!qrText) return '';
    if (qrText === lastQrText && lastQrSvg) return lastQrSvg;
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(qrText);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;
    const size = count + margin * 2;
    let paths = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          paths += `M${c + margin},${r + margin}h1v1h-1z`;
        }
      }
    }
    lastQrText = qrText;
    lastQrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${paths}" fill="#111b21"/></svg>`;
    return lastQrSvg;
  }

  function jidIgnorado(jid) {
    return !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid === '_meta';
  }

  function carregarContatos() {
    try {
      if (fs.existsSync(CONTACTS_DB)) {
        const raw = JSON.parse(fs.readFileSync(CONTACTS_DB, 'utf8'));
        const map = new Map();
        for (const [k, v] of Object.entries(raw)) {
          if (k === '_meta') {
            agendaSincronizada = Boolean(v?.agendaSincronizada);
            continue;
          }
          if (jidIgnorado(k)) continue;
          if (isJidGroup(k) && v?.notify) {
            v.notify = '';
          }
          map.set(k, v);
        }
        return map;
      }
    } catch {}
    return new Map();
  }

  let salvarTimer = null;
  function agendarSalvarContatos() {
    if (salvarTimer) return;
    salvarTimer = setTimeout(() => {
      salvarTimer = null;
      try {
        const obj = Object.fromEntries(contatos.entries());
        obj._meta = { agendaSincronizada };
        fs.writeFileSync(CONTACTS_DB, JSON.stringify(obj, null, 2));
      } catch (err) {
        console.warn('⚠️  Erro ao salvar contatos_cache.json:', err.message || err);
      }
    }, 500);
  }

  function extrairTelefoneDeJid(jid) {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return '';
    if (decoded.server === 's.whatsapp.net' || decoded.server === 'hosted') {
      return decoded.user.replace(/\D/g, '');
    }
    return '';
  }

  function formatarTelefone(digits) {
    if (!digits) return '';
    const d = digits.replace(/\D/g, '');
    if (d.startsWith('55') && d.length === 13) {
      return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
    }
    if (d.startsWith('55') && d.length === 12) {
      return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
    }
    return `+${d}`;
  }

  function registrarContato({ jid, altJid, phone, name, notify, pushName, alias, lastActivityAt } = {}) {
    const normJid = jid ? jidNormalizedUser(jid) : '';
    if (jidIgnorado(normJid)) return null;

    const atual = contatos.get(normJid) || { jid: normJid };
    const normAlt = altJid ? jidNormalizedUser(altJid) : atual.altJid || '';
    const isGroup = Boolean(isJidGroup(normJid));
    const phoneDigits =
      (phone && phone.replace(/\D/g, '')) ||
      extrairTelefoneDeJid(normJid) ||
      extrairTelefoneDeJid(normAlt) ||
      atual.phone ||
      '';

    const atualizado = {
      ...atual,
      jid: normJid,
      altJid: normAlt && normAlt !== normJid ? normAlt : atual.altJid || '',
      phone: phoneDigits,
      isGroup,
      name: name || atual.name || '',
      notify: isGroup ? '' : notify || pushName || atual.notify || '',
      alias: alias !== undefined ? alias : atual.alias || '',
      lastActivityAt: Math.max(atual.lastActivityAt || 0, lastActivityAt || 0),
      updatedAt: Date.now()
    };

    contatos.set(normJid, atualizado);
    agendarSalvarContatos();
    return atualizado;
  }

  function registrarEvento(jid, evento) {
    const normJid = jidNormalizedUser(jid);
    if (!normJid) return;
    const lista = chatEvents.get(normJid) || [];
    lista.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...evento
    });
    if (lista.length > MAX_EVENTS_PER_CHAT) {
      lista.splice(0, lista.length - MAX_EVENTS_PER_CHAT);
    }
    chatEvents.set(normJid, lista);

    if (evento.direction === 'out' && evento.kind === 'sticker') {
      const atual = chatStats.get(normJid) || { stickersSent: 0 };
      atual.stickersSent += 1;
      chatStats.set(normJid, atual);
    }

    registrarContato({ jid: normJid, lastActivityAt: Date.now() });
  }

  async function resolverTelefoneViaLid(jid) {
    const sock = ctx.getSock();
    if (!sock?.signalRepository?.lidMapping || !jid?.endsWith('@lid')) return '';
    try {
      const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid);
      return extrairTelefoneDeJid(pnJid);
    } catch {
      return '';
    }
  }

  async function resolverNomeGrupo(jid) {
    if (!isJidGroup(jid)) return '';
    const cached = groupCache.get(jid);
    if (cached && Date.now() - cached.fetchedAt < GROUP_TTL_MS) {
      return cached.subject;
    }
    const sock = ctx.getSock();
    if (!sock || !ctx.isConnected()) return cached?.subject || '';
    try {
      const meta = await sock.groupMetadata(jid);
      const subject = meta?.subject || '';
      groupCache.set(jid, { subject, fetchedAt: Date.now() });
      if (subject) registrarContato({ jid, name: subject });
      return subject;
    } catch {
      return cached?.subject || '';
    }
  }

  function buscarPorTelefone(phone, ignoreJid) {
    if (!phone) return null;
    const pnEntry = contatos.get(`${phone}@s.whatsapp.net`);
    if (pnEntry && pnEntry.jid !== ignoreJid) return pnEntry;
    for (const c of contatos.values()) {
      if (c.jid !== ignoreJid && c.phone === phone && (c.name || c.notify || c.alias)) {
        return c;
      }
    }
    return null;
  }

  async function enriquecerChat(rawJid) {
    const jid = jidNormalizedUser(rawJid) || rawJid;
    const info = contatos.get(jid) || { jid };
    const isGroup = Boolean(isJidGroup(jid));
    const isSelf = ctx.isSelfChat(jid, info.altJid);

    let phone = info.phone || extrairTelefoneDeJid(jid) || extrairTelefoneDeJid(info.altJid);
    if (!phone && !isGroup && jid.endsWith('@lid')) {
      phone = await resolverTelefoneViaLid(jid);
      if (phone) registrarContato({ jid, phone });
    }

    const peer = !isGroup ? buscarPorTelefone(phone, jid) : null;
    const altJid = info.altJid || (peer?.jid && peer.jid !== jid ? peer.jid : '');

    let groupName = '';
    if (isGroup && !info.name) {
      groupName = await resolverNomeGrupo(jid);
    }

    const me = ctx.getMe();
    const selfName = isSelf ? me?.name || 'Você (Self-Chat)' : '';
    const savedName = info.name || groupName || peer?.name || '';
    const pushName = isGroup ? '' : info.notify || peer?.notify || '';
    const alias = info.alias || peer?.alias || '';
    const nome = alias || savedName || pushName || selfName || '';
    const formattedPhone = formatarTelefone(phone);
    const displayName = nome || formattedPhone || jid.split('@')[0];

    const customAudio = ctx.getChatCustomAudio(jid, altJid);
    const active = ctx.isChatActive(jid, altJid);
    const stats = chatStats.get(jid) || { stickersSent: 0 };

    return {
      jid,
      altJid,
      phone,
      formattedPhone,
      displayName,
      alias,
      savedName,
      pushName,
      isSelf,
      isGroup,
      active,
      hasCustomAudio: Boolean(customAudio),
      customAudioDuration: customAudio?.duracao || 0,
      lastActivityAt: Math.max(info.lastActivityAt || 0, peer?.lastActivityAt || 0),
      stats
    };
  }

  async function obterAvatar(jid, forceRefresh = false) {
    const normJid = jidNormalizedUser(jid);
    if (!normJid) return null;

    if (!forceRefresh && avatarCache.has(normJid)) {
      const cached = avatarCache.get(normJid);
      if (Date.now() - cached.fetchedAt < AVATAR_TTL_MS) {
        return cached.missing ? null : cached;
      }
    }

    const sock = ctx.getSock();
    if (!sock || !ctx.isConnected()) return null;

    const info = contatos.get(normJid);
    const candidatos = [normJid, info?.altJid, info?.phone ? `${info.phone}@s.whatsapp.net` : '']
      .filter(Boolean);

    for (const target of candidatos) {
      for (const tipo of ['preview', 'image']) {
        try {
          const picUrl = await sock.profilePictureUrl(target, tipo, 5000);
          if (!picUrl) continue;
          const res = await fetch(picUrl);
          if (!res.ok) continue;
          const arrayBuf = await res.arrayBuffer();
          const data = {
            buffer: Buffer.from(arrayBuf),
            contentType: res.headers.get('content-type') || 'image/jpeg',
            fetchedAt: Date.now(),
            missing: false
          };
          avatarCache.set(normJid, data);
          return data;
        } catch {
          // Sem foto ou erro de privacidade para este alvo
        }
      }
    }

    avatarCache.set(normJid, { missing: true, fetchedAt: Date.now() });
    return null;
  }

  function lerJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          reject(new Error('Payload muito grande'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('JSON inválido'));
        }
      });
      req.on('error', reject);
    });
  }

  function enviarJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  function servirArquivoEstatico(res, reqPath) {
    const relPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const fullPath = path.resolve(PUBLIC_DIR, relPath);
    if (!fullPath.startsWith(PUBLIC_DIR + path.sep) && fullPath !== path.join(PUBLIC_DIR, 'index.html')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  }

  async function handleRequest(req, res) {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/status') {
      const me = ctx.getMe();
      const mePhone = extrairTelefoneDeJid(me?.id);
      const conn = ctx.getConnectionInfo();
      return enviarJson(res, 200, {
        connected: conn.connected,
        connection: {
          phase: conn.phase,
          hasQr: Boolean(conn.qr),
          qrUpdatedAt: conn.qrUpdatedAt || 0,
          lastDisconnect: conn.lastDisconnect || null
        },
        me: {
          id: me?.id || '',
          lid: me?.lid || '',
          name: me?.name || 'Meu WhatsApp',
          phone: mePhone,
          formattedPhone: formatarTelefone(mePhone)
        },
        uptimeSec: Math.floor(process.uptime()),
        activeCount: ctx.getActiveJids().length,
        defaultAudio: ctx.getDefaultAudioInfo(),
        queue: ctx.getQueueInfo()
      });
    }

    if (req.method === 'GET' && pathname === '/api/qr.svg') {
      const conn = ctx.getConnectionInfo();
      if (!conn.qr || conn.connected) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      const svg = gerarQrSvg(conn.qr);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(svg);
    }

    if (req.method === 'GET' && pathname === '/api/chats') {
      const allJids = new Set([...ctx.getActiveJids(), ...contatos.keys()].filter((j) => !jidIgnorado(j)));
      const lista = await Promise.all([...allJids].map((j) => enriquecerChat(j)));

      // Prioriza ativos / @lid na deduplicação por JID ou telefone
      lista.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.jid.endsWith('@lid') !== b.jid.endsWith('@lid')) return a.jid.endsWith('@lid') ? -1 : 1;
        return 0;
      });

      const vistos = new Set();
      const telefonesVistos = new Set();
      const unicos = [];
      for (const item of lista) {
        if (vistos.has(item.jid)) continue;
        if (!item.isGroup && item.phone && telefonesVistos.has(item.phone)) continue;
        vistos.add(item.jid);
        if (item.altJid) vistos.add(item.altJid);
        if (!item.isGroup && item.phone) telefonesVistos.add(item.phone);
        unicos.push(item);
      }

      unicos.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        return a.displayName.localeCompare(b.displayName, 'pt-BR');
      });

      return enviarJson(res, 200, { chats: unicos });
    }

    if (req.method === 'GET' && pathname === '/api/chats/events') {
      const jid = jidNormalizedUser(urlObj.searchParams.get('jid') || '');
      if (!jid) return enviarJson(res, 400, { error: 'jid obrigatório' });
      return enviarJson(res, 200, { events: chatEvents.get(jid) || [] });
    }

    if (req.method === 'GET' && pathname === '/api/avatar') {
      const jid = urlObj.searchParams.get('jid') || '';
      const force = urlObj.searchParams.get('refresh') === '1';
      if (!jid) {
        res.writeHead(400);
        return res.end();
      }
      const avatar = await obterAvatar(jid, force);
      if (!avatar) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': avatar.contentType,
        'Cache-Control': 'private, max-age=300'
      });
      return res.end(avatar.buffer);
    }

    if (req.method === 'GET' && pathname === '/api/audio/default') {
      const { oggPath, mp3Path } = ctx.getDefaultAudioPaths();
      const target = fs.existsSync(mp3Path) ? mp3Path : oggPath;
      if (!target || !fs.existsSync(target)) {
        res.writeHead(404);
        return res.end('Áudio padrão não encontrado');
      }
      const contentType = target.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fs.statSync(target).size
      });
      return fs.createReadStream(target).pipe(res);
    }

    if (req.method === 'POST' && pathname === '/api/chats/toggle') {
      const { jid, active } = await lerJsonBody(req);
      if (!jid) return enviarJson(res, 400, { error: 'jid obrigatório' });
      const info = contatos.get(jidNormalizedUser(jid));
      const result = ctx.setChatActive(jid, Boolean(active), info?.altJid);
      registrarEvento(jid, {
        direction: 'system',
        kind: 'status',
        text: result ? 'Fábrica ativada pelo painel web' : 'Fábrica desativada pelo painel web'
      });
      return enviarJson(res, 200, { ok: true, active: result });
    }

    if (req.method === 'POST' && pathname === '/api/chats/reset-audio') {
      const { jid } = await lerJsonBody(req);
      if (!jid) return enviarJson(res, 400, { error: 'jid obrigatório' });
      const info = contatos.get(jidNormalizedUser(jid));
      ctx.resetChatCustomAudio(jid, info?.altJid);
      registrarEvento(jid, {
        direction: 'system',
        kind: 'audio',
        text: 'Áudio personalizado removido pelo painel (voltou para som.mp3)'
      });
      return enviarJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/chats/alias') {
      const { jid, alias } = await lerJsonBody(req);
      if (!jid) return enviarJson(res, 400, { error: 'jid obrigatório' });
      const updated = registrarContato({ jid, alias: String(alias || '').trim() });
      return enviarJson(res, 200, { ok: true, alias: updated?.alias || '' });
    }

    if (req.method === 'POST' && pathname === '/api/chats/refresh') {
      const { jid } = await lerJsonBody(req);
      if (!jid) return enviarJson(res, 400, { error: 'jid obrigatório' });
      const norm = jidNormalizedUser(jid);
      avatarCache.delete(norm);
      groupCache.delete(norm);
      await obterAvatar(norm, true);
      const chat = await enriquecerChat(norm);
      return enviarJson(res, 200, { ok: true, chat });
    }

    if (req.method === 'POST' && pathname === '/api/contacts/sync') {
      if (!ctx.isConnected()) return enviarJson(res, 503, { error: 'Bot desconectado do WhatsApp' });
      const count = await ctx.syncContacts();
      return enviarJson(res, 200, { ok: true, count });
    }

    if (req.method === 'POST' && pathname === '/api/auth/reconnect') {
      await ctx.reconnect();
      return enviarJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/auth/reset') {
      await ctx.resetSession();
      return enviarJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/chats/send') {
      const { jid, text } = await lerJsonBody(req);
      const msgText = String(text || '').trim();
      if (!jid || !msgText) return enviarJson(res, 400, { error: 'jid e text obrigatórios' });
      if (!ctx.isConnected()) return enviarJson(res, 503, { error: 'Bot desconectado do WhatsApp' });
      await ctx.sendTextMessage(jid, msgText);
      registrarEvento(jid, {
        direction: 'out',
        kind: 'text',
        text: msgText
      });
      return enviarJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return servirArquivoEstatico(res, pathname);
    }

    return enviarJson(res, 404, { error: 'Rota não encontrada' });
  }

  function iniciarServidor(port = Number(process.env.WEB_PORT || 3000), host = process.env.WEB_HOST || '127.0.0.1') {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        console.error('❌ Erro na API web:', err.message || err);
        if (!res.headersSent) {
          enviarJson(res, 500, { error: err.message || 'Erro interno' });
        }
      });
    });

    server.on('error', (err) => {
      console.error(`⚠️  Painel web não pôde iniciar em http://${host}:${port}: ${err.message || err}`);
    });

    server.listen(port, host, () => {
      console.log(`🌐 Painel de gerência online em http://${host}:${port}`);
    });

    return server;
  }

  return {
    iniciarServidor,
    registrarContato,
    registrarEvento,
    jaSincronizouAgenda: () => agendaSincronizada,
    marcarAgendaSincronizada: () => {
      agendaSincronizada = true;
      agendarSalvarContatos();
    }
  };
}
