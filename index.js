import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  prepareWAMessageMedia,
  downloadMediaMessage,
  jidNormalizedUser,
  proto
} from '@whiskeysockets/baileys';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import P from 'pino';
import qrcode from 'qrcode-terminal';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs/minimal');
const execFileAsync = promisify(execFile);

// ================= CONFIGURAÇÃO =================
const INPUT_AUDIO = path.resolve('./media/som.mp3');
const CACHE_OGG = path.resolve('./media/_cache_audio.ogg');
const CHATS_DB = path.resolve('./chats_ativos.json');
const MAX_AUDIO_SECONDS = 5;
const MAX_VIDEO_SECONDS = 5;
const MODO_CORTE_PADRAO = 'inteiro'; // 'inteiro' | 'centro' | 'esquerda' | 'direita' | 'cima' | 'baixo'
// ================================================

const silentLogger = P({ level: 'silent' });
const pendingAudioStickers = new Map();
const chatCustomAudios = new Map();
const embeddedAudios = new WeakMap();
const sentByBotIds = new Set();
const processedIds = new Set();
const startTimeSec = Math.floor(Date.now() / 1000);

let audioCache = { mtimeMs: 0, duracao: MAX_AUDIO_SECONDS };
let reconectando = false;

// Carrega/salva chats autorizados (evita disparar em conversas aleatórias)
function carregarChatsAtivos() {
  try {
    if (fs.existsSync(CHATS_DB)) {
      return new Set(JSON.parse(fs.readFileSync(CHATS_DB, 'utf8')));
    }
  } catch {}
  return new Set();
}

function salvarChatsAtivos(set) {
  fs.writeFileSync(CHATS_DB, JSON.stringify([...set], null, 2));
}

const chatsAtivos = carregarChatsAtivos();

// Hook no encode: reembala stickerMessage como 134 -> 1 -> 26 -> [sticker + 26: audio]
const origEncode = proto.Message.encode.bind(proto.Message);
proto.Message.encode = function (message, writer) {
  const sha = message?.stickerMessage?.fileSha256;
  const key = sha ? Buffer.from(sha).toString('base64') : null;

  if (key && pendingAudioStickers.has(key)) {
    const audioMsg = pendingAudioStickers.get(key);
    const w = writer || protobuf.Writer.create();

    const stickerBuf = proto.Message.StickerMessage.encode(message.stickerMessage).finish();
    const audioBuf = proto.Message.AudioMessage.encode(audioMsg).finish();

    const stickerComAudio = Buffer.concat([
      stickerBuf,
      protobuf.Writer.create().uint32((26 << 3) | 2).bytes(audioBuf).finish()
    ]);

    const innerMessage = protobuf.Writer.create()
      .uint32((26 << 3) | 2)
      .bytes(stickerComAudio)
      .finish();

    const futureProof = protobuf.Writer.create()
      .uint32((1 << 3) | 2)
      .bytes(innerMessage)
      .finish();

    w.uint32((134 << 3) | 2).bytes(futureProof);

    const resto = { ...message };
    delete resto.stickerMessage;
    origEncode(resto, w);

    return w;
  }

  return origEncode(message, writer);
};

function lerCamposBytes(buf, targetFieldNo) {
  const results = [];
  const r = protobuf.Reader.create(buf);
  while (r.pos < r.len) {
    const tag = r.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === targetFieldNo && wireType === 2) {
      results.push(r.bytes());
    } else {
      r.skipType(wireType);
    }
  }
  return results;
}

function extrairAudioEmbutidoTag134(futureProofBytes) {
  try {
    for (const innerBytes of lerCamposBytes(futureProofBytes, 1)) {
      for (const stickerBytes of lerCamposBytes(innerBytes, 26)) {
        for (const audioBytes of lerCamposBytes(stickerBytes, 26)) {
          return proto.Message.AudioMessage.decode(audioBytes);
        }
      }
    }
  } catch {
    // Ignora se o áudio interno não for decodificável
  }
  return null;
}

