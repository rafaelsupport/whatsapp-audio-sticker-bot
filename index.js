import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  prepareWAMessageMedia,
  downloadMediaMessage,
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
const MODO_CORTE_PADRAO = 'inteiro'; // 'inteiro' | 'centro' | 'direita'
// ================================================

const silentLogger = P({ level: 'silent' });
const pendingAudioStickers = new Map();
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

function filtroEscala(modo, isVideo) {
  const fps = isVideo ? 'fps=15,' : '';
  if (modo === 'direita') {
    return `${fps}scale=512:512:force_original_aspect_ratio=increase,crop=512:512:iw-512:0`;
  }
  if (modo === 'centro') {
    return `${fps}scale=512:512:force_original_aspect_ratio=increase,crop=512:512`;
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

function detectarModoCorte(caption = '') {
  const c = (caption || '').toLowerCase();
  if (c.includes('direita')) return 'direita';
  if (c.includes('corte') || c.includes('centro')) return 'centro';
  if (c.includes('inteiro')) return 'inteiro';
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

async function enviarAudioSticker(sock, jid, webpPath, isAnimated, audioInfo = null) {
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
  const messageId = '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();

  // Registra antes de enviar para impedir loop mesmo se o upsert chegar antes do resolve
  sentByBotIds.add(messageId);
  pendingAudioStickers.set(key, audioMedia.audioMessage);

  try {
    await sock.relayMessage(
      jid,
      { stickerMessage: stickerMedia.stickerMessage },
      { messageId }
    );
    console.log(`✅ Audio Sticker (${isAnimated ? 'animado' : 'estático'}) enviado para ${jid} | ID: ${messageId}`);
  } finally {
    pendingAudioStickers.delete(key);
    setTimeout(() => sentByBotIds.delete(messageId), 60_000);
  }
}

async function baixarMidia(sock, m, content) {
  const mediaType = content?.stickerMessage
    ? 'stickerMessage'
    : content?.imageMessage
      ? 'imageMessage'
      : content?.videoMessage
        ? 'videoMessage'
        : null;
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

async function processarMidiaRecebida(sock, m, content) {
  const jid = m.key.remoteJid;
  const uid = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const tempIn = path.resolve(`./media/_tmp_in_${uid}`);
  const tempWebp = path.resolve(`./media/_tmp_out_${uid}.webp`);
  const tempOgg = path.resolve(`./media/_tmp_audio_${uid}.ogg`);

  try {
    const buffer = await baixarMidia(sock, m, content);

    let isAnimated = false;
    let audioInfo = null;

    if (content.stickerMessage) {
      if (content.stickerMessage.isLottie) {
        console.warn('⚠️  Stickers Lottie não são WebP; ignorando.');
        return;
      }
      // Reaproveita o WebP original diretamente (estático ou animado)
      isAnimated = Boolean(content.stickerMessage.isAnimated) || buffer.includes(Buffer.from('ANIM'));
      fs.writeFileSync(tempWebp, buffer);
      console.log(`🧩 Sticker ${isAnimated ? 'animado' : 'estático'} recebido -> acoplando som.mp3...`);
    } else if (content.imageMessage) {
      const modo = detectarModoCorte(content.imageMessage.caption);
      fs.writeFileSync(tempIn, buffer);
      console.log(`🖼️  Imagem recebida (modo: ${modo}) -> convertendo...`);
      await converterImagemParaWebp(tempIn, tempWebp, modo);
      isAnimated = false;
    } else if (content.videoMessage) {
      const caption = content.videoMessage.caption;
      const modo = detectarModoCorte(caption);
      const preservarAudio = devePreservarAudioOriginal(caption);
      fs.writeFileSync(tempIn, buffer);
      console.log(
        `🎬 Vídeo recebido (modo: ${modo} | áudio: ${preservarAudio ? 'original' : 'som.mp3'}) -> convertendo para WebP animado...`
      );
      const duracaoVideo = await converterVideoParaWebp(tempIn, tempWebp, modo);
      if (preservarAudio) {
        if (await videoTemAudio(tempIn)) {
          const duracao = await converterParaAudioOgg(tempIn, tempOgg, duracaoVideo);
          audioInfo = { oggPath: tempOgg, duracao };
        } else {
          console.warn('⚠️  Vídeo sem faixa de áudio original; usando som.mp3 padrão.');
        }
      }
      isAnimated = true;
    } else {
      return;
    }

    const kb = (fs.statSync(tempWebp).size / 1024).toFixed(1);
    console.log(`📦 WebP pronto (${kb} KB). Enviando com áudio...`);
    await enviarAudioSticker(sock, jid, tempWebp, isAnimated, audioInfo);
  } catch (err) {
    console.error('❌ Erro ao processar mídia:', err.message || err);
    if (err?.cause) {
      console.error('   ↳ cause:', err.cause);
    }
  } finally {
    for (const file of [tempIn, tempWebp, tempOgg]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
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
        const sent = await sock.sendMessage(jid, {
          text: '✅ Fábrica de figurinhas com áudio *ATIVADA* neste chat.\nEnvie figurinhas, imagens ou vídeos (legenda opcional: `centro`, `direita` ou `inteiro`; em vídeos, adicione `original` para preservar o áudio do vídeo).\nUse `!desativar` para desligar.'
        });
        if (sent?.key?.id) sentByBotIds.add(sent.key.id);
        continue;
      }

      if (texto === '!desativar') {
        chatsAtivos.delete(jid);
        salvarChatsAtivos(chatsAtivos);
        console.log(`🛑 Fábrica desativada no chat: ${jid}`);
        const sent = await sock.sendMessage(jid, {
          text: '🛑 Fábrica de figurinhas *DESATIVADA* neste chat.'
        });
        if (sent?.key?.id) sentByBotIds.add(sent.key.id);
        continue;
      }

      if (!chatsAtivos.has(jid)) continue;

      if (content?.stickerMessage || content?.imageMessage || content?.videoMessage) {
        processarMidiaRecebida(sock, m, content);
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
