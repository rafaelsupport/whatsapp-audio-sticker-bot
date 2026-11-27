const state = {
  chats: [],
  selectedJid: null,
  filter: 'active',
  search: '',
  status: null,
  avatarBust: new Map(),
  bypassOfflineView: false,
  wasConnected: null,
  lastQrUpdatedAt: 0
};

const els = {
  authScreen: document.getElementById('authScreen'),
  authPhaseBadge: document.getElementById('authPhaseBadge'),
  authTitle: document.getElementById('authTitle'),
  authSubtitle: document.getElementById('authSubtitle'),
  authReason: document.getElementById('authReason'),
  btnReconnect: document.getElementById('btnReconnect'),
  btnResetAuth: document.getElementById('btnResetAuth'),
  btnViewOffline: document.getElementById('btnViewOffline'),
  qrBox: document.getElementById('qrBox'),
  qrImg: document.getElementById('qrImg'),
  btnQrReload: document.getElementById('btnQrReload'),
  qrPlaceholder: document.getElementById('qrPlaceholder'),
  qrPlaceholderText: document.getElementById('qrPlaceholderText'),
  qrCaption: document.getElementById('qrCaption'),
  logoutModal: document.getElementById('logoutModal'),
  btnConfirmLogout: document.getElementById('btnConfirmLogout'),
  btnCancelLogout: document.getElementById('btnCancelLogout'),
  aliasModal: document.getElementById('aliasModal'),
  aliasForm: document.getElementById('aliasForm'),
  aliasInput: document.getElementById('aliasInput'),
  btnCancelAlias: document.getElementById('btnCancelAlias'),
  appShell: document.getElementById('appShell'),
  meAvatar: document.getElementById('meAvatar'),
  meName: document.getElementById('meName'),
  connBadge: document.getElementById('connBadge'),
  connText: document.getElementById('connText'),
  btnSyncContacts: document.getElementById('btnSyncContacts'),
  btnPlayDefault: document.getElementById('btnPlayDefault'),
  btnRefreshAll: document.getElementById('btnRefreshAll'),
  btnLogout: document.getElementById('btnLogout'),
  defaultAudioPlayer: document.getElementById('defaultAudioPlayer'),
  searchInput: document.getElementById('searchInput'),
  countActive: document.getElementById('countActive'),
  countAll: document.getElementById('countAll'),
  countGroups: document.getElementById('countGroups'),
  chatList: document.getElementById('chatList'),
  emptyState: document.getElementById('emptyState'),
  statActive: document.getElementById('statActive'),
  statQueue: document.getElementById('statQueue'),
  statAudio: document.getElementById('statAudio'),
  chatView: document.getElementById('chatView'),
  btnBack: document.getElementById('btnBack'),
  chatAvatar: document.getElementById('chatAvatar'),
  chatName: document.getElementById('chatName'),
  btnEditAlias: document.getElementById('btnEditAlias'),
  tagSelf: document.getElementById('tagSelf'),
  tagGroup: document.getElementById('tagGroup'),
  chatSubtitle: document.getElementById('chatSubtitle'),
  btnResetAudio: document.getElementById('btnResetAudio'),
  btnRefreshProfile: document.getElementById('btnRefreshProfile'),
  btnToggleActive: document.getElementById('btnToggleActive'),
  chatInfoStrip: document.getElementById('chatInfoStrip'),
  chatMessages: document.getElementById('chatMessages'),
  sendForm: document.getElementById('sendForm'),
  messageInput: document.getElementById('messageInput'),
  toast: document.getElementById('toast')
};

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  const palette = ['#00a884', '#1d4ed8', '#7c3aed', '#db2777', '#d97706', '#059669', '#0284c7'];
  return palette[h % palette.length];
}