// Hook no decode: WAProto atual ignora a tag 134 (Audio Sticker), então extrai o stickerMessage interno
function extrairStickerDeTag134(rawBytes) {
  for (const futureProofBytes of lerCamposBytes(rawBytes, 134)) {
    const fp = proto.Message.FutureProofMessage.decode(futureProofBytes);
    if (fp?.message?.stickerMessage) {
      const audioMsg = extrairAudioEmbutidoTag134(futureProofBytes);
      if (audioMsg) {
        embeddedAudios.set(fp.message.stickerMessage, audioMsg);
      }
      return fp.message.stickerMessage;
    }
  }
  return null;
}

const origDecode = proto.Message.decode.bind(proto.Message);
proto.Message.decode = function (reader, length, endTag) {
  let rawBytes = null;
  let startPos = 0;

  if (reader instanceof Uint8Array) {
    rawBytes = length === undefined ? reader : reader.subarray(0, length);
  } else if (reader && reader.buf instanceof Uint8Array) {
    startPos = reader.pos;
  }

  const decoded = origDecode(reader, length, endTag);

  if (!decoded.stickerMessage) {
    if (!rawBytes && reader && reader.buf instanceof Uint8Array) {
      rawBytes = reader.buf.subarray(startPos, reader.pos);
    }
    if (rawBytes && rawBytes.length > 0) {
      try {
        const sticker = extrairStickerDeTag134(rawBytes);
        if (sticker) {
          decoded.stickerMessage = sticker;
        }
      } catch {
        // Ignora caso a tag 134 não siga o layout esperado
      }
    }
  }

  return decoded;
};

async function obterDuracaoSegundos(arquivo) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      arquivo
    ]);
    return Math.max(1, Math.round(parseFloat(stdout.trim())));
  } catch {
    return MAX_AUDIO_SECONDS;
  }
}

async function converterParaAudioOgg(inPath, outOgg, maxSeconds = MAX_AUDIO_SECONDS) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inPath, '-vn', '-t', String(maxSeconds),
    '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000',
    '-avoid_negative_ts', 'make_zero',
    outOgg
  ]);
  return obterDuracaoSegundos(outOgg);
}

async function videoTemAudio(inPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inPath
    ]);
    return stdout.trim() === 'audio';
  } catch {
    return false;
  }
}

// Reutiliza o OGG em cache e só reconverte se ./media/som.mp3 for alterado
async function garantirAudioPronto() {
  if (!fs.existsSync(INPUT_AUDIO)) {
    throw new Error(`Arquivo de áudio não encontrado: ${INPUT_AUDIO}`);
  }

  const stat = fs.statSync(INPUT_AUDIO);
  if (fs.existsSync(CACHE_OGG) && audioCache.mtimeMs === stat.mtimeMs) {
    return { oggPath: CACHE_OGG, duracao: audioCache.duracao };
  }

  console.log('🔊 Atualizando cache de áudio (OGG/Opus) a partir de som.mp3...');
  const duracao = await converterParaAudioOgg(INPUT_AUDIO, CACHE_OGG, MAX_AUDIO_SECONDS);
  audioCache = { mtimeMs: stat.mtimeMs, duracao };
  return { oggPath: CACHE_OGG, duracao };
}

const MODOS_CORTE_CROP = {
  esquerda: '0:(ih-512)/2',
  direita: 'iw-512:(ih-512)/2',
  cima: '(iw-512)/2:0',
  baixo: '(iw-512)/2:ih-512',
  centro: '(iw-512)/2:(ih-512)/2'
};

