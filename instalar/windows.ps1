# ---------------------------------------------------------------------------
# Instalador do Monitor 01V96 para Windows
#
# Para rodar no PC que fica ligado na mesa por USB, uma vez so. Ele:
#   1. instala o Node.js, se nao tiver
#   2. baixa o programa (sem precisar de git)
#   3. instala as dependencias
#   4. deixa o programa abrindo sozinho toda vez que o Windows liga
#   5. libera a porta no firewall
#   6. mostra o endereco para voce abrir no celular
#
# Comando unico, no PowerShell:
#   irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/main/instalar/windows.ps1 | iex
#
# Rodar de novo atualiza o programa e mantem a sua calibracao.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$NOME     = 'Monitor 01V96'
$DESTINO  = Join-Path $env:LOCALAPPDATA 'Monitor01V96'
$ZIP_URL  = 'https://github.com/alexanderjr02/app-mixagem-de-som/archive/refs/heads/main.zip'
$PORTA    = 8080

function Passo($texto) { Write-Host "`n>> $texto" -ForegroundColor White }
function Ok($texto)    { Write-Host "   $texto" -ForegroundColor DarkGray }
function Aviso($texto) { Write-Host "   $texto" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  Instalando o $NOME" -ForegroundColor White
Write-Host "  Este computador vai conversar com a mesa pelo cabo USB." -ForegroundColor DarkGray

# --- 1. Node.js ------------------------------------------------------------

Passo 'Procurando o Node.js'

function Achar-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($caminho in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $caminho) { return $caminho }
  }
  return $null
}

$node = Achar-Node

if (-not $node) {
  Ok 'nao encontrei, vou instalar pelo winget (pode demorar alguns minutos)'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host ""
    Write-Host "  Nao achei o Node.js nem o winget neste computador." -ForegroundColor Red
    Write-Host "  Instale o Node.js LTS em https://nodejs.org e rode este script de novo."
    return
  }
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Achar-Node
  if (-not $node) {
    Write-Host ""
    Write-Host "  O Node.js foi instalado, mas so vai aparecer depois de reiniciar." -ForegroundColor Yellow
    Write-Host "  Feche este PowerShell, abra de novo e rode o comando outra vez."
    return
  }
}

$npm = Join-Path (Split-Path $node) 'npm.cmd'
Ok "node: $node"

# --- 2. Baixar o programa --------------------------------------------------

Passo 'Baixando o programa'

$zipTemp  = Join-Path $env:TEMP 'monitor-01v96.zip'
$dirTemp  = Join-Path $env:TEMP 'monitor-01v96-extraido'

Invoke-WebRequest -Uri $ZIP_URL -OutFile $zipTemp -UseBasicParsing
if (Test-Path $dirTemp) { Remove-Item $dirTemp -Recurse -Force }
Expand-Archive -Path $zipTemp -DestinationPath $dirTemp -Force

$origem = Get-ChildItem $dirTemp -Directory | Select-Object -First 1
Ok "baixado em $($origem.FullName)"

# --- 3. Copiar, preservando a calibracao -----------------------------------

Passo 'Instalando'

$guardados = @{}
foreach ($arquivo in 'config.json', 'estado.json') {
  $atual = Join-Path $DESTINO $arquivo
  if (Test-Path $atual) {
    $guardados[$arquivo] = Get-Content $atual -Raw -Encoding UTF8
    Ok "guardando o seu $arquivo"
  }
}

if (-not (Test-Path $DESTINO)) { New-Item -ItemType Directory -Path $DESTINO -Force | Out-Null }

Copy-Item (Join-Path $origem.FullName '*') $DESTINO -Recurse -Force

foreach ($arquivo in $guardados.Keys) {
  Set-Content -Path (Join-Path $DESTINO $arquivo) -Value $guardados[$arquivo] -Encoding UTF8
}

Ok "instalado em $DESTINO"

Passo 'Instalando as dependencias (pode demorar um pouco)'
Push-Location $DESTINO
try {
  & $npm install --omit=dev --no-audit --no-fund --loglevel=error
} finally {
  Pop-Location
}
Ok 'dependencias prontas'

# --- 4. Abrir sozinho quando o Windows ligar -------------------------------

Passo 'Configurando para abrir sozinho'

# Um VBS bem curto so para iniciar sem deixar janela preta aberta na tela.
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'Monitor01V96.vbs'
$conteudoVbs = @"
' Inicia o $NOME sem janela. Apague este arquivo para parar de abrir sozinho.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$DESTINO"
sh.Run """$node"" src\bridge.js", 0, False
"@
Set-Content -Path $vbs -Value $conteudoVbs -Encoding ASCII
Ok "atalho criado em $vbs"

# --- 5. Firewall -----------------------------------------------------------

Passo 'Liberando a porta no firewall'
try {
  Get-NetFirewallRule -DisplayName $NOME -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $NOME -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $PORTA -Profile Private, Domain | Out-Null
  Ok "porta $PORTA liberada na rede privada"
} catch {
  Aviso 'nao consegui mexer no firewall (rode como administrador para isso).'
  Aviso 'Se o celular nao abrir, autorize o Node.js quando o Windows perguntar.'
}

# --- 6. Ligar agora --------------------------------------------------------

Passo 'Ligando'

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 4

$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

$ligou = $false
try {
  $resposta = Invoke-WebRequest "http://localhost:$PORTA/api/status" -UseBasicParsing -TimeoutSec 5
  $ligou = $resposta.StatusCode -eq 200
} catch { }

Write-Host ""
if ($ligou) {
  Write-Host "  Pronto. O $NOME esta rodando." -ForegroundColor Green
} else {
  Write-Host "  Instalado, mas nao consegui confirmar que subiu." -ForegroundColor Yellow
  Write-Host "  Abra $DESTINO e rode: node src\bridge.js  para ver a mensagem de erro."
}

Write-Host ""
Write-Host "  No celular, na mesma rede Wi-Fi, abra:" -ForegroundColor White
foreach ($ip in $ips) { Write-Host "     http://$ip`:$PORTA" -ForegroundColor White }
Write-Host ""
Write-Host "  Dicas para nunca mais mexer nisso:" -ForegroundColor DarkGray
Write-Host "   - no navegador do celular, use 'Adicionar a tela de inicio'" -ForegroundColor DarkGray
Write-Host "   - reserve o IP deste computador no roteador, para ele nao mudar" -ForegroundColor DarkGray
Write-Host "   - a calibracao de cada canal se faz pelo proprio celular, no botao de ajustes" -ForegroundColor DarkGray
Write-Host ""
