# Colocar no ar pelo Cloudflare

## Leia isto primeiro

O Cloudflare **não roda o bridge**. Cloudflare Pages e Workers rodam código em
servidor deles, e lá não existe porta USB, não existe MIDI e não existe a sua
01V96. O bridge tem que continuar rodando no Raspberry Pi, ao lado da mesa.

O que o Cloudflare resolve bem são duas coisas diferentes:

| Caminho | O que você ganha | O que não ganha |
|---|---|---|
| **Cloudflare Tunnel** (é o que resolve) | Abrir o seu monitor de verdade por um endereço HTTPS, de qualquer lugar, com login | Precisa da máquina do bridge ligada e na internet |
| **Cloudflare Pages** | Uma cópia da interface num link fixo, que você aponta para o seu túnel | Sozinho não controla mesa nenhuma |

Uma armadilha para evitar: se você hospedar **só** a interface no Pages e tentar
apontar para a máquina da rede local, o navegador bloqueia. Página em `https://`
não pode abrir WebSocket em `ws://` sem criptografia. Por isso, se a ideia é
usar de verdade fora da rede local, o caminho é o Tunnel, não o Pages.

Na rede da igreja, tocando, nada disso é necessário: você abre o endereço local
e pronto. O Tunnel serve para ajustar de casa antes do ensaio, ou se a rede do
lugar não deixar os aparelhos se enxergarem.

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

## Caminho 2: Cloudflare Pages (a interface num link fixo)

Só faz sentido junto com o túnel do Caminho 1: é a mesma interface, num
endereço que não depende da sua rede, apontando para o seu bridge. Sem bridge
respondendo, ela mostra "Sem conexão com o bridge" e não deixa mexer em nada,
de propósito: fader que mexe sem mudar o som é pior do que fader nenhum.

### Pelo painel do Cloudflare

Pages > Create > Connect to Git > escolha o repositório `app-mixagem-de-som`:

| Campo | Valor |
|---|---|
| Framework preset | None |
| Build command | *(deixe vazio)* |
| Build output directory | `public` |

Todo push no `main` publica de novo sozinho.

### Pela linha de comando

O projeto já vem com o `wrangler.jsonc` apontando para a pasta `public`:

```bash
npx wrangler pages deploy
```

Já está no ar em **https://monitor-01v96.pages.dev**.

### Ligar essa página no seu bridge

Com o Tunnel do Caminho 1 montado, a página do Pages usa o bridge de verdade:
toque no indicador de conexão no canto superior direito e preencha o endereço:

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