function filtroEscala(modo, isVideo) {
  const fps = isVideo ? 'fps=15,' : '';
  const cropPos = MODOS_CORTE_CROP[modo];
  if (cropPos) {
    return `${fps}scale=512:512:force_original_aspect_ratio=increase,crop=512:512:${cropPos}`;
  }
  return `${fps}scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
}

async function converterImagemParaWebp(inPath, outWebp, modo) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inPath,
    '-vf', filtroEscala(modo, false),
    '-vcodec', 'libwebp', '-lossless', '1',
    outWebp
  ]);
}

async function converterVideoParaWebp(inPath, outWebp, modo) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inPath, '-t', String(MAX_VIDEO_SECONDS),
    '-vf', filtroEscala(modo, true),
    '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6',
    '-q:v', '60', '-loop', '0', '-preset', 'picture', '-an', '-vsync', '0',
    outWebp
  ]);

  // Se passou de 500 KB (limite do WhatsApp), recomprime automaticamente
  if (fs.statSync(outWebp).size > 490 * 1024) {
    console.log('⚠️  WebP animado > 490 KB, recomprimindo automaticamente...');
    const filtroMenor = filtroEscala(modo, true).replace('fps=15', 'fps=10');
    await execFileAsync('ffmpeg', [
      '-y', '-i', inPath, '-t', '4',
      '-vf', filtroMenor,
      '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6',
      '-q:v', '30', '-loop', '0', '-preset', 'picture', '-an', '-vsync', '0',
      outWebp
    ]);
    return 4;
  }
  return MAX_VIDEO_SECONDS;
}

function desembrulharMensagem(msg) {
  let atual = msg;
  while (atual) {
    if (atual.ephemeralMessage?.message) atual = atual.ephemeralMessage.message;
    else if (atual.viewOnceMessage?.message) atual = atual.viewOnceMessage.message;
    else if (atual.viewOnceMessageV2?.message) atual = atual.viewOnceMessageV2.message;
    else break;
  }
  return atual;
}

function extrairTexto(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    ''
  ).trim();
}

const ALIAS_MODOS_CORTE = [
  ['esquerda', 'esquerda'],
  ['direita', 'direita'],
  ['cima', 'cima'],
  ['topo', 'cima'],
  ['baixo', 'baixo'],
  ['centro', 'centro'],
  ['corte', 'centro'],
  ['inteiro', 'inteiro']
];

function detectarModoCorte(caption = '') {
  const c = (caption || '').toLowerCase();
  for (const [termo, modo] of ALIAS_MODOS_CORTE) {
    if (c.includes(termo)) return modo;
  }
  return MODO_CORTE_PADRAO;
}

function devePreservarAudioOriginal(caption = '') {
  const c = (caption || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return (
    c.includes('original') ||
    c.includes('preservar') ||
    c.includes('manter audio') ||
    c.includes('manter som')
  );
}

function registrarIdEnviado(id) {
  if (!id) return;
  sentByBotIds.add(id);
  setTimeout(() => sentByBotIds.delete(id), 60_000);
}

function construirContextInfoReply(sock, jid, quotedMsg) {
  if (!quotedMsg?.key?.id || !quotedMsg?.message) return null;
  const inner = desembrulharMensagem(quotedMsg.message);
  if (!inner || typeof inner !== 'object') return null;
  const msgType = ['stickerMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']
    .find((t) => inner[t]);
  if (!msgType) return null;

  const rawParticipant = quotedMsg.key.fromMe
    ? (jid.endsWith('@lid') ? sock.user?.lid || sock.user?.id : sock.user?.id)
    : quotedMsg.participant || quotedMsg.key.participant || quotedMsg.key.remoteJid;
  const participant = jidNormalizedUser(rawParticipant || jid);

  const quotedContent = { ...inner[msgType] };
  delete quotedContent.contextInfo;

  const contextInfo = {
    stanzaId: quotedMsg.key.id,
    participant,
    quotedMessage: proto.Message.create({ [msgType]: quotedContent })
  };
  if (quotedMsg.key.remoteJid && jid !== quotedMsg.key.remoteJid) {
    contextInfo.remoteJid = quotedMsg.key.remoteJid;
  }
  return proto.ContextInfo.create(contextInfo);
}

async function enviarAudioSticker(sock, jid, webpPath, isAnimated, audioInfo = null, replyToMsg = null) {
  const { oggPath, duracao } = audioInfo || (await garantirAudioPronto());

  const stickerMedia = await prepareWAMessageMedia(
    { sticker: { url: webpPath } },
    { upload: sock.waUploadToServer }
  );

  const audioMedia = await prepareWAMessageMedia(
    { audio: { url: oggPath }, mimetype: 'audio/ogg; codecs=opus', ptt: false },
    { upload: sock.waUploadToServer }
  );

  stickerMedia.stickerMessage.width = 512;
  stickerMedia.stickerMessage.height = 512;
  stickerMedia.stickerMessage.isAnimated = isAnimated;
  stickerMedia.stickerMessage.stickerSentTs = Date.now();
  stickerMedia.stickerMessage.isAvatar = false;
  stickerMedia.stickerMessage.isAiSticker = false;
  stickerMedia.stickerMessage.isLottie = false;

  if (!audioMedia.audioMessage.seconds) {
    audioMedia.audioMessage.seconds = duracao;
  }

  const key = Buffer.from(stickerMedia.stickerMessage.fileSha256).toString('base64');
  pendingAudioStickers.set(key, audioMedia.audioMessage);

  const enviarComId = async () => {
    const messageId = '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
    // Registra antes de enviar para impedir loop mesmo se o upsert chegar antes do resolve
    registrarIdEnviado(messageId);
    await sock.relayMessage(
      jid,
      { stickerMessage: stickerMedia.stickerMessage },
      { messageId }
    );
    return messageId;
  };

  try {
    let messageId;
    if (replyToMsg) {
      try {
        const contextInfo = construirContextInfoReply(sock, jid, replyToMsg);
        if (contextInfo) {
          stickerMedia.stickerMessage.contextInfo = contextInfo;
        }
        messageId = await enviarComId();
      } catch (replyErr) {
        console.warn(
          `⚠️  Falha ao enviar Audio Sticker como reply (${replyErr.message || replyErr}); enviando como nova mensagem...`
        );
        delete stickerMedia.stickerMessage.contextInfo;
        messageId = await enviarComId();
      }
    } else {
      messageId = await enviarComId();
    }
    console.log(`✅ Audio Sticker (${isAnimated ? 'animado' : 'estático'}) enviado para ${jid} | ID: ${messageId}`);
  } finally {
    pendingAudioStickers.delete(key);
  }
}

function extrairContextInfo(content) {
  for (const key of ['extendedTextMessage', 'stickerMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
    if (content?.[key]?.contextInfo) return content[key].contextInfo;
  }
  return null;
}

function obterMensagemCitada(jid, contextInfo) {
  if (!contextInfo?.quotedMessage) return null;
  return {
    key: {
      remoteJid: jid,
      id: contextInfo.stanzaId,
      participant: contextInfo.participant
    },
    content: desembrulharMensagem(contextInfo.quotedMessage)
  };
}

function extrairMidiaVisual(content) {
  if (content?.stickerMessage) return { type: 'stickerMessage', media: content.stickerMessage };
  if (content?.imageMessage) return { type: 'imageMessage', media: content.imageMessage };
  if (content?.videoMessage) return { type: 'videoMessage', media: content.videoMessage };
  return null;
}

function extrairOrigemAudio(content) {
  if (content?.audioMessage) {
    return { msgContent: { audioMessage: content.audioMessage }, isVideo: false, label: 'áudio' };
  }
  if (content?.documentMessage?.mimetype?.startsWith('audio/')) {
    return { msgContent: { documentMessage: content.documentMessage }, isVideo: false, label: 'arquivo de áudio' };
  }
  if (content?.videoMessage) {
    return { msgContent: { videoMessage: content.videoMessage }, isVideo: true, label: 'áudio do vídeo' };
  }
  if (content?.stickerMessage && embeddedAudios.has(content.stickerMessage)) {
    return { msgContent: { audioMessage: embeddedAudios.get(content.stickerMessage) }, isVideo: false, label: 'áudio do sticker' };
  }
  return null;
}

async function enviarTexto(sock, jid, text) {
  const sent = await sock.sendMessage(jid, { text });
  registrarIdEnviado(sent?.key?.id);
  return sent;
}

async function deletarParaMim(sock, jid, msg) {
  if (!msg?.key?.id) return;
  try {
    const timestamp = Number(msg.messageTimestamp || 0) || Math.floor(Date.now() / 1000);
    await sock.chatModify(
      {
        deleteForMe: {
          deleteMedia: true,
          key: msg.key,
          timestamp
        }
      },
      jid
    );
  } catch (err) {
    console.warn(`⚠️  Não foi possível apagar mídia para mim (${err.message || err}).`);
  }
}

async function prepararAudioDeOrigem(sock, msgRef, audioSource, tempRawPath, outOggPath, maxSeconds = MAX_AUDIO_SECONDS) {
  const audioBuffer = await baixarMidia(sock, msgRef, audioSource.msgContent);
  fs.writeFileSync(tempRawPath, audioBuffer);
  if (audioSource.isVideo && !(await videoTemAudio(tempRawPath))) {
    return null;
  }
  const duracao = await converterParaAudioOgg(tempRawPath, outOggPath, maxSeconds);
  return { oggPath: outOggPath, duracao };
}

async function baixarMidia(sock, m, content) {
  const mediaType = ['stickerMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']
    .find((type) => content?.[type]);
  const media = mediaType ? content[mediaType] : null;

  try {
    return await downloadMediaMessage(
      { ...m, message: content },
      'buffer',
      {},
      { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
    );
  } catch (err) {
    const causeDetails = Array.isArray(err?.cause?.errors)
      ? err.cause.errors.map((e) => `${e.code || ''} ${e.message || e}`.trim()).join('; ')
      : '';
    const causeInfo = err?.cause
      ? `${err.cause.code || ''} ${err.cause.message || causeDetails || err.cause}`.trim()
      : 'sem cause';
    console.warn(
      `⚠️  Falha no download primário (${err.message || err}) | cause: ${causeInfo} | url: ${media?.url || 'ausente'} | directPath: ${media?.directPath || 'ausente'}`
    );

    if (mediaType && media?.directPath) {
      const dp = media.directPath.startsWith('/') ? media.directPath : `/${media.directPath}`;
      const fallbackUrl = `https://mmg.whatsapp.net${dp}`;
      console.log(`🔄 Tentando fallback via directPath: ${fallbackUrl}`);
      const fallbackContent = {
        ...content,
        [mediaType]: {
          ...media,
          directPath: dp,
          url: fallbackUrl
        }
      };
      return await downloadMediaMessage(
        { ...m, message: fallbackContent },
        'buffer',
        {},
        { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
      );
    }

    throw err;
  }
}

