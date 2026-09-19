#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Instalador do Monitor 01V96 para Raspberry Pi (e qualquer Linux com apt)
#
# Roda uma vez so, na maquina que fica ligada na mesa por USB. Ele:
#   1. instala o Node.js, se nao tiver
#   2. baixa o programa (sem precisar de git)
#   3. instala as dependencias
#   4. cria o servico que liga sozinho quando o Pi liga
#   5. deixa o endereco monitor.local funcionando
#
# Comando unico:
#   curl -fsSL https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/main/instalar/pi.sh | bash
#
# Rodar de novo atualiza o programa e mantem a sua calibracao.
# ---------------------------------------------------------------------------

set -euo pipefail

NOME="Monitor 01V96"
DESTINO="$HOME/monitor-01v96"
ZIP_URL="https://github.com/alexanderjr02/app-mixagem-de-som/archive/refs/heads/main.zip"
SERVICO="monitor-01v96"
NOME_REDE="monitor"
PORTA=8080

passo() { printf '\n>> %s\n' "$1"; }
ok()    { printf '   %s\n' "$1"; }

printf '\n  Instalando o %s\n' "$NOME"
printf '  Esta maquina vai conversar com a mesa pelo cabo USB.\n'

# --- 1. dependencias do sistema -------------------------------------------

passo 'Instalando o que o sistema precisa'
sudo apt-get update -qq
sudo apt-get install -y -qq curl unzip avahi-daemon libasound2 >/dev/null
ok 'pronto'

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  passo 'Instalando o Node.js 20'
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)"

# --- 2. baixar -------------------------------------------------------------

passo 'Baixando o programa'
TEMP="$(mktemp -d)"
curl -fsSL "$ZIP_URL" -o "$TEMP/app.zip"
unzip -q "$TEMP/app.zip" -d "$TEMP"
ORIGEM="$(find "$TEMP" -maxdepth 1 -type d -name 'app-mixagem-de-som-*' | head -n1)"
ok 'baixado'

# --- 3. instalar, preservando a calibracao ---------------------------------

passo 'Instalando'
mkdir -p "$DESTINO"

for arquivo in config.json estado.json; do
  if [ -f "$DESTINO/$arquivo" ]; then
    cp "$DESTINO/$arquivo" "$TEMP/guardado-$arquivo"
    ok "guardando o seu $arquivo"
  fi
done

cp -r "$ORIGEM/." "$DESTINO/"

for arquivo in config.json estado.json; do
  if [ -f "$TEMP/guardado-$arquivo" ]; then
    cp "$TEMP/guardado-$arquivo" "$DESTINO/$arquivo"
  fi
done

ok "instalado em $DESTINO"

passo 'Instalando as dependencias'
cd "$DESTINO"
npm install --omit=dev --no-audit --no-fund --loglevel=error
ok 'dependencias prontas'

# O usuario precisa estar no grupo audio para enxergar a porta MIDI USB.
sudo usermod -aG audio "$USER" || true

# --- 4. servico que liga sozinho -------------------------------------------

passo 'Criando o servico para ligar sozinho'

sudo tee "/etc/systemd/system/${SERVICO}.service" >/dev/null <<UNIDADE
[Unit]
Description=${NOME} (bridge MIDI + app do celular)
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
Group=audio
WorkingDirectory=${DESTINO}
ExecStart=$(command -v node) ${DESTINO}/src/bridge.js
Environment=NODE_ENV=production
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICO}

[Install]
WantedBy=multi-user.target
UNIDADE

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICO" >/dev/null 2>&1
sudo systemctl restart "$SERVICO"
ok 'servico ligado'

# --- 5. endereco facil (monitor.local) -------------------------------------

passo 'Deixando o endereco monitor.local funcionando'
if [ "$(hostname)" != "$NOME_REDE" ]; then
  sudo hostnamectl set-hostname "$NOME_REDE" || true
fi
sudo systemctl enable avahi-daemon >/dev/null 2>&1 || true
sudo systemctl restart avahi-daemon || true
ok 'pronto'

# --- fim -------------------------------------------------------------------

sleep 3
IPS="$(hostname -I 2>/dev/null || true)"

printf '\n'
if systemctl is-active --quiet "$SERVICO"; then
  printf '  Pronto. O %s esta rodando e volta sozinho toda vez que ligar.\n' "$NOME"
else
  printf '  Instalado, mas o servico nao subiu. Veja o motivo com:\n'
  printf '    journalctl -u %s -n 30\n' "$SERVICO"
fi

printf '\n  No celular, na mesma rede Wi-Fi, abra:\n'
printf '     http://%s.local:%s\n' "$NOME_REDE" "$PORTA"
for ip in $IPS; do printf '     http://%s:%s\n' "$ip" "$PORTA"; done

printf '\n  Dicas para nunca mais mexer nisso:\n'
printf '   - no navegador do celular, use Adicionar a tela de inicio\n'
printf '   - a calibracao de cada canal se faz pelo proprio celular, no botao de ajustes\n'
printf '   - para ver o que esta acontecendo: journalctl -u %s -f\n' "$SERVICO"
printf '\n'