function getInitials(name) {
  const clean = (name || '?').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function renderAvatar(container, jid, label) {
  const bust = state.avatarBust.get(jid) || '';
  const key = `${jid}|${bust}`;
  if (container.dataset.avatarKey === key) return;
  container.dataset.avatarKey = key;

  container.style.background = hashColor(jid || label);
  container.innerHTML = '';

  const initials = document.createElement('span');
  initials.textContent = getInitials(label);
  container.appendChild(initials);

  if (!jid) return;
  const img = new Image();
  img.alt = label;
  img.src = `/api/avatar?jid=${encodeURIComponent(jid)}${bust ? `&t=${bust}` : ''}`;
  img.onload = () => {
    container.innerHTML = '';
    container.appendChild(img);
  };
  img.onerror = () => {
    // Mantém iniciais quando não houver foto ou erro
  };
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
  return data;
}

function renderConnectionScreen() {
  const s = state.status;
  if (!s) return;

  if (s.connected) {
    state.bypassOfflineView = false;
    els.authScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');
    return;
  }

  if (state.bypassOfflineView) {
    els.authScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');
    return;
  }

  els.authScreen.classList.remove('hidden');
  els.appShell.classList.add('hidden');

  const conn = s.connection || {};
  const phase = conn.phase || 'connecting';
  const last = conn.lastDisconnect;

  const phaseLabels = {
    qr: 'QR Code pronto',
    qr_expired: 'QR Code expirado',
    connecting: 'Conectando...',
    close: 'Reconectando...',
    logged_out: 'Sessão deslogada (401)',
    replaced: 'Sessão substituída (440)'
  };

  els.authPhaseBadge.textContent = phaseLabels[phase] || 'Desconectado';
  els.authReason.className = 'auth-status-box';
  els.btnResetAuth.classList.toggle('hidden', phase !== 'logged_out' && phase !== 'replaced');

  if (phase === 'qr' && conn.hasQr) {
    els.authTitle.textContent = 'Escaneie para entrar';
    els.authReason.textContent = `QR Code pronto para leitura (${formatTime(conn.qrUpdatedAt)}). Após escanear, o painel abre automaticamente.`;
  } else if (phase === 'qr_expired') {
    els.authTitle.textContent = 'Escaneie para entrar';
    els.authReason.classList.add('warn');
    els.authReason.textContent = 'QR code expirado. Clique sobre ele para recarregar ou aguarde a renovação automática em alguns minutos.';
  } else if (phase === 'logged_out') {
    els.authTitle.textContent = 'Sessão desconectada';
    els.authReason.classList.add('error');
    els.authReason.textContent = 'O aparelho foi desconectado (401). Clique em "Limpar sessão e gerar novo QR" para parear novamente.';
  } else if (phase === 'replaced') {
    els.authTitle.textContent = 'Sessão substituída';
    els.authReason.classList.add('warn');
    els.authReason.textContent = 'Outra instância assumiu esta sessão (440). Feche a outra instância e clique em "Atualizar QR code".';
  } else {
    els.authTitle.textContent = 'Escaneie para entrar';
    els.authReason.classList.add('warn');
    els.authReason.textContent = last?.reason
      ? `Tentando reconectar (${last.code || '-'} • ${last.reason})...`
      : 'Inicializando conexão e gerando QR Code...';
  }

  const isExpired = phase === 'qr_expired';
  els.qrBox.classList.toggle('expired', isExpired && conn.hasQr);
  els.btnQrReload.classList.toggle('hidden', !isExpired);

  if (conn.hasQr) {
    if (state.lastQrUpdatedAt !== conn.qrUpdatedAt) {
      state.lastQrUpdatedAt = conn.qrUpdatedAt;
      els.qrImg.src = `/api/qr.svg?t=${conn.qrUpdatedAt}`;
    }
    els.qrImg.classList.remove('hidden');
    els.qrPlaceholder.classList.add('hidden');
    els.qrCaption.textContent = isExpired
      ? 'Renova automaticamente em 5 min ou clique para recarregar.'
      : 'O QR Code atualiza automaticamente se expirar.';
  } else {
    els.qrImg.classList.add('hidden');
    els.qrPlaceholder.classList.remove('hidden');
    els.qrPlaceholderText.textContent =
      phase === 'logged_out'
        ? 'Sessão expirada. Clique em "Gerar novo QR".'
        : 'Aguardando QR Code...';
    els.qrCaption.textContent = 'Assim que conectar, seu painel aparece automaticamente.';
  }
}

function renderStatus() {
  const s = state.status;
  if (!s) return;

  renderConnectionScreen();

  els.meName.textContent = s.me.name || 'Meu WhatsApp';
  renderAvatar(els.meAvatar, s.me.lid || s.me.id, s.me.name);

  els.btnLogout.classList.toggle('hidden', !s.connected);
  els.connBadge.classList.toggle('online', s.connected);
  els.connBadge.classList.toggle('offline', !s.connected);
  els.connBadge.classList.toggle('clickable', !s.connected);
  els.connText.textContent = s.connected
    ? `Online • ${s.me.formattedPhone || 'conectado'}`
    : 'Desconectado • clique p/ QR';

  els.statActive.textContent = String(s.activeCount);
  els.statQueue.textContent = `${s.queue.running} ativas / ${s.queue.pending} na fila`;
  els.statAudio.textContent = s.defaultAudio.exists ? `${s.defaultAudio.duration}s (som.mp3)` : 'ausente';
}

function getFilteredChats() {
  const q = state.search.trim().toLowerCase();
  return state.chats.filter((c) => {
    if (state.filter === 'active' && !c.active) return false;
    if (state.filter === 'groups' && !c.isGroup) return false;
    if (!q) return true;
    return (
      c.displayName.toLowerCase().includes(q) ||
      c.jid.toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.formattedPhone || '').toLowerCase().includes(q)
    );
  });
}

