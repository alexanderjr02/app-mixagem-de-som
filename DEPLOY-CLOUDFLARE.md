# Colocar no ar pelo Cloudflare

## Leia isto primeiro

O Cloudflare **não roda o bridge**. Cloudflare Pages e Workers rodam código em
servidor deles, e lá não existe porta USB, não existe MIDI e não existe a sua
01V96. O bridge tem que continuar rodando no Raspberry Pi, ao lado da mesa.

O que o Cloudflare resolve bem são duas coisas diferentes:

| Caminho | O que você ganha | O que não ganha |
|---|---|---|
| **Cloudflare Tunnel** (recomendado) | Abrir o seu monitor de verdade por um endereço HTTPS, de qualquer lugar, com login | Precisa do Pi ligado e na internet |
| **Cloudflare Pages** | Um link público que mostra a interface funcionando (modo demonstração) | Não controla mesa nenhuma sozinho |

Uma armadilha para evitar: se você hospedar **só** a interface no Pages e tentar
apontar para o Pi da rede local, o navegador bloqueia. Página em `https://`
não pode abrir WebSocket em `ws://` sem criptografia. Por isso, se a ideia é
usar de verdade fora da rede local, o caminho é o Tunnel, não o Pages.

---

## Caminho 1: Cloudflare Tunnel (o monitor de verdade, no ar)

O `cloudflared` roda no Pi, abre uma conexão de saída para o Cloudflare e
publica o bridge num endereço HTTPS. Não precisa abrir porta no roteador nem
ter IP fixo. WebSocket passa normalmente.

### Teste rápido, sem domínio e sem conta

```bash
sudo apt install -y cloudflared     # ou baixe em https://pkg.cloudflare.com
cloudflared tunnel --url http://localhost:8080
```

Ele imprime um endereço `https://alguma-coisa.trycloudflare.com`. Abra no
celular, na rede que você quiser. Serve para testar em minutos.

Atenção: esse endereço é público e **sem senha**. Quem tiver o link mexe no seu
fone. Use só para teste e feche depois (Ctrl+C).

### Instalação de verdade (domínio próprio e login)

Precisa de um domínio com o DNS no Cloudflare (o plano free serve).

```bash
# 1. autenticar (abre um link para você aprovar no navegador)
cloudflared tunnel login

# 2. criar o túnel
cloudflared tunnel create monitor-01v96

# 3. apontar o nome para o túnel
cloudflared tunnel route dns monitor-01v96 monitor.seudominio.com
```

Crie `/home/pi/.cloudflared/config.yml`:

```yaml
tunnel: monitor-01v96
credentials-file: /home/pi/.cloudflared/SEU-UUID-AQUI.json

ingress:
  - hostname: monitor.seudominio.com
    service: http://localhost:8080
  - service: http_status:404
```

Ligar sozinho junto com o Pi:

```bash
sudo cp systemd/cloudflared-monitor.service /etc/systemd/system/
sudo nano /etc/systemd/system/cloudflared-monitor.service   # troque NOME-DO-TUNEL
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-monitor
```

Pronto: **https://monitor.seudominio.com** abre o seu monitor de qualquer lugar.

### Coloque um login na frente (não pule esta parte)

O app não tem senha nenhuma. Na rede da igreja isso passa. Na internet aberta,
não: qualquer pessoa com o link muda o volume do seu fone no meio do culto.

No painel Cloudflare Zero Trust: **Access > Applications > Add an application >
Self-hosted**

- Domínio: `monitor.seudominio.com`
- Policy: `Allow`, regra **Emails** com o seu e-mail
- Método de login: One-time PIN (chega um código no e-mail)

Se você quiser abrir sem digitar código toda vez, use a duração de sessão longa
(24 horas ou uma semana) na política.

---

## Caminho 2: Cloudflare Pages (vitrine da interface)

Útil para mostrar o app para alguém, ou para abrir a interface no celular sem
estar perto do Pi. Sem bridge respondendo, o app entra sozinho em
**modo demonstração**: os faders funcionam na tela, o rodapé avisa que nada sai
para a mesa, e o indicador mostra "demonstracao".

### Pelo painel do Cloudflare

Pages > Create > Connect to Git > escolha o repositório `app-mixagem-de-som`:

| Campo | Valor |
|---|---|
| Framework preset | None |
| Build command | *(deixe vazio)* |
| Build output directory | `public` |

Todo push no `main` publica de novo sozinho.

### Pela linha de comando

```bash
npx wrangler pages deploy public --project-name monitor-01v96
```

### Ligar essa página no seu Pi

Se você já montou o Tunnel do Caminho 1, a página do Pages consegue usar o
bridge de verdade: toque no indicador de conexão no canto superior direito e
preencha o endereço:

```
wss://monitor.seudominio.com
```

O endereço fica guardado no celular. Para voltar ao normal, é só apagar o campo.

Repare que só funciona com `wss://` (HTTPS). Endereço `ws://` de rede local é
bloqueado pelo navegador quando a página veio de um site HTTPS, e não tem jeito
de contornar isso pelo código.

---

## Qual usar no dia a dia

Na igreja, tocando: abra **http://monitor.local:8080** na rede local. É o
caminho mais curto, não depende de internet e tem a menor latência.

O Tunnel é o plano B (rede caiu, ou você está ajustando de casa antes do
ensaio) e a forma de deixar um link fixo para mostrar para alguém.
