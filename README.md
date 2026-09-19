# Monitor 01V96

Mixagem do **seu** monitor in-ear, pelo celular, sem encostar na mesa e sem
mexer no som da igreja.

Você toca bateria, quer mais bumbo no fone, quer menos guitarra, quer um pouco
de reverb na voz do fone. Hoje isso significa pedir para alguém no PA. Com isso
aqui, você abre o navegador do celular e arrasta os faders.

## O que ele mexe e o que ele não mexe

A 01V96 tem 8 barramentos Aux. Um deles (por exemplo o **Aux 1**) vira o seu
fone. O app controla só três coisas:

| Controla | Não controla |
|---|---|
| O **send** de cada canal de entrada para o seu Aux | O fader do canal no PA |
| O **send** do retorno de reverb para o seu Aux | EQ, dinâmica, ganho (são globais) |
| O **master** do Aux (volume geral do fone) | Stereo master, cenas, qualquer coisa do FOH |

Ou seja: o técnico continua dono da mixagem da igreja. Você é dono só do que
entra no seu ouvido.

## Como funciona

```
  celular (PWA no navegador)
        |  Wi-Fi da rede local
        |  WebSocket
  Raspberry Pi  ->  bridge em Node.js
        |  USB-MIDI
     Yamaha 01V96  ->  Aux 1  ->  seu in-ear
```

O Pi e a mesa ficam parados no rack. No celular não entra cabo nenhum.

## Por que tem uma calibração

Os endereços SysEx de parâmetro da 01V96 mudam conforme a versão de firmware.
Chutar esses bytes é arriscado: um endereço errado mexe no parâmetro errado da
mesa, no meio do culto.

Então o programa **aprende olhando a mesa**. Para cada controle você leva o
send ao mínimo, aperta Enter, leva ao máximo, aperta Enter. O programa compara
as duas mensagens, descobre sozinho em qual byte mora o valor e guarda o molde.
Uma vez por controle, para sempre.

Enquanto um controle não estiver calibrado, o bridge **nunca** envia MIDI dele.
O fader mexe só na tela. É a trava de segurança para nada chegar torto na mesa.

---

### Precisa ser Raspberry Pi?

Não. Quem conversa com a mesa é a máquina ligada nela por **USB**, e o celular
chega nessa máquina pela rede. Pode ser um notebook em cima do rack.

O Pi é a melhor escolha para deixar fixo: é pequeno, barato, liga sozinho com o
sistema e não precisa de ninguém abrindo programa. Num notebook Windows o
pacote MIDI é nativo e só compila se você tiver o Visual Studio Build Tools
instalado (`npm install --global windows-build-tools` ou o instalador da
Microsoft). No Linux e no macOS é mais simples.

E vale o lembrete: celular e máquina precisam estar na **mesma rede Wi-Fi**
(a menos que você monte o túnel do `DEPLOY-CLOUDFLARE.md`).

## 1. Instalação no Raspberry Pi

Vale qualquer Pi com rede (Zero 2 W, 3, 4, 5).

```bash
# dependências do sistema (o pacote MIDI é nativo e precisa compilar)
sudo apt update
sudo apt install -y git nodejs npm build-essential libasound2-dev

# o projeto
git clone https://github.com/alexanderjr02/app-mixagem-de-som.git
cd app-mixagem-de-som
npm install
```

Se o Node do apt for antigo (menor que 18), instale um mais novo:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Coloque o usuário no grupo de áudio e reinicie a sessão:

```bash
sudo usermod -aG audio $USER
```

## 2. Preparar a 01V96

No painel da mesa: **DISPLAY ACCESS > MIDI/HOST** (menu MIDI / Setup).

1. **MIDI Port / Host**: escolha `USB` se você usa o cabo USB direto no Pi.
   Se usar uma interface MIDI DIN, escolha `MIDI`.
2. **Device ID (ou Ch)**: anote o número e deixe fixo. Não precisa decorar nada
   além disso, a calibração cuida do resto.
3. **Parameter Change**: ligue **TX** (a mesa manda) e **RX** (a mesa recebe).
   - TX é o que faz a calibração funcionar e mantém o app sincronizado quando
     alguém mexe direto na mesa.
   - RX é o que faz o celular realmente mudar o som.
4. Se existir a opção **Parameter Change ECHO**, deixe **desligada**, para não
   criar laço de mensagens.

Ligue o cabo USB da mesa no Pi (ou a interface MIDI, com OUT da mesa no IN da
interface e IN da mesa no OUT da interface).

## 3. Achar a porta MIDI

```bash
npm run portas
```

Saída típica:

```
Entradas MIDI (mesa -> computador):
  [0] Midi Through:Midi Through Port-0 14:0
  [1] 01V96:01V96 MIDI 1 20:0
```

Confira que a mesa está mesmo falando:

```bash
npm run monitor
```