function renderChatList() {
  els.countActive.textContent = String(state.chats.filter((c) => c.active).length);
  els.countAll.textContent = String(state.chats.length);
  els.countGroups.textContent = String(state.chats.filter((c) => c.isGroup).length);

  const list = getFilteredChats();
  els.chatList.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'msg-empty';
    empty.style.margin = '24px 14px';
    empty.textContent = 'Nenhum chat encontrado neste filtro.';
    els.chatList.appendChild(empty);
    return;
  }

  for (const chat of list) {
    const row = document.createElement('div');
    row.className = `chat-row${chat.jid === state.selectedJid ? ' selected' : ''}`;
    row.onclick = () => selectChat(chat.jid);

    const av = document.createElement('div');
    av.className = 'avatar avatar-lg';
    renderAvatar(av, chat.jid, chat.displayName);

    const body = document.createElement('div');
    body.className = 'chat-row-body';

    const top = document.createElement('div');
    top.className = 'chat-row-top';
    const nameEl = document.createElement('div');
    nameEl.className = 'chat-row-name';
    nameEl.textContent = chat.isSelf ? `${chat.displayName} (Você)` : chat.displayName;
    const timeEl = document.createElement('div');
    timeEl.className = 'chat-row-time';
    timeEl.textContent = formatTime(chat.lastActivityAt);
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'chat-row-bottom';
    const subEl = document.createElement('div');
    subEl.className = 'chat-row-sub';
    if (chat.displayName === chat.formattedPhone) {
      subEl.textContent = `Sem nome salvo • ${chat.jid}`;
    } else {
      subEl.textContent = chat.formattedPhone || (chat.isGroup ? 'Grupo WhatsApp' : chat.jid);
    }

    const badges = document.createElement('div');
    badges.className = 'chat-row-badges';
    if (chat.hasCustomAudio) {
      const a = document.createElement('span');
      a.className = 'badge-pill';
      a.textContent = `🎵 ${chat.customAudioDuration}s`;
      badges.appendChild(a);
    }
    if (chat.stats?.stickersSent > 0) {
      const st = document.createElement('span');
      st.className = 'badge-pill';
      st.textContent = `${chat.stats.stickersSent}`;
      badges.appendChild(st);
    }
    if (chat.active) {
      const dot = document.createElement('span');
      dot.className = 'badge-active';
      dot.title = 'Fábrica ativada';
      badges.appendChild(dot);
    }

    bottom.append(subEl, badges);
    body.append(top, bottom);
    row.append(av, body);
    els.chatList.appendChild(row);
  }
}

