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
irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/igreja/instalar/windows.ps1 | iex
```

No CMD (como administrador), o mesmo comando assim:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/igreja/instalar/windows.ps1 | iex"
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
- O mesmo vale com a máquina ligada direto: se a mesa for desligada depois do
  culto, ou o cabo USB sair e voltar, ele percebe em até dez segundos, avisa o
  celular e reconecta sozinho quando a mesa volta. Com **"Quando a mesa ligar,
  devolver o meu mix"** ligado no app, ele ainda devolve o seu mix para a mesa.
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

## Criar os outros canais de uma vez

Calibrar 32 canais um por um cansa. Dá para calibrar **um** e deixar o app
criar o resto:

1. Calibre um canal normalmente (por exemplo o canal 1, tipo canal).
2. Abra os ajustes, escolha esse canal como modelo e marque os canais que
   quer criar.
3. O app pergunta para a mesa, canal por canal, qual é o valor atual daquele
   send. Só vira fader o canal que a mesa **responder**. Os que ficarem calados
   aparecem como "sem resposta" e não são criados.

Essa pergunta é um pedido de leitura: **não muda nada no som**. Cada fader
novo já nasce na posição em que está na mesa, e os canais que você já tinha
calibrado ficam como estão.

Eles aparecem como "Canal 2", "Canal 3"... Na primeira vez, mexa no
"Canal 5" pelo app e confira na mesa se foi o send do canal 5 que andou.

**Se nenhum canal responder**: no menu MIDI/HOST da mesa, ligue o
**Parameter Change RX** e deixe o **Rx CH** igual ao Device ID. A mesa
também precisa estar ligada no cabo USB na hora.

**Se o app disser que o controle não está no formato do manual**: aquele
canal não serve de modelo. Calibre os canais um a um, como antes.

### Trocar o nome de um controle

Nos ajustes, renomeie "Canal 5" para "Teclado" (até 40 letras). Só o nome
muda: a calibração e o volume no seu fone continuam iguais.

---

## Usando no dia a dia

- **Arrastar o fader**: ele anda o quanto seu dedo andou, não pula para onde
  você encostou. Esbarrar sem querer não estoura o volume no ouvido.
- **MUDO**: tira aquele instrumento do seu fone na hora. Mexer no fader de novo
  já tira o mudo.
- **Volume geral**: a coluna da direita, sempre visível.
- Dois celulares abertos ficam sincronizados. Se alguém mexer no send direto na
  mesa, o app acompanha.
- O último mix fica salvo. Para que ele seja reaplicado na mesa quando ela ou
  a máquina ligar, abra os ajustes e ligue **"Quando a mesa ligar, devolver o
  meu mix"**. Não precisa mexer em arquivo no PC da mesa.

### Deixar pronto para o próximo culto

1. No celular, abra o endereço e use **"Adicionar à tela de início"**. Vira um
   ícone, abre em tela cheia, e a tela não apaga enquanto o app está aberto.
2. **Reserve o IP** da máquina no roteador (DHCP reservation). Sem isso o
   endereço pode mudar de semana para semana e o atalho quebra. No Pi, o
   `monitor.local` já resolve isso sozinho.

Aí é só chegar, entrar no Wi-Fi e abrir o ícone.

---

## Atualização automática

No PC com Windows da mesa, o programa se atualiza sozinho. Você não precisa
abrir terminal nem rodar o instalador de novo.

- **O que faz:** a cada 30 minutos uma tarefa do Windows confere se o programa
  está no ar (e liga de novo se tiver caído). No máximo de 6 em 6 horas ela
  pergunta ao GitHub se existe versão nova no ramo `igreja` (o que o dono
  aprovou; o `main` não chega lá). Se existir, e só com a mesa desligada,
  baixa, instala e **roda os testes** antes de trocar qualquer coisa. Se algum teste falhar,
  essa versão é descartada e a atual continua.
- **Sem internet:** falta de internet (ou o GitHub fora do ar) nunca faz o
  programa recusar uma versão. Ele só espera um pouco (30 min, depois 1 h, 2 h,
  até 6 h) e tenta de novo. Só é recusada a versão que realmente está ruim:
  testes que falham, pacote estranho, ou uma que não sobe ou cai de novo logo
  depois de instalada.
- **Quando troca:** só com a **mesa desligada e nenhum celular conectado**.
  Se alguém estiver usando, ela espera e troca depois, nunca no meio do culto.
  Cada versão fica na própria pasta (`versoes\<código>`) e a anterior é
  guardada inteira; se a nova não subir, volta sozinha para ela. Sua calibração
  (`config.json`) e o mix salvo (`estado.json`) nunca são mexidos.
- **Ver a versão:** no app, ajustes, **Copiar diagnóstico**. A linha
  "versão" mostra a versão instalada e o resultado da última checagem.
- **Onde fica o log:** `atualizacao.log`, na pasta de dados
  (`%LOCALAPPDATA%\Monitor01V96`). Guarda as últimas 300 linhas.
- **Desligar:** abra o **Agendador de Tarefas** do Windows e apague a tarefa
  **Monitor 01V96**. O programa continua funcionando, só deixa de se atualizar
  (e de ser religado sozinho se cair; ele continua abrindo quando o Windows
  liga). Rodar o instalador de novo recria a tarefa.

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
| `npm test` | roda os testes automáticos. Não manda nada para a mesa nem mexe na sua calibração: usa MIDI simulado e uma pasta temporária |

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
    "janelaEcoMs": 400,
    "esperaRespostaMs": 300
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
| `midi.intervaloProcuraMs` | De quanto em quanto tempo ele confere se a mesa sumiu ou apareceu no cabo (padrão 10000, dez segundos) |
| `midi.esperaRespostaMs` | Ao criar canais de uma vez, quanto tempo ele espera a mesa responder cada canal antes de dar como "sem resposta" (padrão 300) |
| `aplicarEstadoAoIniciar` | Se `true`, reaplica o último mix na mesa ao ligar. É o que o botão "devolver o meu mix" do app liga e desliga |

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

Um canal criado a partir de outro é igual, com o byte do canal trocado e mais
`"geradoDe": "bumbo"`, para saber de qual modelo ele veio.

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
{ "type": "controle:renomear", "control": "canal-5", "label": "Teclado" }
{ "type": "gerar:canais", "base": "bumbo", "canais": [2, 3, 4, 5] }
{ "type": "config:devolverMix", "ligado": true }
```