Mexa em qualquer fader da mesa. Se aparecerem linhas em hexadecimal, está tudo
certo. Se não aparecer nada, volte no passo 2 (quase sempre é o Parameter
Change TX desligado ou a porta errada).

## 4. Calibrar os controles

```bash
npm run learn
```

O programa pergunta a porta MIDI e mostra um menu. Para cada controle:

```
Rotulo que aparece no celular: Bumbo
Id interno (Enter = "bumbo"):
Tipo: canal, reverb ou master (Enter = "canal"):

Agora mexa na MESA, no controle "Bumbo".
Lembre: e o SEND desse canal para o Aux do seu fone, nao o fader do PA.

  1) Leve o controle ate o MINIMO (tudo embaixo).
  (depois aperte Enter)
  capturado: F0 43 10 3E 0D 01 1C 00 00 00 00 F7  (38 mensagens)

  2) Agora leve ate o MAXIMO (tudo em cima).
  (depois aperte Enter)
  capturado: F0 43 10 3E 0D 01 1C 00 00 01 7F F7  (41 mensagens)

  Aprendido:
    molde ......... F0 43 10 3E 0D 01 1C 00 00 00 00 F7
    valor no byte . offset 9, 2 byte(s)
    faixa ......... 0 ate 255
```

**Como mexer no send do Aux na 01V96**: segure a tecla `AUX 1` (ou entre em
`AUX SELECT > AUX 1`) e mova o fader do canal. Nesse modo os faders viram os
sends daquele Aux, e o fader do PA não é afetado.

Faça isso para cada instrumento, para o retorno de reverb e, por último, para
o **master do Aux** (tipo `master`), que é o volume geral do fone. Escolha a
opção `5` para salvar.

O resultado fica no `config.json`. Quer levar para outro Pi? Copie esse arquivo.

## 5. Ligar

```bash
npm start
```

```
Monitor 01V96 no ar
  local .......... http://localhost:8080
  rede ........... http://192.168.0.42:8080
  controles ...... 14
```

Abra esse endereço no celular, na mesma rede Wi-Fi.

### Ligar sozinho quando o Pi liga (systemd)

```bash
sudo cp systemd/monitor-01v96.service /etc/systemd/system/
sudo nano /etc/systemd/system/monitor-01v96.service   # confira User e caminhos
sudo systemctl daemon-reload
sudo systemctl enable --now monitor-01v96
```

Acompanhar o que está acontecendo:

```bash
systemctl status monitor-01v96
journalctl -u monitor-01v96 -f
```

### Endereço fácil de digitar (mDNS)

Assim você não precisa decorar IP, e nada quebra se o roteador trocar o IP do Pi.

```bash
sudo apt install -y avahi-daemon
sudo hostnamectl set-hostname monitor
sudo systemctl restart avahi-daemon
```

Agora é só abrir **http://monitor.local:8080** no celular.

Android antigo às vezes não resolve `.local`. Nesse caso, reserve um IP fixo
para o Pi no roteador e use o IP.

## 6. Instalar no celular

Abra o endereço no Chrome (Android) ou Safari (iPhone) e use
"Adicionar à tela de início". O app abre em tela cheia, sem barra de navegador,
com ícone próprio. Ele também segura a tela acesa enquanto está aberto, para
não apagar no meio do louvor.

## 7. Usando

- **Arrastar o fader**: o fader anda o quanto seu dedo andou. Ele não pula para
  onde você encostou, então esbarrar sem querer não estoura o volume no ouvido.
- **MUDO**: tira aquele instrumento do seu fone na hora. Mexer no fader de novo
  já tira o mudo.
- **Volume geral**: a coluna da direita, sempre visível. É o master do Aux.
- Dois celulares abertos ficam sincronizados. Se alguém mexer no send direto na
  mesa, o app acompanha.
- O último mix fica salvo em `estado.json`. Se quiser que ele seja reaplicado
  na mesa quando o Pi ligar, coloque `"aplicarEstadoAoIniciar": true` no
  `config.json`.
- Um `*` no nome do canal quer dizer que ele ainda não foi calibrado: mexe só
  na tela.

---

## Testar sem a mesa

Dá para mexer na interface no PC antes de encostar no equipamento:

```bash
npm install
npm start
```

Sem porta MIDI configurada, o bridge entra em **modo simulado**: tudo funciona,
os movimentos aparecem no terminal em hexadecimal, e nada sai para lugar nenhum.
No Windows o pacote nativo `midi` nem precisa compilar, ele é opcional.

No Linux e no macOS dá para ir além e criar uma porta MIDI virtual, para testar
com outro programa MIDI na mesma máquina:

```json
"midi": { "entrada": "virtual", "saida": "virtual" }
```

## config.json

