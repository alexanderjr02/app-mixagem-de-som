# Monitor 01V96

Mixagem do **seu** monitor in-ear, pelo celular, sem encostar na mesa e sem
mexer no som da igreja.

Você toca bateria, quer mais bumbo no fone, quer menos guitarra, quer um pouco
de reverb. Hoje isso significa pedir para alguém no PA. Com isso aqui, você
abre o app no celular e arrasta os faders.

## O que ele mexe e o que ele não mexe

A 01V96 tem 8 barramentos Aux. Um deles (por exemplo o **Aux 1**) vira o seu
fone. O app controla só três coisas:

| Controla | Não controla |
|---|---|
| O **send** de cada canal de entrada para o seu Aux | O fader do canal no PA |
| O **send** do retorno de reverb para o seu Aux | EQ, dinâmica, ganho (são globais) |
| O **master** do Aux (volume geral do fone) | Stereo master, cenas, qualquer coisa do FOH |

O técnico continua dono da mixagem da igreja. Você é dono só do que entra no
seu ouvido.

## Como funciona

```
  celular (app no navegador)
        |  Wi-Fi da rede local
        |  WebSocket
  PC ou Raspberry Pi ligado na mesa  ->  programa "bridge"
        |  cabo USB (MIDI)
     Yamaha 01V96  ->  Aux 1  ->  seu in-ear
```

A máquina do bridge fica parada no rack, ligada na mesa pelo USB. No celular
não entra cabo nenhum.

Pode ser um Raspberry Pi ou um PC com Windows, tanto faz. O que importa é que
seja **a máquina ligada na mesa** e que ela fique ligada.

---

## Instalação: um comando só

### No PC com Windows que fica na mesa

Abra o PowerShell e cole:

```powershell
irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/main/instalar/windows.ps1 | iex
```

Ele instala o Node.js se faltar, baixa o programa, configura para abrir sozinho
toda vez que o Windows ligar, libera a porta no firewall e mostra o endereço
para você abrir no celular.

### No Raspberry Pi

```bash
curl -fsSL https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/main/instalar/pi.sh | bash
```

Mesma coisa, mais o endereço `http://monitor.local:8080`, que é mais fácil de
digitar do que um IP.

Rodar o comando de novo, depois, atualiza o programa e **mantém a sua
calibração**.

Não precisa de compilador nem de build tools: o pacote MIDI já vem com o
binário pronto para Windows, macOS, Linux e Raspberry Pi.

---

## Preparar a 01V96 (uma vez)

No painel da mesa: **DISPLAY ACCESS > MIDI/HOST** (menu MIDI / Setup).

1. **MIDI Port / Host**: `USB` se você usa o cabo USB direto na máquina.
   Se usar uma interface MIDI DIN, escolha `MIDI`.
2. **Device ID (ou Ch)**: anote o número e deixe fixo.
3. **Parameter Change**: ligue **TX** e **RX**.
   - TX é o que faz a calibração funcionar e mantém o app sincronizado quando
     alguém mexe direto na mesa.
   - RX é o que faz o celular realmente mudar o som.
4. Se existir **Parameter Change ECHO**, deixe **desligado**, para não criar
   laço de mensagens.

---

## A porta da mesa: ele acha sozinho

Você não precisa configurar qual é a porta MIDI. Ao ligar, o programa procura a
01V96 entre as portas do sistema, descartando as que nunca são mesa (o
"Midi Through" do Linux, o sintetizador do Windows).

Duas coisas que evitam dor de cabeça no dia:

- Se a mesa só for ligada **depois** da máquina, ele fica procurando de dez em
  dez segundos e avisa o celular quando achar. Não precisa reiniciar nada.
- Se houver mais de um aparelho MIDI e ele ficar em dúvida, ele **não chuta**:
  abre o app, toque no botão de ajustes e escolha a porta na lista, ali mesmo
  no celular.

## Calibrar: pelo próprio celular

Da primeira vez, o app mostra "Nenhum controle ainda". Toque em
**Calibrar o primeiro controle**, ou no botão de ajustes no canto de cima.

Para cada instrumento:

1. Dê o nome (Bumbo, Caixa, Voz 1) e escolha o tipo (canal, reverb ou volume
   geral)