async function processarMidiaRecebida(sock, m, content, options = {}) {
  const jid = m.key.remoteJid;
  const uid = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const tempIn = path.resolve(`./media/_tmp_in_${uid}`);
  const tempWebp = path.resolve(`./media/_tmp_out_${uid}.webp`);
  const tempAudioIn = path.resolve(`./media/_tmp_audio_in_${uid}`);
  const tempOgg = path.resolve(`./media/_tmp_audio_${uid}.ogg`);

  try {
    const buffer = await baixarMidia(sock, m, content);

    let isAnimated = false;
    let audioInfo = null;
    let duracaoMax = MAX_AUDIO_SECONDS;
    const {
      customAudioMsg = null,
      customAudioSource = null,
      replyToMsg = null,
      deleteForMeMsg = null
    } = options;

    if (content.stickerMessage) {
      if (content.stickerMessage.isLottie) {
        console.warn('⚠️  Stickers Lottie não são WebP; ignorando.');
        return;
      }
      // Reaproveita o WebP original diretamente (estático ou animado)
      isAnimated = Boolean(content.stickerMessage.isAnimated) || buffer.includes(Buffer.from('ANIM'));
      fs.writeFileSync(tempWebp, buffer);
      console.log(`🧩 Sticker ${isAnimated ? 'animado' : 'estático'} recebido -> preparando áudio...`);
    } else if (content.imageMessage) {
      const modo = detectarModoCorte(content.imageMessage.caption);
      fs.writeFileSync(tempIn, buffer);
      console.log(`🖼️  Imagem recebida (modo: ${modo}) -> convertendo...`);
      await converterImagemParaWebp(tempIn, tempWebp, modo);
      isAnimated = false;
    } else if (content.videoMessage) {
      const caption = content.videoMessage.caption;
      const modo = detectarModoCorte(caption);
      const preservarAudio = !customAudioSource && devePreservarAudioOriginal(caption);
      fs.writeFileSync(tempIn, buffer);
      console.log(
        `🎬 Vídeo recebido (modo: ${modo} | áudio: ${customAudioSource ? customAudioSource.label : preservarAudio ? 'original' : 'padrão'}) -> convertendo para WebP animado...`
      );
      duracaoMax = await converterVideoParaWebp(tempIn, tempWebp, modo);
      if (preservarAudio) {
        if (await videoTemAudio(tempIn)) {
          const duracao = await converterParaAudioOgg(tempIn, tempOgg, duracaoMax);
          audioInfo = { oggPath: tempOgg, duracao };
        } else {
          console.warn('⚠️  Vídeo sem faixa de áudio original; usando áudio padrão.');
        }
      }
      isAnimated = true;
    } else {
      return;
    }

    if (customAudioSource) {
      console.log(`🎵 Baixando ${customAudioSource.label} personalizado...`);
      audioInfo = await prepararAudioDeOrigem(
        sock,
        customAudioMsg || m,
        customAudioSource,
        tempAudioIn,
        tempOgg,
        duracaoMax
      );
      if (!audioInfo) {
        console.warn('⚠️  Mídia de áudio citada não possui trilha de áudio; usando áudio padrão.');
      }
    }

    if (!audioInfo && chatCustomAudios.has(jid)) {
      const chatAudio = chatCustomAudios.get(jid);
      if (fs.existsSync(chatAudio.oggPath)) {
        audioInfo = chatAudio;
      } else {
        chatCustomAudios.delete(jid);
      }
    }

    const kb = (fs.statSync(tempWebp).size / 1024).toFixed(1);
    console.log(`📦 WebP pronto (${kb} KB). Enviando com áudio...`);
    await enviarAudioSticker(sock, jid, tempWebp, isAnimated, audioInfo, replyToMsg);
    if (deleteForMeMsg) {
      await deletarParaMim(sock, jid, deleteForMeMsg);
    }
  } catch (err) {
    console.error('❌ Erro ao processar mídia:', err.message || err);
    if (err?.cause) {
      console.error('   ↳ cause:', err.cause);
    }
  } finally {
    for (const file of [tempIn, tempWebp, tempAudioIn, tempOgg]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

function ehChatProprio(sock, state, jid) {
  const normJid = jidNormalizedUser(jid);
  if (!normJid) return false;
  const meId = sock.user?.id || state.creds?.me?.id;
  const meLid = sock.user?.lid || state.creds?.me?.lid;
  return Boolean(
    (meId && normJid === jidNormalizedUser(meId)) ||
    (meLid && normJid === jidNormalizedUser(meLid))
  );
}

async function iniciar() {
  await garantirAudioPronto();

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: silentLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const id = m.key?.id;
      const jid = m.key?.remoteJid;
      if (!id || !jid || !m.message) continue;
      if (sentByBotIds.has(id) || processedIds.has(id)) continue;

      // Em chats com terceiros/grupos, ignora mensagens enviadas por você (fromMe),
      // mantendo comandos e mídias próprios liberados apenas na conversa consigo mesmo
      const ehProprio = ehChatProprio(sock, state, jid);
      if (m.key.fromMe && !ehProprio) continue;

      // Ignora mensagens antigas de histórico sincronizado
      const ts = Number(m.messageTimestamp || 0);
      if (ts > 0 && ts < startTimeSec - 5) continue;

      processedIds.add(id);
      if (processedIds.size > 500) {
        const first = processedIds.values().next().value;
        processedIds.delete(first);
      }

      const content = desembrulharMensagem(m.message);
      const texto = extrairTexto(content).toLowerCase();

      // Comandos para liberar ou travar o chat atual
      if (texto === '!ativar') {
        chatsAtivos.add(jid);
        salvarChatsAtivos(chatsAtivos);
        console.log(`✅ Fábrica ativada no chat: ${jid}`);
        await enviarTexto(
          sock,
          jid,
          '✅ Fábrica de figurinhas com áudio *ATIVADA* neste chat.\nEnvie figurinhas, imagens ou vídeos.\n• Legenda (imagem/vídeo): `inteiro`, `centro`, `esquerda`, `direita`, `cima` ou `baixo`\n• Áudio do próprio vídeo: adicione `original` na legenda\n• Áudio personalizado: responda um áudio com a mídia (ou responda a mídia com um áudio), ou responda um áudio com `!audio` (`!audio padrao` para voltar)\nUse `!desativar` para desligar.'
        );
        continue;
      }

      if (texto === '!desativar') {
        chatsAtivos.delete(jid);
        salvarChatsAtivos(chatsAtivos);
        console.log(`🛑 Fábrica desativada no chat: ${jid}`);
        await enviarTexto(sock, jid, '🛑 Fábrica de figurinhas *DESATIVADA* neste chat.');
        continue;
      }

      if (!chatsAtivos.has(jid)) continue;

      if (['!audio padrao', '!audio padrão', '!audio reset', '!audio limpar', '!som padrao', '!som padrão'].includes(texto)) {
        const anterior = chatCustomAudios.get(jid);
        chatCustomAudios.delete(jid);
        if (anterior?.oggPath && fs.existsSync(anterior.oggPath)) {
          fs.unlinkSync(anterior.oggPath);
        }
        await enviarTexto(sock, jid, '🔊 Este chat voltou a usar o *som.mp3* padrão.');
        continue;
      }

      if (texto === '!audio' || texto === '!som') {
        const quoted = obterMensagemCitada(jid, extrairContextInfo(content));
        const audioSource = quoted ? extrairOrigemAudio(quoted.content) : null;
        if (!audioSource) {
          await enviarTexto(
            sock,
            jid,
            'ℹ️ Para usar outro áudio neste chat:\n• *Responda* um áudio (ou vídeo/audio-sticker) com `!audio` para fixá-lo temporariamente aqui\n• Ou *responda* um áudio diretamente enviando a imagem/vídeo/figurinha (e vice-versa)\n• Use `!audio padrao` para voltar ao `som.mp3`.'
          );
          continue;
        }

        const safeJid = jid.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tempRaw = path.resolve(`./media/_tmp_chat_audio_${safeJid}_${Date.now()}`);
        const chatOgg = path.resolve(`./media/_chat_audio_${safeJid}.ogg`);
        try {
          const info = await prepararAudioDeOrigem(
            sock,
            { key: quoted.key },
            audioSource,
            tempRaw,
            chatOgg,
            MAX_AUDIO_SECONDS
          );
          if (!info) {
            await enviarTexto(sock, jid, '⚠️ O vídeo respondido não possui faixa de áudio.');
            continue;
          }
          chatCustomAudios.set(jid, info);
          console.log(`🎵 Áudio personalizado definido para ${jid} (${info.duracao}s)`);
          await enviarTexto(
            sock,
            jid,
            `🔊 Áudio personalizado definido para este chat (${info.duracao}s)! As próximas figurinhas aqui usarão esse áudio.\nUse \`!audio padrao\` para voltar ao \`som.mp3\`.`
          );
        } catch (err) {
          console.error('❌ Erro ao definir áudio personalizado:', err.message || err);
          await enviarTexto(sock, jid, '❌ Não consegui baixar/converter esse áudio.');
        } finally {
          if (fs.existsSync(tempRaw)) fs.unlinkSync(tempRaw);
        }
        continue;
      }

      const quoted = obterMensagemCitada(jid, extrairContextInfo(content));
      const entregaOpts = ehProprio ? { deleteForMeMsg: m } : { replyToMsg: m };

      if (extrairMidiaVisual(content)) {
        const quotedAudio = quoted ? extrairOrigemAudio(quoted.content) : null;
        processarMidiaRecebida(
          sock,
          m,
          content,
          {
            ...entregaOpts,
            ...(quotedAudio ? { customAudioMsg: { key: quoted.key }, customAudioSource: quotedAudio } : {})
          }
        );
        continue;
      }

      const audioMsgSource = extrairOrigemAudio(content);
      if (audioMsgSource && !audioMsgSource.isVideo && quoted && extrairMidiaVisual(quoted.content)) {
        processarMidiaRecebida(
          sock,
          { key: quoted.key, message: quoted.content },
          quoted.content,
          { ...entregaOpts, customAudioMsg: m, customAudioSource: audioMsgSource }
        );
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const motivo = lastDisconnect?.error?.message || 'desconhecido';
      console.warn(`⚠️  Conexão fechada | statusCode: ${code} | motivo: ${motivo}`);

      if (code === DisconnectReason.loggedOut) {
        console.error('❌ Sessão deslogada (401). Apague ./auth e conecte novamente.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error('❌ Sessão substituída (440). Feche outra instância rodando.');
        return;
      }

      if (!reconectando) {
        reconectando = true;
        setTimeout(() => {
          reconectando = false;
          iniciar();
        }, 3000);
      }
    }

    if (connection === 'open') {
      console.log('🟢 Fábrica de Audio Stickers online!');
      console.log(`📌 Chats ativos: ${chatsAtivos.size > 0 ? [...chatsAtivos].join(', ') : 'nenhum (envie !ativar em um chat)'}`);
    }
  });
}

iniciar().catch((err) => {
  console.error('❌ Erro na inicialização:', err);
  process.exit(1);
});