```json
{
  "servidor": { "porta": 8080, "host": "0.0.0.0" },
  "midi": {
    "entrada": "01V96",
    "saida": "01V96",
    "intervaloEnvioMs": 25,
    "janelaEcoMs": 400
  },
  "aplicarEstadoAoIniciar": false,
  "controles": [ ... ]
}
```

| Campo | Para que serve |
|---|---|
| `midi.entrada` / `midi.saida` | Índice (`1`) ou parte do nome (`"01V96"`). Também aceita `"virtual"` ou `"simulado"` |
| `midi.intervaloEnvioMs` | De quanto em quanto tempo o lote de mudanças vai para a mesa. 25 ms é suave e não afoga a mesa |
| `midi.janelaEcoMs` | Tempo em que o bridge ignora o que a mesa devolve logo depois de um envio, para o fader não tremer na mão |
| `aplicarEstadoAoIniciar` | Se `true`, reaplica o último mix na mesa ao ligar |

Cada controle calibrado fica assim:

```json
{
  "id": "bumbo",
  "rotulo": "Bumbo",
  "tipo": "canal",
  "valorInicial": 0.6,
  "calibrado": true,
  "template": [240, 67, 16, 62, 13, 1, 28, 0, 0, 0, 0, 247],
  "valueOffset": 9,
  "valueLength": 2,
  "rawMin": 0,
  "rawMax": 255
}
```

`template` é a mensagem inteira capturada da mesa. Em tempo real o bridge copia
essa mensagem e troca só os bytes a partir de `valueOffset`, com o seu valor
0..1 esticado entre `rawMin` e `rawMax`. `tipo` pode ser `canal`, `reverb` ou
`master` (o master vai para a coluna fixa do "Volume geral").

## Protocolo WebSocket

Celular para o bridge:

```json
{ "type": "set",  "control": "bumbo", "value": 0.72 }
{ "type": "mute", "control": "bumbo", "muted": true }
```

Bridge para o celular:

```json
{ "type": "controls", "controls": [ { "id": "bumbo", "label": "Bumbo", "type": "canal", "calibrated": true } ] }
{ "type": "status",   "midi": { "simulado": false, "saida": "01V96 MIDI 1" } }
{ "type": "state",    "values": { "bumbo": 0.72 }, "mutes": { "bumbo": false } }
```

Ao conectar, o celular recebe os três. Depois disso, toda mudança vira um
`state` enviado para os outros celulares, mantendo todo mundo igual.

Também existem `GET /api/controls` e `GET /api/status`, úteis para depurar
direto no navegador.

## Quando algo não funciona

| Sintoma | Onde olhar |
|---|---|
| `npm run monitor` não mostra nada | Parameter Change **TX** desligado na mesa, ou porta MIDI errada (`USB` x `MIDI`) |
| O app abre mas o fader não muda o som | Parameter Change **RX** desligado, ou o controle ainda está sem calibrar (aparece `*` no nome) |
| Rodapé diz "midi simulado" | O bridge não achou a porta. Rode `npm run portas` e ajuste `midi.saida` |
| "conectado" não aparece no celular | Celular em outra rede Wi-Fi, ou firewall do Pi. Teste o IP direto em vez de `monitor.local` |
| O fader treme sozinho | Desligue o **ECHO** de Parameter Change na mesa, ou aumente `janelaEcoMs` |
| `npm install` falha no `midi` | Falta `build-essential` e `libasound2-dev`. Sem ele o app roda em modo simulado |
| `npm install` avisa `allow-scripts` e o `midi` não compila | npm novo pede autorização para compilar pacote nativo. Rode `npm approve-scripts midi` e instale de novo |
| Mudei o app e o celular mostra o antigo | Puxe a tela para atualizar, ou feche e abra o app instalado (o service worker guarda uma cópia) |

## Segurança

Não tem senha. Quem estiver na sua rede Wi-Fi e souber o endereço mexe no seu
fone. Para a rede da igreja isso costuma bastar. Se quiser fechar mais, deixe o
Pi numa rede Wi-Fi separada, só para o palco.

Se você expôs o app pela internet (veja `DEPLOY-CLOUDFLARE.md`), aí é
**obrigatório** colocar o Cloudflare Access na frente, senão qualquer pessoa
com o link mexe no seu monitor.

## Arquivos

```
src/bridge.js        servidor HTTP + WebSocket + envio para a mesa
src/yamaha01v96.js   monta e lê as mensagens SysEx a partir do molde calibrado
src/midi-io.js       abre as portas MIDI (real, virtual ou simulada)
src/learn.js         npm run learn: calibração guiada
src/monitor.js       npm run monitor: mostra o SysEx que chega, em hexadecimal
src/portas.js        npm run portas: lista as portas MIDI
src/config.js        leitura e gravação do config.json e do estado.json
public/              o app do celular (HTML, CSS, JS, manifest, service worker)
scripts/             gerador dos ícones PNG do app
systemd/             arquivos de serviço para iniciar sozinho no Pi
```