2. Na mesa, leve aquele send até o **mínimo** e toque em "Capturei o mínimo"
3. Leve até o **máximo** e toque em "Capturei o máximo"

Pronto, aquele fader já funciona. O app mostra ao vivo quantas mensagens a mesa
está mandando enquanto você mexe: se ficar parado em zero, o problema é o
Parameter Change TX desligado na mesa.

**Como mexer no send do Aux na 01V96**: segure a tecla `AUX 1` (ou entre em
`AUX SELECT > AUX 1`) e mova o fader do canal. Nesse modo os faders viram os
sends daquele Aux, e o fader do PA não é afetado.

Faça isso para cada instrumento, para o retorno de reverb e, por último, para o
**master do Aux**, que é o volume geral do fone (tipo "volume geral").

### Por que precisa calibrar

Os endereços SysEx de parâmetro da 01V96 mudam conforme a versão de firmware.
Chutar esses bytes é arriscado: um endereço errado mexe no parâmetro errado da
mesa, no meio do culto.

Então o programa **aprende olhando a mesa**. Ele compara a mensagem do mínimo
com a do máximo, descobre sozinho em qual byte mora o valor e guarda o molde.
Uma vez por controle, para sempre, e o resultado fica no `config.json`.

Enquanto um controle não estiver calibrado, o bridge **nunca** envia MIDI dele.

---

## Usando no dia a dia

- **Arrastar o fader**: ele anda o quanto seu dedo andou, não pula para onde
  você encostou. Esbarrar sem querer não estoura o volume no ouvido.
- **MUDO**: tira aquele instrumento do seu fone na hora. Mexer no fader de novo
  já tira o mudo.
- **Volume geral**: a coluna da direita, sempre visível.
- Dois celulares abertos ficam sincronizados. Se alguém mexer no send direto na
  mesa, o app acompanha.
- O último mix fica salvo. Para que ele seja reaplicado na mesa quando a
  máquina ligar, coloque `"aplicarEstadoAoIniciar": true` no `config.json`.

### Deixar pronto para o próximo culto

1. No celular, abra o endereço e use **"Adicionar à tela de início"**. Vira um
   ícone, abre em tela cheia, e a tela não apaga enquanto o app está aberto.
2. **Reserve o IP** da máquina no roteador (DHCP reservation). Sem isso o
   endereço pode mudar de semana para semana e o atalho quebra. No Pi, o
   `monitor.local` já resolve isso sozinho.

Aí é só chegar, entrar no Wi-Fi e abrir o ícone.

---

## Testar antes, sem a mesa

Dá para conferir tudo no seu PC, longe da igreja:

```bash
npm install
npm start            # abre http://localhost:8080
npm run simular      # em outro terminal: finge ser a 01V96
```

O simulador manda mensagens no mesmo formato da mesa, então dá para percorrer a
calibração inteira, ver os faders mexendo e conhecer a interface. Sem mesa
conectada, o bridge avisa no rodapé que nada está saindo.

## Ferramentas de terminal (quando algo não encaixa)

| Comando | Para que serve |
|---|---|
| `npm start` | liga o bridge |
| `npm run portas` | lista as portas MIDI que a máquina enxerga |
| `npm run monitor` | mostra em hexadecimal tudo que a mesa manda |
| `npm run learn` | a mesma calibração, pelo terminal |
| `npm run simular` | finge ser a mesa, para testar sem hardware |

## config.json

Criado sozinho na primeira execução. Você não precisa editar nada à mão: a
calibração pelo celular escreve aqui.

```json
{
  "servidor": { "porta": 8080, "host": "0.0.0.0" },
  "midi": {
    "entrada": null,
    "saida": null,
    "intervaloEnvioMs": 25,
    "janelaEcoMs": 400
  },
  "aplicarEstadoAoIniciar": false,
  "controles": []
}
```