function renderSelectedChatHeader() {
  const chat = state.chats.find((c) => c.jid === state.selectedJid);
  if (!chat) {
    els.emptyState.classList.remove('hidden');
    els.chatView.classList.add('hidden');
    els.appShell.classList.remove('has-selection');
    return;
  }

  els.emptyState.classList.add('hidden');
  els.chatView.classList.remove('hidden');
  els.appShell.classList.add('has-selection');

  renderAvatar(els.chatAvatar, chat.jid, chat.displayName);
  els.chatName.textContent = chat.displayName;
  els.tagSelf.classList.toggle('hidden', !chat.isSelf);
  els.tagGroup.classList.toggle('hidden', !chat.isGroup);

  const subParts = [];
  if (chat.formattedPhone) subParts.push(chat.formattedPhone);
  if (chat.pushName && chat.pushName !== chat.displayName) subParts.push(`Push: ${chat.pushName}`);
  subParts.push(chat.jid);
  els.chatSubtitle.textContent = subParts.join(' • ');

  els.btnResetAudio.classList.toggle('hidden', !chat.hasCustomAudio);
  els.btnToggleActive.textContent = chat.active ? 'Desativar' : 'Ativar';
  els.btnToggleActive.className = `btn ${chat.active ? 'btn-danger' : ''}`;

  els.chatInfoStrip.innerHTML = '';
  const items = [
    `Status: <code>${chat.active ? 'ATIVO' : 'INATIVO'}</code>`,
    `Número: <code>${chat.formattedPhone || (chat.isGroup ? 'Grupo' : 'LID sem número mapeado')}</code>`,
    `Áudio: <code>${chat.hasCustomAudio ? `Personalizado (${chat.customAudioDuration}s)` : 'som.mp3 padrão'}</code>`,
    `Stickers na sessão: <code>${chat.stats?.stickersSent || 0}</code>`
  ];
  if (chat.altJid) items.push(`Alt JID: <code>${chat.altJid}</code>`);

  for (const html of items) {
    const span = document.createElement('span');
    span.innerHTML = html;
    els.chatInfoStrip.appendChild(span);
  }
}

async function loadChatEvents() {
  if (!state.selectedJid) return;
  try {
    const { events } = await apiJson(`/api/chats/events?jid=${encodeURIComponent(state.selectedJid)}`);
    els.chatMessages.innerHTML = '';

    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'msg-empty';
      empty.textContent =
        'Nenhuma atividade registrada nesta sessão ainda. Quando este chat enviar figurinhas, imagens, vídeos ou comandos, os eventos aparecerão aqui.';
      els.chatMessages.appendChild(empty);
      return;
    }

    for (const ev of events) {
      const row = document.createElement('div');
      const dir = ev.direction === 'out' ? 'out' : ev.direction === 'in' ? 'in' : 'system';
      row.className = `bubble-row ${dir}${ev.error ? ' error' : ''}`;

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      const textEl = document.createElement('div');
      textEl.textContent = ev.text;
      bubble.appendChild(textEl);

      if (dir !== 'system') {
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        if (ev.detail) {
          const d = document.createElement('span');
          d.textContent = ev.detail;
          meta.appendChild(d);
        }
        const t = document.createElement('span');
        t.textContent = formatTime(ev.timestamp);
        meta.appendChild(t);
        bubble.appendChild(meta);
      }

      row.appendChild(bubble);
      els.chatMessages.appendChild(row);
    }

    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  } catch (err) {
    console.warn('Erro ao carregar eventos:', err);
  }
}

async function selectChat(jid) {
  state.selectedJid = jid;
  renderChatList();
  renderSelectedChatHeader();
  await loadChatEvents();
}

async function refreshAll() {
  try {
    const [status, chatsRes] = await Promise.all([apiJson('/api/status'), apiJson('/api/chats')]);
    state.status = status;
    state.chats = chatsRes.chats;
    renderStatus();
    renderChatList();
    renderSelectedChatHeader();
    if (state.selectedJid) await loadChatEvents();
  } catch (err) {
    console.warn('Erro ao atualizar painel:', err);
  }
}

// Eventos de UI
document.querySelectorAll('.filter-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderChatList();
  });
});

els.searchInput.addEventListener('input', (e) => {
  state.search = e.target.value;
  renderChatList();
});

els.btnBack.addEventListener('click', () => {
  state.selectedJid = null;
  renderChatList();
  renderSelectedChatHeader();
});

els.btnRefreshAll.addEventListener('click', async () => {
  await refreshAll();
  showToast('Lista atualizada');
});

els.btnSyncContacts.addEventListener('click', async () => {
  showToast('Sincronizando agenda do WhatsApp...');
  try {
    const { count } = await apiJson('/api/contacts/sync', { method: 'POST' });
    await refreshAll();
    showToast(`Agenda sincronizada (${count} contatos)`);
  } catch (err) {
    showToast(err.message);
  }
});

els.btnPlayDefault.addEventListener('click', () => {
  const player = els.defaultAudioPlayer;
  if (player.paused) {
    player.currentTime = 0;
    player.play().catch(() => showToast('Não foi possível reproduzir som.mp3'));
    els.btnPlayDefault.classList.add('playing');
  } else {
    player.pause();
    els.btnPlayDefault.classList.remove('playing');
  }
});

