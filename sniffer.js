import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto
} from '@whiskeysockets/baileys';
import { createRequire } from 'module';
import P from 'pino';
import qrcode from 'qrcode-terminal';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs/minimal');

const TEST_NUMBER = process.env.TEST_NUMBER || '';

// Parser recursivo rigoroso para mapear todas as tags Protobuf reais
function inspecionarProtobuf(buf, nivel = 0) {
  const reader = protobuf.Reader.create(buf);
  const campos = [];

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;

    if (fieldNo === 0 || fieldNo > 50000) throw new Error('fieldNo inválido');

    if (wireType === 0) {
      campos.push({ fieldNo, wire: 'varint', val: reader.uint64().toString() });
    } else if (wireType === 1) {
      reader.skipType(1);
      campos.push({ fieldNo, wire: '64bit' });
    } else if (wireType === 2) {
      const len = reader.uint32();
      if (reader.pos + len > reader.len) throw new Error('tamanho fora do buffer');
      const bytes = reader.buf.subarray(reader.pos, reader.pos + len);
      reader.pos += len;

      const ehTexto = bytes.length > 0 && bytes.every((b) => b >= 32 && b <= 126);
      if (ehTexto) {
        const txt = Buffer.from(bytes).toString('utf8');
        campos.push({ fieldNo, wire: 'str', val: txt.length > 90 ? `${txt.slice(0, 90)}...` : txt });
      } else if (nivel < 5 && bytes.length >= 2) {
        try {
          const sub = inspecionarProtobuf(bytes, nivel + 1);
          campos.push({ fieldNo, wire: 'msg', sub });
        } catch {
          campos.push({ fieldNo, wire: 'bytes', len: bytes.length });
        }
      } else {
        campos.push({ fieldNo, wire: 'bytes', len: bytes.length });
      }
    } else if (wireType === 5) {
      reader.skipType(5);
      campos.push({ fieldNo, wire: '32bit' });
    } else {
      throw new Error('wireType inválido');
    }
  }

  if (reader.pos !== reader.len) throw new Error('sobra de bytes');
  return campos;
}

// Intercepta o decode de qualquer mensagem descriptografada (sem filtro restritivo)
const origDecode = proto.Message.decode.bind(proto.Message);
proto.Message.decode = function (reader, length) {
  const isRawBytes = Buffer.isBuffer(reader) || reader instanceof Uint8Array;
  const decoded = origDecode(reader, length);

  if (isRawBytes && reader.length > 0) {
    try {
      const arvore = inspecionarProtobuf(reader);
      // Ignora apenas pacotes puramente de controle (protocolMessage=12, senderKey=2, contextInfo=35)
      const apenasControle = arvore.every((c) => [2, 12, 35].includes(c.fieldNo));
      if (!apenasControle) {
        console.log('\n================ 🕵️ PROTOBUF BRUTO ================');
        console.log(JSON.stringify(arvore, null, 2));
        console.log('===================================================\n');
      }
    } catch {
      // Ignora buffers parciais
    }
  }
  return decoded;
};

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  // Captura os atributos XML da stanza (<enc mediatype="..." />)
  sock.ws.on('CB:message', (stanza) => {
    const encs = Array.isArray(stanza.content)
      ? stanza.content.filter((c) => c.tag === 'enc').map((c) => c.attrs)
      : [];
    console.log('\n📦 [STANZA XML]', {
      id: stanza.attrs?.id,
      from: stanza.attrs?.from,
      to: stanza.attrs?.to,
      type: stanza.attrs?.type,
      encs
    });
  });

  // Mostra o que o Baileys conseguiu reconhecer no nível alto
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      console.log('📩 [UPSERT]', {
        remoteJid: m.key.remoteJid,
        fromMe: m.key.fromMe,
        chavesReconhecidas: m.message ? Object.keys(m.message) : null
      });
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) iniciar();
    }

    if (connection === 'open') {
      console.log('🟢 Sniffer ativo!');
      if (TEST_NUMBER) {
        const [check] = await sock.onWhatsApp(TEST_NUMBER);
        console.log('🔎 JID oficial do número de teste:', check);
      }
      console.log('👂 Agora envie UMA figurinha com som real (para ou a partir deste WhatsApp)...');
    }
  });
}

iniciar();