Bridge para o celular:

```json
{ "type": "controls", "controls": [ { "id": "bumbo", "label": "Bumbo", "type": "canal", "calibrated": true, "canal": 1 } ] }
{ "type": "status",   "devolverMix": false, "midi": { "simulado": false, "saida": "01V96" } }
{ "type": "state",    "values": { "bumbo": 0.72 }, "mutes": { "bumbo": false } }
{ "type": "learn:midi", "count": 42, "hex": "F0 43 ..." }
{ "type": "learn:salvo", "control": { }, "faixa": { }, "bytes": { }, "avisos": [ ] }
{ "type": "learn:erro", "message": "Estou criando canais agora. ...", "etapa": "nome" }
{ "type": "gerar:progresso", "canal": 2, "feitos": 1, "total": 4, "confirmado": true }
{ "type": "gerar:fim", "criados": [ { "id": "canal-2", "label": "Canal 2", "canal": 2 } ], "semResposta": [4], "jaExistiam": [], "interrompido": false }
{ "type": "gerar:erro", "message": "Ligue a mesa no cabo USB: ..." }
{ "type": "controle:erro", "message": "Escreva um nome para o controle." }
```

Ao conectar, o celular recebe os três primeiros. Depois disso, toda mudança
vira um `state` enviado para os outros celulares, mantendo todo mundo igual.

O campo `canal` só vem nos controles que servem de modelo para criar os
outros. `gerar:progresso`, `gerar:fim` e os erros vão só para o celular que
pediu; logo depois do `gerar:fim`, todos recebem `controls` e `state`
atualizados. `controle:erro` é a resposta quando renomear ou remover um
controle não dá certo. `learn:erro` com `"etapa": "nome"` volta o assistente
de calibração para o passo do nome (acontece quando alguém tenta calibrar
enquanto os canais estão sendo criados).

## Quando algo não funciona

| Sintoma | Onde olhar |
|---|---|
| O app não abre no celular | Celular em outra rede Wi-Fi, ou a máquina do bridge desligou. No Windows, veja se o firewall pediu autorização para o Node.js |
| "Sem conexão com o bridge" | O programa não está rodando. No Pi: `systemctl status monitor-01v96`. No Windows: rode `node src\bridge.js` na pasta para ver o erro |
| Durante a calibração, o contador fica em zero | Parameter Change **TX** desligado na mesa, ou porta MIDI errada (`USB` x `MIDI`) |
| Calibrei mas o fader não muda o som | Parameter Change **RX** desligado na mesa |
| Ao criar canais de uma vez, nenhum respondeu | Parameter Change **RX** desligado, ou **Rx CH** diferente do Device ID, no menu MIDI/HOST da mesa |
| Ao criar canais, o app pede para ligar a mesa no cabo | A mesa precisa estar ligada e conectada na hora: é ela que confirma cada canal |
| O app pede para esperar antes de calibrar ou de criar canais | Calibrar e criar canais não rodam ao mesmo tempo. Espere o outro terminar (ou cancele a calibração aberta) e tente de novo |
| Ao criar canais, diz que o controle "não está no formato do manual" | Aquele canal não serve de modelo. Calibre os canais um a um |
| O fader "Canal 5" mexe em outro canal da mesa | Apague os canais criados, calibre um a um e mande o diagnóstico do app para quem cuida do programa |
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
