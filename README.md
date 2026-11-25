# Audio Sticker Bot (WhatsApp)

Bot contínuo de WhatsApp em Node.js (ESM) usando `@whiskeysockets/baileys` que recebe figurinhas (estáticas ou animadas), imagens ou vídeos em chats autorizados e responde com uma **figurinha com som (Audio Sticker)**.

## Como funciona o Audio Sticker

O bot faz o upload separado do `.webp` e do `.ogg` (Opus) via `prepareWAMessageMedia` e aplica um hook em `proto.Message.encode` (`protobufjs/minimal`) para empacotar a estrutura Protobuf esperada pelo WhatsApp mantendo `<enc mediatype="sticker">` na stanza:

```text
proto.Message
 └─ tag 134 (FutureProofMessage / audioStickerMessage)
     └─ tag 1 (proto.Message interno)
         └─ tag 26 (StickerMessage + tag 26: AudioMessage)
```

> **Nota:** o WhatsApp Web não reproduz áudio de figurinhas — teste a reprodução do som no aplicativo mobile (Android/iOS).

## Pré-requisitos

- **Node.js** (testado em v22)
- **ffmpeg** e **ffprobe** instalados no `PATH`

## Instalação

```bash
npm install
```

Coloque o áudio padrão em `./media/som.mp3` (já incluído no repositório como exemplo). Ele é convertido automaticamente em cache para `./media/_cache_audio.ogg` (Opus, mono, 48 kHz, 64 kbps, máximo de 5s) e só é reconvertido se o arquivo `som.mp3` for modificado.

## Execução

```bash
node index.js
```

Na primeira execução, escaneie o QR Code exibido no terminal para autenticar a sessão em `./auth`.

### Rodando em background com PM2

```bash
pm2 start index.js --name audio-sticker --cwd /caminho/para/audio-sticker-test
pm2 logs audio-sticker
```

- Não use `--watch` (os arquivos em `./auth`, `./media` e `chats_ativos.json` mudam em runtime).
- Mantenha apenas **1 instância** (modo fork padrão) para evitar conflito de sessão (`440 connectionReplaced`).

## Uso no WhatsApp

### Comandos

- `!ativar` — habilita o bot no chat atual (salvo em `chats_ativos.json`).
- `!desativar` — desabilita o bot no chat atual.
- `!audio` (ou `!som`) respondendo a um áudio, arquivo de áudio, vídeo com som ou Audio Sticker — define temporariamente esse áudio como padrão apenas para este chat.
- `!audio padrao` (ou `!audio reset`) — faz o chat voltar a usar `./media/som.mp3`.

### Mídias suportadas (em chats ativados)

- **Figurinhas (estáticas, animadas ou Audio Stickers):** reaproveita o `.webp` original e acopla o áudio configurado (figurinhas Lottie são ignoradas).
- **Imagens:** converte para WebP 512×512 (`-lossless 1`).
- **Vídeos:** converte para WebP animado 512×512 (até 5s, 15 fps; recomprime automaticamente para 10 fps / 4s se ultrapassar 490 KB).
- **Entrega:** em conversas com terceiros/grupos, responde (reply) à mensagem original (com fallback para nova mensagem caso o reply falhe); na conversa consigo mesmo, apaga apenas para você (`deleteForMe`) a mídia enviada após gerar o sticker, mantendo o chat limpo sem aviso de mensagem apagada.

### Usando outro áudio (sem alterar `./media/som.mp3`)

- **Responder a um áudio com mídia:** responda um áudio (nota de voz, MP3/arquivo de áudio, vídeo com som ou outro Audio Sticker) enviando a figurinha, imagem ou vídeo.
- **Responder a uma mídia com áudio:** responda uma figurinha, imagem ou vídeo enviando uma nota de voz ou arquivo de áudio.
- **Áudio temporário por chat:** responda um áudio com `!audio` para aplicá-lo em todas as próximas figurinhas do chat (e `!audio padrao` para voltar).
- **Preservar áudio do próprio vídeo:** adicione `original` (ou `preservar`, `manter audio`, `manter som`) na legenda do vídeo.

### Opções de corte via legenda (`caption`)

- **Modo de corte** (imagens e vídeos, combinável com `original` em vídeos):
  - `inteiro` (padrão) — redimensiona mantendo tudo com fundo transparente.
  - `centro` ou `corte` — recorta centralizado em 512×512.
  - `esquerda` — recorta alinhado à esquerda em 512×512.
  - `direita` — recorta alinhado à direita em 512×512.
  - `cima` ou `topo` — recorta alinhado ao topo em 512×512.
  - `baixo` ou `embaixo` — recorta alinhado à base em 512×512.

## Utilitário de engenharia reversa

- `sniffer.js` — script auxiliar que intercepta stanzas XML e decodifica buffers Protobuf brutos para inspecionar a estrutura de mensagens recebidas/enviadas.
