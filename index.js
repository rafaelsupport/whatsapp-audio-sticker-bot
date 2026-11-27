import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  prepareWAMessageMedia,
  downloadMediaMessage,
  isJidGroup,
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
import { criarGerenciadorWeb } from './web.js';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs/minimal');
const execFileAsync = promisify(execFile);

// ================= CONFIGURAÇÃO =================
const INPUT_AUDIO = path.resolve('./media/som.mp3');
const CACHE_OGG = path.resolve('./media/_cache_audio.ogg');
const CHATS_DB = path.resolve('./chats_ativos.json');
const MAX_AUDIO_SECONDS = 5;
const MAX_VIDEO_SECONDS = 5;
const MAX_CONCURRENT_JOBS = 2;
const MODO_CORTE_PADRAO = 'inteiro'; // 'inteiro' | 'centro' | 'esquerda' | 'direita' | 'cima' | 'baixo'
// ================================================

const silentLogger = P({ level: 'silent' });
const baileysLogger = P({ level: 'error' });
const pendingAudioStickers = new Map();
const chatCustomAudios = new Map();
const embeddedAudios = new WeakMap();
const sentByBotIds = new Set();
const processedIds = new Set();
const filaProcessamento = [];

let startTimeSec = Math.floor(Date.now() / 1000);
let audioCache = { mtimeMs: 0, duracao: MAX_AUDIO_SECONDS };
let reconectando = false;
let jobsEmExecucao = 0;
let activeSock = null;
let activeState = null;
let whatsappConectado = false;
let connectionPhase = 'connecting';
let currentQr = '';
let currentQrUpdatedAt = 0;
let lastDisconnectInfo = null;

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
  esquerda: '0:(ih-S)/2',
  direita: 'iw-S:(ih-S)/2',
  cima: '(iw-S)/2:0',
  baixo: '(iw-S)/2:ih-S',
  centro: '(iw-S)/2:(ih-S)/2'
};

function filtroEscala(modo, isVideo, fps = 15, tamanho = 512) {
  const prefixoFps = isVideo ? `fps=${fps},` : '';
  const cropTemplate = MODOS_CORTE_CROP[modo];
  const base = cropTemplate
    ? `${prefixoFps}scale=${tamanho}:${tamanho}:force_original_aspect_ratio=increase,crop=${tamanho}:${tamanho}:${cropTemplate.replace(/S/g, String(tamanho))}`
    : `${prefixoFps}format=rgba,scale=${tamanho}:${tamanho}:force_original_aspect_ratio=decrease,pad=${tamanho}:${tamanho}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

  return tamanho < 512 ? `${base},scale=512:512:flags=fast_bilinear` : base;
}

async function converterImagemParaWebp(inPath, outWebp, modo) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inPath,
    '-vf', filtroEscala(modo, false),
    '-vcodec', 'libwebp', '-lossless', '1',
    outWebp
  ]);
}

const PERFIS_VIDEO_WEBP = [
  { duracao: MAX_VIDEO_SECONDS, fps: 15, qualidade: 60, tamanho: 512 },
  { duracao: 4, fps: 10, qualidade: 30, tamanho: 512 },
  { duracao: 3, fps: 8, qualidade: 20, tamanho: 384 },
  { duracao: 2, fps: 6, qualidade: 15, tamanho: 320 }
];

async function converterVideoParaWebp(inPath, outWebp, modo) {
  const limiteBytes = 490 * 1024;
  for (let i = 0; i < PERFIS_VIDEO_WEBP.length; i++) {
    const { duracao, fps, qualidade, tamanho } = PERFIS_VIDEO_WEBP[i];
    if (i > 0) {
      console.log(`⚠️  WebP animado > 490 KB, recomprimindo (tentativa ${i + 1}: ${fps}fps, q=${qualidade}, ${duracao}s)...`);
    }
    await execFileAsync('ffmpeg', [
      '-y', '-i', inPath, '-t', String(duracao),
      '-vf', filtroEscala(modo, true, fps, tamanho),
      '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6',
      '-q:v', String(qualidade), '-loop', '0', '-preset', 'picture', '-an', '-vsync', '0',
      outWebp
    ]);
    if (fs.statSync(outWebp).size <= limiteBytes) {
      return duracao;
    }
  }
  return PERFIS_VIDEO_WEBP[PERFIS_VIDEO_WEBP.length - 1].duracao;
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

function montarContentMmg(content, mediaType, media) {
  const dp = media.directPath.startsWith('/') ? media.directPath : `/${media.directPath}`;
  return {
    ...content,
    [mediaType]: {
      ...media,
      directPath: dp,
      url: `https://mmg.whatsapp.net${dp}`
    }
  };
}