| Campo | Para que serve |
|---|---|
| `midi.entrada` / `midi.saida` | Vazio (`null`) faz ele procurar a mesa sozinho, que é o normal. Aceita índice (`1`) ou parte do nome (`"01V96"`). Dá para escolher pelo app, sem editar isto |
| `midi.intervaloEnvioMs` | De quanto em quanto tempo o lote de mudanças vai para a mesa |
| `midi.janelaEcoMs` | Tempo em que o bridge ignora o que a mesa devolve logo depois de um envio, para o fader não tremer na mão |
| `aplicarEstadoAoIniciar` | Se `true`, reaplica o último mix na mesa ao ligar |

Cada controle calibrado fica assim:

```json
{
  "id": "bumbo",
  "rotulo": "Bumbo",
  "tipo": "canal",
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
0..1 esticado entre `rawMin` e `rawMax`.

Esse arquivo é a sua calibração inteira. Vale guardar uma cópia.

## Protocolo WebSocket

Celular para o bridge:

```json
{ "type": "set",  "control": "bumbo", "value": 0.72 }
{ "type": "mute", "control": "bumbo", "muted": true }
{ "type": "learn:iniciar",  "control": null, "label": "Bumbo", "kind": "canal" }
{ "type": "learn:capturar", "step": "min" }
{ "type": "learn:salvar" }
{ "type": "controle:remover", "control": "bumbo" }
```

Bridge para o celular:

```json
{ "type": "controls", "controls": [ { "id": "bumbo", "label": "Bumbo", "type": "canal", "calibrated": true } ] }
{ "type": "status",   "midi": { "simulado": false, "saida": "01V96" } }
{ "type": "state",    "values": { "bumbo": 0.72 }, "mutes": { "bumbo": false } }
{ "type": "learn:midi", "count": 42, "hex": "F0 43 ..." }
{ "type": "learn:salvo", "control": { }, "faixa": { }, "bytes": { }, "avisos": [ ] }
```

Ao conectar, o celular recebe os três primeiros. Depois disso, toda mudança
vira um `state` enviado para os outros celulares, mantendo todo mundo igual.

## Quando algo não funciona

| Sintoma | Onde olhar |
|---|---|
| O app não abre no celular | Celular em outra rede Wi-Fi, ou a máquina do bridge desligou. No Windows, veja se o firewall pediu autorização para o Node.js |
| "Sem conexão com o bridge" | O programa não está rodando. No Pi: `systemctl status monitor-01v96`. No Windows: rode `node src\bridge.js` na pasta para ver o erro |
| Durante a calibração, o contador fica em zero | Parameter Change **TX** desligado na mesa, ou porta MIDI errada (`USB` x `MIDI`) |
| Calibrei mas o fader não muda o som | Parameter Change **RX** desligado na mesa |
| Rodapé diz "sem mesa conectada" | Confira o cabo USB e se a mesa está ligada. Se houver mais de um aparelho MIDI, escolha a porta no botão de ajustes do app |
| O fader treme sozinho | Desligue o **ECHO** de Parameter Change na mesa, ou aumente `janelaEcoMs` |
| O endereço mudou de uma semana para outra | Reserve o IP da máquina no roteador |
| Mudei o app e o celular mostra o antigo | Puxe a tela para atualizar, ou feche e abra o app instalado |

## Segurança

Não tem senha. Quem estiver na sua rede Wi-Fi e souber o endereço mexe no seu
fone. Para a rede da igreja isso costuma bastar.

Se você expuser o app pela internet (veja [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)),
aí é **obrigatório** colocar o Cloudflare Access na frente.

## Arquivos

```
src/bridge.js        servidor HTTP + WebSocket + envio para a mesa + calibração
src/yamaha01v96.js   monta e lê as mensagens SysEx a partir do molde calibrado
src/midi-io.js       abre as portas MIDI (real, virtual ou simulada)
src/learn.js         npm run learn: a calibração pelo terminal
src/monitor.js       npm run monitor: mostra o SysEx que chega, em hexadecimal
src/portas.js        npm run portas: lista as portas MIDI
src/simular.js       npm run simular: finge ser a mesa, para testar sem hardware
src/config.js        leitura e gravação do config.json e do estado.json
public/              o app do celular (HTML, CSS, JS, manifest, service worker)
instalar/            os instaladores de um comando (Windows e Raspberry Pi)
systemd/             serviços para o Pi, caso queira instalar na mão
scripts/             gerador dos ícones PNG do app
```