els.defaultAudioPlayer.addEventListener('ended', () => {
  els.btnPlayDefault.classList.remove('playing');
});

els.btnToggleActive.addEventListener('click', async () => {
  const chat = state.chats.find((c) => c.jid === state.selectedJid);
  if (!chat) return;
  try {
    await apiJson('/api/chats/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: chat.jid, active: !chat.active })
    });
    showToast(!chat.active ? 'Fábrica ativada no chat' : 'Fábrica desativada no chat');
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

els.btnResetAudio.addEventListener('click', async () => {
  if (!state.selectedJid) return;
  try {
    await apiJson('/api/chats/reset-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: state.selectedJid })
    });
    showToast('Chat voltou para o som.mp3 padrão');
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

els.btnRefreshProfile.addEventListener('click', async () => {
  if (!state.selectedJid) return;
  try {
    state.avatarBust.set(state.selectedJid, Date.now());
    await apiJson('/api/chats/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: state.selectedJid })
    });
    await refreshAll();
    showToast('Perfil e foto atualizados');
  } catch (err) {
    showToast(err.message);
  }
});

els.btnEditAlias.addEventListener('click', () => {
  const chat = state.chats.find((c) => c.jid === state.selectedJid);
  if (!chat) return;
  els.aliasInput.value = chat.alias || chat.displayName || '';
  els.aliasModal.classList.remove('hidden');
  setTimeout(() => els.aliasInput.focus(), 30);
});

els.btnCancelAlias.addEventListener('click', () => els.aliasModal.classList.add('hidden'));
els.aliasModal.addEventListener('click', (e) => {
  if (e.target === els.aliasModal) els.aliasModal.classList.add('hidden');
});

els.aliasForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedJid) return;
  const novo = els.aliasInput.value.trim();
  els.aliasModal.classList.add('hidden');
  try {
    await apiJson('/api/chats/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: state.selectedJid, alias: novo })
    });
    await refreshAll();
    showToast('Nome atualizado no painel');
  } catch (err) {
    showToast(err.message);
  }
});

els.sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !state.selectedJid) return;
  els.messageInput.value = '';
  try {
    await apiJson('/api/chats/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: state.selectedJid, text })
    });
    await loadChatEvents();
  } catch (err) {
    showToast(err.message);
  }
});

async function pollLoop() {
  await refreshAll();
  const delay = state.status?.connected ? 3000 : 1500;
  setTimeout(pollLoop, delay);
}

els.connBadge.addEventListener('click', () => {
  if (!state.status?.connected) {
    state.bypassOfflineView = false;
    renderConnectionScreen();
  }
});

els.btnViewOffline.addEventListener('click', () => {
  state.bypassOfflineView = true;
  renderConnectionScreen();
});

async function solicitarNovoQr() {
  showToast('Gerando novo QR Code...');
  try {
    state.lastQrUpdatedAt = 0;
    await apiJson('/api/auth/reconnect', { method: 'POST' });
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
}

els.btnReconnect.addEventListener('click', solicitarNovoQr);
els.btnQrReload.addEventListener('click', solicitarNovoQr);

els.btnLogout.addEventListener('click', () => {
  els.logoutModal.classList.remove('hidden');
});

els.btnCancelLogout.addEventListener('click', () => els.logoutModal.classList.add('hidden'));
els.logoutModal.addEventListener('click', (e) => {
  if (e.target === els.logoutModal) els.logoutModal.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.logoutModal.classList.add('hidden');
    els.aliasModal.classList.add('hidden');
  }
});

els.btnConfirmLogout.addEventListener('click', async () => {
  els.logoutModal.classList.add('hidden');
  showToast('Desconectando conta...');
  try {
    state.selectedJid = null;
    state.lastQrUpdatedAt = 0;
    await apiJson('/api/auth/logout', { method: 'POST' });
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

els.btnResetAuth.addEventListener('click', async () => {
  const phase = state.status?.connection?.phase;
  if (phase !== 'logged_out') {
    const ok = window.confirm('Isso vai apagar a sessão atual em ./auth e gerar um novo QR Code para escanear no celular. Deseja continuar?');
    if (!ok) return;
  }
  showToast('Gerando novo QR Code...');
  try {
    state.lastQrUpdatedAt = 0;
    await apiJson('/api/auth/reset', { method: 'POST' });
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

pollLoop();