function precisaIrDiretoMmg(media) {
  if (!media?.directPath) return false;
  if (!media.url) return true;
  try {
    return new URL(media.url).hostname === 'a.whatsapp.net';
  } catch {
    return true;
  }
}

async function baixarMidia(sock, m, content) {
  const mediaType = ['stickerMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']
    .find((type) => content?.[type]);
  const media = mediaType ? content[mediaType] : null;
  const irDiretoMmg = Boolean(mediaType && precisaIrDiretoMmg(media));
  const conteudoInicial = irDiretoMmg ? montarContentMmg(content, mediaType, media) : content;

  try {
    return await downloadMediaMessage(
      { ...m, message: conteudoInicial },
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

    if (!irDiretoMmg && mediaType && media?.directPath) {
      const fallbackContent = montarContentMmg(content, mediaType, media);
      console.log(`🔄 Tentando fallback via directPath: ${fallbackContent[mediaType].url}`);
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

function avancarFila() {
  while (jobsEmExecucao < MAX_CONCURRENT_JOBS && filaProcessamento.length > 0) {
    const { tarefa, resolve, reject } = filaProcessamento.shift();
    jobsEmExecucao++;
    Promise.resolve()
      .then(tarefa)
      .then(resolve, reject)
      .finally(() => {
        jobsEmExecucao--;
        avancarFila();
      });
  }
}

function enfileirarProcessamento(tarefa) {
  return new Promise((resolve, reject) => {
    filaProcessamento.push({ tarefa, resolve, reject });
    avancarFila();
  });
}

function obterAudioPersonalizadoChat(...jids) {
  for (const jid of jids) {
    if (!jid || !chatCustomAudios.has(jid)) continue;
    const chatAudio = chatCustomAudios.get(jid);
    if (fs.existsSync(chatAudio.oggPath)) {
      return chatAudio;
    }
    chatCustomAudios.delete(jid);
  }
  return null;
}

function definirAudioPersonalizadoChat(info, ...jids) {
  for (const jid of jids) {
    if (jid) chatCustomAudios.set(jid, info);
  }
}

function limparAudioPersonalizadoChat(...jids) {
  for (const jid of jids) {
    if (!jid) continue;
    const anterior = chatCustomAudios.get(jid);
    chatCustomAudios.delete(jid);
    if (anterior?.oggPath && fs.existsSync(anterior.oggPath)) {
      fs.unlinkSync(anterior.oggPath);
    }
  }
}

function processarMidiaRecebida(sock, m, content, options = {}) {
  return enfileirarProcessamento(() => executarProcessamentoMidia(sock, m, content, options));
}

async function executarProcessamentoMidia(sock, m, content, options = {}) {
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
    let origemDescricao = 'Sticker';
    let detalheModo = '';
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
      origemDescricao = `Sticker ${isAnimated ? 'animado' : 'estático'} recebido`;
      console.log(`🧩 ${origemDescricao} -> preparando áudio...`);
    } else if (content.imageMessage) {
      const modo = detectarModoCorte(content.imageMessage.caption);
      fs.writeFileSync(tempIn, buffer);
      origemDescricao = 'Imagem recebida';
      detalheModo = `corte: ${modo}`;
      console.log(`🖼️  Imagem recebida (modo: ${modo}) -> convertendo...`);
      await converterImagemParaWebp(tempIn, tempWebp, modo);
      isAnimated = false;
    } else if (content.videoMessage) {
      const caption = content.videoMessage.caption;
      const modo = detectarModoCorte(caption);
      const preservarAudio = !customAudioSource && devePreservarAudioOriginal(caption);
      fs.writeFileSync(tempIn, buffer);
      origemDescricao = 'Vídeo recebido';
      detalheModo = `corte: ${modo}`;
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

    webManager.registrarEvento(jid, {
      direction: 'in',
      kind: 'media',
      text: origemDescricao,
      detail: detalheModo || undefined
    });

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

    if (!audioInfo) {
      audioInfo = obterAudioPersonalizadoChat(jid, m.key?.remoteJidAlt);
    }

    const kb = (fs.statSync(tempWebp).size / 1024).toFixed(1);
    console.log(`📦 WebP pronto (${kb} KB). Enviando com áudio...`);
    await enviarAudioSticker(sock, jid, tempWebp, isAnimated, audioInfo, replyToMsg);
    webManager.registrarEvento(jid, {
      direction: 'out',
      kind: 'sticker',
      text: `Audio Sticker (${isAnimated ? 'animado' : 'estático'}) enviado`,
      detail: `${kb} KB • ${audioInfo ? `${audioInfo.duracao}s personalizado` : 'som.mp3'}`
    });
    if (deleteForMeMsg) {
      await deletarParaMim(sock, jid, deleteForMeMsg);
    }
  } catch (err) {
    console.error('❌ Erro ao processar mídia:', err.message || err);
    if (err?.cause) {
      console.error('   ↳ cause:', err.cause);
    }
    webManager.registrarEvento(jid, {
      direction: 'system',
      kind: 'error',
      error: true,
      text: `Erro ao processar mídia: ${err.message || err}`
    });
  } finally {
    for (const file of [tempIn, tempWebp, tempAudioIn, tempOgg]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

function ehChatProprio(sock, state, ...jids) {
  const meId = sock.user?.id || state.creds?.me?.id;
  const meLid = sock.user?.lid || state.creds?.me?.lid;
  const normMeId = meId ? jidNormalizedUser(meId) : '';
  const normMeLid = meLid ? jidNormalizedUser(meLid) : '';

  return jids.some((jid) => {
    const normJid = jidNormalizedUser(jid);
    if (!normJid) return false;
    return Boolean((normMeId && normJid === normMeId) || (normMeLid && normJid === normMeLid));
  });
}

function chatEstaAtivo(...jids) {
  return jids.some((jid) => jid && chatsAtivos.has(jid));
}

function agendarReconexao(delayMs = 3000) {
  if (reconectando) return;
  reconectando = true;
  setTimeout(() => {
    reconectando = false;
    iniciar().catch((err) => {
      console.error('❌ Falha na reconexão:', err.message || err);
      agendarReconexao(5000);
    });
  }, delayMs);
}

const webManager = criarGerenciadorWeb({
  getSock: () => activeSock,
  isConnected: () => whatsappConectado,
  getMe: () => activeSock?.user || activeState?.creds?.me || null,
  isSelfChat: (jid, altJid) => ehChatProprio(activeSock || {}, activeState || {}, jid, altJid),
  isChatActive: (jid, altJid) => chatEstaAtivo(jid, altJid),
  getActiveJids: () => [...chatsAtivos],
  setChatActive: (jid, active, altJid) => {
    if (active) {
      chatsAtivos.add(jid);
    } else {
      chatsAtivos.delete(jid);
      if (altJid) chatsAtivos.delete(altJid);
    }
    salvarChatsAtivos(chatsAtivos);
    return active;
  },
  getChatCustomAudio: (jid, altJid) => obterAudioPersonalizadoChat(jid, altJid),
  resetChatCustomAudio: (jid, altJid) => limparAudioPersonalizadoChat(jid, altJid),
  getDefaultAudioInfo: () => ({ exists: fs.existsSync(INPUT_AUDIO), duracao: audioCache.duracao, duration: audioCache.duracao }),
  getDefaultAudioPaths: () => ({ mp3Path: INPUT_AUDIO, oggPath: CACHE_OGG }),
  getQueueInfo: () => ({ running: jobsEmExecucao, pending: filaProcessamento.length }),
  sendTextMessage: async (jid, text) => {
    if (!activeSock) throw new Error('Socket indisponível');
    return enviarTexto(activeSock, jid, text);
  },
  syncContacts: async () => {
    if (!activeSock || !activeState) throw new Error('Socket indisponível');
    return sincronizarAgendaWhatsApp(activeSock, activeState);
  },
  getConnectionInfo: () => ({
    connected: whatsappConectado,
    phase: connectionPhase,
    qr: currentQr,
    qrUpdatedAt: currentQrUpdatedAt,
    lastDisconnect: lastDisconnectInfo
  }),
  reconnect: async () => {
    const oldSock = activeSock;
    activeSock = null;
    whatsappConectado = false;
    connectionPhase = 'connecting';
    currentQr = '';
    reconectando = false;
    try {
      oldSock?.ws?.close();
    } catch {}
    await iniciar();
  },
  resetSession: async () => {
    const oldSock = activeSock;
    activeSock = null;
    whatsappConectado = false;
    connectionPhase = 'connecting';
    currentQr = '';
    currentQrUpdatedAt = 0;
    lastDisconnectInfo = null;
    reconectando = false;
    startTimeSec = Math.floor(Date.now() / 1000);
    try {
      oldSock?.ws?.close();
    } catch {}
    fs.rmSync(path.resolve('./auth'), { recursive: true, force: true });
    await iniciar();
  }
});

let sincronizandoAgenda = false;
async function sincronizarAgendaWhatsApp(sock, state) {
  if (sincronizandoAgenda) return 0;
  sincronizandoAgenda = true;
  let count = 0;
  const contar = (lista = []) => {
    count += lista.length;
  };
  sock.ev.on('contacts.upsert', contar);
  try {
    await state.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
    await sock.resyncAppState(['critical_unblock_low'], false);
    webManager.marcarAgendaSincronizada();
    console.log(`📇 Agenda sincronizada (${count} contatos recebidos do WhatsApp).`);
    return count;
  } catch (err) {
    console.warn(`⚠️  Não foi possível sincronizar agenda (${err.message || err}).`);
    return 0;
  } finally {
    sock.ev.off('contacts.upsert', contar);
    sincronizandoAgenda = false;
  }
}

function sincronizarContatosLista(lista = []) {
  for (const c of lista) {
    if (!c?.id) continue;
    const base = {
      phone: c.phoneNumber,
      name: c.name || c.verifiedName,
      notify: c.notify
    };
    webManager.registrarContato({ ...base, jid: c.id, altJid: c.lid });
    if (c.lid) {
      webManager.registrarContato({ ...base, jid: c.lid, altJid: c.id });
    }
  }
}

async function iniciar() {
  await garantirAudioPronto();

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
  });

  activeSock = sock;
  activeState = state;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('contacts.upsert', sincronizarContatosLista);
  sock.ev.on('contacts.update', sincronizarContatosLista);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (activeSock !== sock) return;
    for (const m of messages) {
      const id = m.key?.id;
      const jid = m.key?.remoteJid;
      const altJid = m.key?.remoteJidAlt;
      if (!id || !jid) continue;
      if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

      if (isJidGroup(jid)) {
        webManager.registrarContato({ jid });
        if (m.key.participant && !m.key.fromMe) {
          webManager.registrarContato({
            jid: m.key.participant,
            altJid: m.key.participantAlt,
            pushName: m.pushName
          });
        }
      } else {
        webManager.registrarContato({
          jid,
          altJid,
          pushName: m.key.fromMe ? '' : m.pushName
        });
      }

      if (sentByBotIds.has(id) || processedIds.has(id)) continue;

      // Ignora mensagens antigas de histórico sincronizado
      const ts = Number(m.messageTimestamp || 0);
      if (ts > 0 && ts < startTimeSec - 5) continue;

      if (!m.message) {
        if (chatEstaAtivo(jid, altJid)) {
          console.warn(
            `⚠️  Mensagem sem payload (type=${type} | jid=${jid}${altJid ? ` | alt=${altJid}` : ''} | fromMe=${Boolean(m.key?.fromMe)} | stub=${m.messageStubType ?? 'nenhum'} | params=${JSON.stringify(m.messageStubParameters || [])})`
          );
        }
        continue;
      }

      const ehProprio = ehChatProprio(sock, state, jid, altJid);
      const ativo = chatEstaAtivo(jid, altJid);

      // Em chats com terceiros/grupos, ignora mensagens enviadas por você (fromMe),
      // mantendo comandos e mídias próprios liberados apenas na conversa consigo mesmo
      if (m.key.fromMe && !ehProprio) {
        if (ativo) {
          console.log(`⏭️  Ignorando mensagem própria (fromMe) em chat de terceiro: ${jid}`);
        }
        continue;
      }

      processedIds.add(id);
      if (processedIds.size > 500) {
        const first = processedIds.values().next().value;
        processedIds.delete(first);
      }

      const content = desembrulharMensagem(m.message);
      const texto = extrairTexto(content).toLowerCase();

      if (ativo || texto.startsWith('!')) {
        console.log(
          `📩 [UPSERT:${type}] jid=${jid}${altJid ? ` | alt=${altJid}` : ''} | fromMe=${Boolean(m.key?.fromMe)} | keys=${Object.keys(content || {}).join(',') || 'vazio'}`
        );
      }

      // Comandos para liberar ou travar o chat atual
      if (texto === '!ativar') {
        chatsAtivos.add(jid);
        salvarChatsAtivos(chatsAtivos);
        console.log(`✅ Fábrica ativada no chat: ${jid}`);
        webManager.registrarEvento(jid, { direction: 'in', kind: 'cmd', text: '!ativar' });
        await enviarTexto(
          sock,
          jid,
          '✅ Fábrica de figurinhas com áudio *ATIVADA* neste chat.\nEnvie figurinhas, imagens ou vídeos.\n• Legenda (imagem/vídeo): `inteiro`, `centro`, `esquerda`, `direita`, `cima` ou `baixo`\n• Áudio do próprio vídeo: adicione `original` na legenda\n• Áudio personalizado: responda um áudio com a mídia (ou responda a mídia com um áudio), ou responda um áudio com `!audio` (`!audio padrao` para voltar)\nUse `!desativar` para desligar.'
        );
        continue;
      }

      if (texto === '!desativar') {
        chatsAtivos.delete(jid);
        if (altJid) chatsAtivos.delete(altJid);
        salvarChatsAtivos(chatsAtivos);
        console.log(`🛑 Fábrica desativada no chat: ${jid}`);
        webManager.registrarEvento(jid, { direction: 'in', kind: 'cmd', text: '!desativar' });
        await enviarTexto(sock, jid, '🛑 Fábrica de figurinhas *DESATIVADA* neste chat.');
        continue;
      }

      if (!ativo) continue;

      if (['!audio padrao', '!audio padrão', '!audio reset', '!audio limpar', '!som padrao', '!som padrão'].includes(texto)) {
        limparAudioPersonalizadoChat(jid, altJid);
        webManager.registrarEvento(jid, { direction: 'in', kind: 'cmd', text: texto });
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
          definirAudioPersonalizadoChat(info, jid, altJid);
          console.log(`🎵 Áudio personalizado definido para ${jid} (${info.duracao}s)`);
          webManager.registrarEvento(jid, {
            direction: 'system',
            kind: 'audio',
            text: `Áudio personalizado definido via ${texto} (${info.duracao}s)`
          });
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
    if (activeSock !== sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = qr;
      currentQrUpdatedAt = Date.now();
      connectionPhase = 'qr';
      whatsappConectado = false;
      qrcode.generate(qr, { small: true });
    } else if (connection === 'connecting' && connectionPhase !== 'qr') {
      connectionPhase = 'connecting';
    }

    if (connection === 'close') {
      whatsappConectado = false;
      currentQr = '';
      const code = lastDisconnect?.error?.output?.statusCode;
      const motivo = lastDisconnect?.error?.message || 'desconhecido';
      lastDisconnectInfo = { code: code || null, reason: motivo, at: Date.now() };
      console.warn(`⚠️  Conexão fechada | statusCode: ${code} | motivo: ${motivo}`);

      if (code === DisconnectReason.loggedOut) {
        connectionPhase = 'logged_out';
        console.error('❌ Sessão deslogada (401). Gere um novo QR Code pelo painel web ou apague ./auth.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        connectionPhase = 'replaced';
        console.error('❌ Sessão substituída (440). Feche outra instância rodando.');
        return;
      }

      connectionPhase = 'close';
      agendarReconexao(3000);
    }

    if (connection === 'open') {
      whatsappConectado = true;
      connectionPhase = 'open';
      currentQr = '';
      currentQrUpdatedAt = 0;
      lastDisconnectInfo = null;
      console.log('🟢 Fábrica de Audio Stickers online!');
      console.log(`📌 Chats ativos: ${chatsAtivos.size > 0 ? [...chatsAtivos].join(', ') : 'nenhum (envie !ativar em um chat)'}`);
      if (!webManager.jaSincronizouAgenda()) {
        sincronizarAgendaWhatsApp(sock, state);
      }
    }
  });
}

webManager.iniciarServidor();

iniciar().catch((err) => {
  console.error('❌ Erro na inicialização:', err);
  process.exit(1);
});
