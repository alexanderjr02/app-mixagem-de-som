# ---------------------------------------------------------------------------
# Instalador do Monitor 01V96 para Windows
#
# Para rodar no PC que fica ligado na mesa por USB, uma vez so. Ele:
#   1. instala o Node.js, se nao tiver
#   2. baixa a versao aprovada do programa (ramo "igreja", sem precisar de git)
#   3. instala as dependencias e guarda o programa em versoes\<versao>\
#   4. deixa o programa abrindo sozinho toda vez que o Windows liga
#   5. cria a Tarefa Agendada "Monitor 01V96", que mantem o programa no ar e o
#      atualiza sozinho quando a mesa estiver desligada (src/atualizar.js)
#   6. libera a porta no firewall
#   7. mostra o endereco para voce abrir no celular
#
# Comando unico. No PowerShell:
#   irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/igreja/instalar/windows.ps1 | iex
#
# No CMD (de preferencia como administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/alexanderjr02/app-mixagem-de-som/igreja/instalar/windows.ps1 | iex"
#
# Rodar de novo reinstala a versao mais nova e mantem a sua calibracao e o
# historico de atualizacoes. A Tarefa Agendada e substituida, nunca duplicada.
# Instalacoes antigas (programa solto na pasta) sao migradas para o formato novo.
#
# Parametros (so para teste; sem eles vale o padrao de producao):
#   -PastaDestino <pasta>   onde instalar (padrao: %LOCALAPPDATA%\Monitor01V96)
#   -Ramo <nome>       ramo do GitHub (padrao: igreja)
#   -SemTarefa         nao mexe na Tarefa Agendada
#   -SemFirewall       nao mexe no firewall
#   -SemIniciar        nao cria o atalho da pasta Startup e nao liga o programa
#   -SemDependencias   nao roda o npm ci (so para teste offline)
#   -PastaOrigem <pasta>  usa um projeto ja extraido em vez de baixar
#   -ShaOrigem <40 hex>   versao da -PastaOrigem
# ---------------------------------------------------------------------------

param(
  [string]$PastaDestino = '',
  [string]$Ramo = 'igreja',
  [switch]$SemTarefa,
  [switch]$SemFirewall,
  [switch]$SemIniciar,
  [switch]$SemDependencias,
  [string]$PastaOrigem = '',
  [string]$ShaOrigem = ''
)

$ErrorActionPreference = 'Stop'

# Com "irm | iex" os parametros nao chegam: garante os padroes de producao.
if (-not $Ramo) { $Ramo = 'igreja' }
if ($Ramo -notmatch '^[A-Za-z0-9._/-]+$') { throw "Nome de ramo invalido: $Ramo" }

$NOME     = 'Monitor 01V96'
$DESTINO  = if ($PastaDestino) { $PastaDestino } else { Join-Path $env:LOCALAPPDATA 'Monitor01V96' }
$REPO     = 'alexanderjr02/app-mixagem-de-som'
$API_SHA  = "https://api.github.com/repos/$REPO/commits/$Ramo"
$ZIP_RAMO = "https://github.com/$REPO/archive/refs/heads/$Ramo.zip"
$TAREFA   = 'Monitor 01V96'

# Garante HTTPS moderno no PowerShell 5.1 do Windows 10.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# Arquivos de dados da pasta de instalacao: nunca sao apagados nem alterados.
$DADOS = @('config.json', 'config.json.bak', 'estado.json', 'atualizacao.json', 'atualizacao.log', 'atualizacao.lock', 'bridge.pid')

function Passo($texto) { Write-Host "`n>> $texto" -ForegroundColor White }
function Ok($texto)    { Write-Host "   $texto" -ForegroundColor DarkGray }
function Aviso($texto) { Write-Host "   $texto" -ForegroundColor Yellow }

# JSON do disco, tirando o BOM que o PowerShell 5 costuma gravar.
function Ler-Json($arquivo) {
  $texto = [IO.File]::ReadAllText($arquivo)
  if ($texto.Length -gt 0 -and $texto[0] -eq [char]0xFEFF) { $texto = $texto.Substring(1) }
  return $texto | ConvertFrom-Json
}

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

# --- 1b. Combinar com a Tarefa Agendada ------------------------------------

# Se o programa ja estava instalado, a tarefa de atualizacao pode estar no meio
# de uma troca. Desliga a tarefa e espera ela soltar a trava antes de mexer.
# Pasta de dados de quem ja usava: nao pode ser um repositorio de desenvolvimento.
if (Test-Path -LiteralPath (Join-Path $DESTINO '.git')) {
  throw "A pasta $DESTINO e um repositorio git (desenvolvimento). Nao instalo aqui."
}

# A porta (Number(), como o programa le) e usada para achar o programa antigo.
$PORTA = 8080
try {
  $cfgArq = Join-Path $DESTINO 'config.json'
  if (Test-Path $cfgArq) {
    $p = [int](Ler-Json $cfgArq).servidor.porta
    if ($p -gt 0 -and $p -lt 65536) { $PORTA = $p }
  }
} catch { }

# Linha de comando de processos node.exe em pares (id, linha).
function Listar-Node {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
    [pscustomobject]@{ Id = $_.ProcessId; Linha = ([string]$_.CommandLine) }
  }
}

$tarefaPausada = $false
if (-not $SemTarefa) {
  $tarefaAntiga = Get-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue
  if ($tarefaAntiga) {
    Passo 'Pausando a atualizacao automatica enquanto instala'
    try { Disable-ScheduledTask -TaskName $TAREFA | Out-Null; $tarefaPausada = $true } catch { Aviso "nao consegui pausar a tarefa: $($_.Exception.Message)" }
  }
}

# Tudo daqui para baixo roda dentro de try/finally: se a instalacao abortar, a
# tarefa que pausamos e habilitada de novo (senao o PC nunca mais se atualizaria).
try {

if ($tarefaPausada) {
  $trava = Join-Path $DESTINO 'atualizacao.lock'
  $limite = (Get-Date).AddSeconds(120)
  while ((Test-Path $trava) -and ((Get-Date) -lt $limite)) {
    if (((Get-Date) - (Get-Item $trava).LastWriteTime).TotalMinutes -gt 30) { break }
    Start-Sleep -Seconds 2
  }
  if (Test-Path $trava) {
    # A atualizacao nao terminou sozinha: para a execucao DESTA instalacao e solta a trava.
    Aviso 'uma atualizacao ainda estava rodando; vou parar essa execucao'
    try { Stop-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue } catch { }
    $destinoMin = $DESTINO.ToLower()
    Listar-Node | Where-Object {
      $l = $_.Linha.ToLower().Replace('"', ' ')
      $l.Contains($destinoMin) -and ($l -match 'atualizar\s*$')
    } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Remove-Item -LiteralPath $trava -Force -ErrorAction SilentlyContinue
  }
}

# --- 2. Baixar o programa --------------------------------------------------

Passo 'Baixando o programa'

$sha = $null
$origem = $null

if ($PastaOrigem) {
  $origem = Get-Item -LiteralPath $PastaOrigem
  if ($ShaOrigem) { $sha = $ShaOrigem.ToLower() }
  Ok "usando a pasta $PastaOrigem"
} else {
  $zipTemp = Join-Path $env:TEMP 'monitor-01v96.zip'
  $dirTemp = Join-Path $env:TEMP 'monitor-01v96-extraido'

  # Pergunta qual e a versao mais nova do ramo (sha do commit) e baixa exatamente essa.
  try {
    $resp = Invoke-WebRequest -Uri $API_SHA -Headers @{ Accept = 'application/vnd.github.sha'; 'User-Agent' = 'monitor-01v96-instalador' } -UseBasicParsing -TimeoutSec 20
    $texto = if ($resp.Content -is [byte[]]) { [Text.Encoding]::ASCII.GetString($resp.Content) } else { [string]$resp.Content }
    $texto = $texto.Trim()
    if ($texto -match '^[0-9a-f]{40}$') { $sha = $texto }
  } catch { }

  $zipUrl = $ZIP_RAMO
  if ($sha) {
    $zipUrl = "https://codeload.github.com/$REPO/zip/$sha"
    Ok "versao $($sha.Substring(0, 7))"
  } else {
    Aviso 'nao consegui saber a versao; vou baixar o ramo assim mesmo'
  }

  if (Test-Path $zipTemp) { Remove-Item $zipTemp -Force }
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipTemp -UseBasicParsing
  } catch {
    if ($zipUrl -eq $ZIP_RAMO) { throw }
    Aviso 'o download pela versao falhou; baixando o ramo'
    $sha = $null
    Invoke-WebRequest -Uri $ZIP_RAMO -OutFile $zipTemp -UseBasicParsing
  }

  if (Test-Path $dirTemp) { Remove-Item $dirTemp -Recurse -Force }
  Expand-Archive -Path $zipTemp -DestinationPath $dirTemp -Force
  $origem = Get-ChildItem $dirTemp -Directory | Select-Object -First 1

  # Sem saber o sha do GitHub, a versao ganha o sha1 do proprio zip: valido,
  # unico, e a atualizacao automatica troca pela versao de verdade na primeira consulta.
  if (-not $sha) { $sha = (Get-FileHash -Algorithm SHA1 -Path $zipTemp).Hash.ToLower() }
  Ok "baixado em $($origem.FullName)"
}

if (-not $sha) { $sha = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$origem.FullName + (Get-Date).Ticks))).Replace('-', '').ToLower() }
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "Versao invalida: $sha" }

if (-not (Test-Path (Join-Path $origem.FullName 'instalar\iniciar.js'))) {
  throw "Esta versao nao tem instalar\iniciar.js (o lancador). Use o ramo '$Ramo' atualizado."
}

# --- 3. Guardar a versao em versoes\<sha>, preparada ate o fim --------------

Passo 'Instalando'

if (-not (Test-Path $DESTINO)) { New-Item -ItemType Directory -Path $DESTINO -Force | Out-Null }
$pastaVersoes = Join-Path $DESTINO 'versoes'
if (-not (Test-Path $pastaVersoes)) { New-Item -ItemType Directory -Path $pastaVersoes -Force | Out-Null }

$versaoPronta = Join-Path $pastaVersoes $sha
$versaoPreparo = "$versaoPronta.preparando"

if (Test-Path (Join-Path $versaoPronta 'src\bridge.js')) {
  Ok "a versao $($sha.Substring(0, 7)) ja esta instalada (versoes prontas nunca sao alteradas)"
} else {
  foreach ($velho in $versaoPronta, $versaoPreparo) {
    if (Test-Path $velho) { Remove-Item $velho -Recurse -Force }
  }
  Copy-Item $origem.FullName $versaoPreparo -Recurse -Force

  Passo 'Instalando as dependencias (pode demorar um pouco)'
  if ($SemDependencias) {
    Aviso 'dependencias nao instaladas (-SemDependencias, so para teste)'
  } else {
    if (-not (Test-Path (Join-Path $versaoPreparo 'package-lock.json'))) {
      throw 'Esta versao nao tem package-lock.json; nao instalo dependencias sem ele.'
    }
    Push-Location $versaoPreparo
    try {
      # npm ci instala exatamente o que esta no package-lock.json; sem scripts de
      # instalacao (o pacote MIDI ja traz o binario pronto para o Windows).
      & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm terminou com erro $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }
  Move-Item -LiteralPath $versaoPreparo -Destination $versaoPronta
  Ok 'dependencias prontas'
}
Ok "instalado em $versaoPronta"

# --- 3b. Parar o programa antigo, gravar o novo e so entao migrar ----------

Passo 'Trocando para a versao nova'

# Para o bridge DESTA instalacao: linha de comando com a pasta de instalacao,
# ou o dono da porta daqui desde que seja um bridge.js/iniciar.js (o atalho
# antigo abria `node src\bridge.js` com caminho relativo, so a porta o entrega).
# O atualizador (`iniciar.js atualizar`) e outros node nunca sao tocados.
$destinoMin = $DESTINO.ToLower()
$donosPorta = @()
try { $donosPorta = @(Get-NetTCPConnection -LocalPort $PORTA -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) } catch { }
Listar-Node | Where-Object {
  $l = $_.Linha.ToLower().Replace('"', ' ')
  $doDestino = $l.Contains($destinoMin) -and ($l -notmatch 'atualizar\s*$') -and ($l -match '(iniciar|bridge)\.js')
  $daPorta = ($donosPorta -contains $_.Id) -and ($l -match '(iniciar|bridge)\.js') -and ($l -notmatch 'atualizar\s*$')
  $doDestino -or $daPorta
} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Instalacao antiga? O codigo ficava solto na pasta de dados. So conta como
# instalacao nossa se tiver src\bridge.js e um package.json chamado monitor-01v96.
$migrar = $false
$pkgAntigo = Join-Path $DESTINO 'package.json'
if ((Test-Path (Join-Path $DESTINO 'src\bridge.js')) -and (Test-Path $pkgAntigo)) {
  try { $migrar = ((Ler-Json $pkgAntigo).name -eq 'monitor-01v96') } catch { }
  if (-not $migrar) { Aviso 'a pasta tem um src\bridge.js que nao parece ser do Monitor 01V96; nao apago nada dela' }
}

# O lancador, por arquivo temporario + rename.
$lancador = Join-Path $DESTINO 'iniciar.js'
Copy-Item (Join-Path $versaoPronta 'instalar\iniciar.js') "$lancador.tmp" -Force
Move-Item -LiteralPath "$lancador.tmp" -Destination $lancador -Force

# O ponteiro. Mantem as versoes recusadas; a anterior so vale se a pasta existe.
# Reinstalar a mesma versao que ja era a atual preserva a anterior que existia.
$estadoArq = Join-Path $DESTINO 'atualizacao.json'
$recusadas = @()
$anterior = $null
if (Test-Path $estadoArq) {
  try {
    $antigo = Ler-Json $estadoArq
    if ($antigo.recusadas) { $recusadas = @($antigo.recusadas | Where-Object { $_ -match '^[0-9a-f]{40}$' }) }
    $candidata = [string]$antigo.atual
    if ($candidata -eq $sha) { $candidata = [string]$antigo.anterior }
    if ($candidata -match '^[0-9a-f]{40}$' -and $candidata -ne $sha -and (Test-Path (Join-Path $pastaVersoes "$candidata\src\bridge.js"))) {
      $anterior = $candidata
    }
  } catch { }
}
$novoEstado = [ordered]@{
  atual           = $sha
  anterior        = $anterior
  emTroca         = $null
  alvo            = $null
  preparada       = $null
  recusadas       = $recusadas
  tentativas      = @{}
  religacoes      = @()
  instaladaEm     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.000Z')
  ultimaConsulta  = $null
  falhasRede      = 0
  ultimoResultado = 'instalado pelo instalador'
}
$tmpEstado = "$estadoArq.tmp"
[IO.File]::WriteAllText($tmpEstado, ($novoEstado | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmpEstado -Destination $estadoArq -Force

# Com o lancador e o ponteiro gravados, apaga o codigo antigo da raiz: so os
# nomes de codigo conhecidos (lista fixa + o que o projeto traz na raiz), nunca
# dados, nunca .git.
if ($migrar) {
  $nomesDeCodigo = @('src', 'public', 'test', 'instalar', 'scripts', 'systemd', 'node_modules',
    'package.json', 'package-lock.json', 'README.md', 'DEPLOY-CLOUDFLARE.md', 'config.example.json',
    'wrangler.jsonc', '.gitignore', '.gitattributes', '.github')
  $nomesDeCodigo += (Get-ChildItem -LiteralPath $versaoPronta -Force | ForEach-Object { $_.Name })
  $naoApagar = $DADOS + @('versoes', 'iniciar.js', 'iniciar.js.tmp', 'iniciar.js.bak', 'Monitor01V96-atualizar.vbs', 'Monitor01V96-iniciar.vbs', '.git')
  foreach ($item in ($nomesDeCodigo | Select-Object -Unique)) {
    if ($naoApagar -contains $item) { continue }
    $velho = Join-Path $DESTINO $item
    if (Test-Path -LiteralPath $velho) {
      Remove-Item -LiteralPath $velho -Recurse -Force -ErrorAction SilentlyContinue
      Ok "formato antigo: removi $item"
    }
  }
}

# Versoes velhas que nao servem mais (a atual e a anterior ficam).
Get-ChildItem -LiteralPath $pastaVersoes -Directory | Where-Object {
  $_.Name -match '^[0-9a-f]{40}(\.preparando|\.extraindo)?$' -and $_.Name -ne $sha -and $_.Name -ne $anterior
} | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

Ok "versao $($sha.Substring(0, 7)) e a atual"

# --- 4. Abrir sozinho quando o Windows ligar -------------------------------

Passo 'Configurando para abrir sozinho'

# VBS bem curtos so para iniciar sem deixar janela preta aberta na tela.
# Gravados em Unicode (UTF-16): com ASCII, um nome de usuario com acento
# (Joao, Jose...) virava lixo e o VBS nao achava a pasta.
$vbsIniciar = Join-Path $DESTINO 'Monitor01V96-iniciar.vbs'
$conteudoIniciar = @"
' Inicia o $NOME sem janela. Apague o atalho da pasta Startup para parar de abrir sozinho.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$DESTINO"
sh.Run """$node"" ""$DESTINO\iniciar.js""", 0, False
"@
Set-Content -Path $vbsIniciar -Value $conteudoIniciar -Encoding Unicode

$vbsAtualizar = Join-Path $DESTINO 'Monitor01V96-atualizar.vbs'
$conteudoAtualizar = @"
' Procura versao nova do $NOME e religa o programa se ele caiu. Roda sem janela.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$DESTINO"
sh.Run """$node"" ""$DESTINO\iniciar.js"" atualizar", 0, True
"@
Set-Content -Path $vbsAtualizar -Value $conteudoAtualizar -Encoding Unicode

$vbsStartup = $null
if ($SemIniciar) {
  Ok 'atalho de inicializacao nao criado (-SemIniciar)'
} else {
  $vbsStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Monitor01V96.vbs'
  Copy-Item $vbsIniciar $vbsStartup -Force
  Ok "atalho criado em $vbsStartup"
}

# --- 4b. Atualizacao automatica --------------------------------------------

if ($SemTarefa) {
  Ok 'tarefa de atualizacao nao criada (-SemTarefa)'
} else {
  Passo 'Configurando a atualizacao automatica'
  try {
    $usuario = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acao = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') `
      -Argument "//B //Nologo `"$vbsAtualizar`"" -WorkingDirectory $DESTINO

    # Dois gatilhos: 2 min depois de entrar no Windows, e a cada 30 min para sempre.
    $aoEntrar = New-ScheduledTaskTrigger -AtLogOn -User $usuario
    $aoEntrar.Delay = 'PT2M'
    $aCada30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)

    # Sem janela, sem acordar o PC, sem duas ao mesmo tempo.
    $ajustes = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden `
      -ExecutionTimeLimit (New-TimeSpan -Hours 1)

    # So com o usuario conectado, com as permissoes dele (sem elevar).
    $quem = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited

    # -Force troca a tarefa que ja existir: rodar o instalador de novo nao duplica.
    Register-ScheduledTask -TaskName $TAREFA -Action $acao -Trigger @($aoEntrar, $aCada30) `
      -Settings $ajustes -Principal $quem `
      -Description 'Mantem o Monitor 01V96 no ar e o atualiza quando a mesa estiver desligada.' `
      -Force | Out-Null
    Enable-ScheduledTask -TaskName $TAREFA | Out-Null
    Ok "tarefa '$TAREFA' criada (confere a cada 30 minutos)"
  } catch {
    Aviso "nao consegui criar a tarefa de atualizacao: $($_.Exception.Message)"
    Aviso 'O programa funciona, mas nao vai se atualizar sozinho. Rode o instalador como administrador.'
    try { Enable-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue | Out-Null } catch { }
  }
}

# --- 5. Firewall -----------------------------------------------------------

if ($SemFirewall) {
  Ok 'firewall nao alterado (-SemFirewall)'
} else {
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
}

# --- 6. Ligar agora --------------------------------------------------------

if ($SemIniciar) {
  Write-Host ""
  Write-Host "  Instalado em $DESTINO (nao liguei o programa: -SemIniciar)." -ForegroundColor Green
  return
}

Passo 'Ligando'

# Com a tarefa instalada, quem liga e ela (com o token limitado do usuario, o
# mesmo de todo dia): a vigia do atualizador liga o programa. Sem tarefa, o VBS.
$ligouPelaTarefa = $false
if (-not $SemTarefa -and (Get-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue)) {
  try { Start-ScheduledTask -TaskName $TAREFA; $ligouPelaTarefa = $true } catch { Aviso "nao consegui iniciar a tarefa: $($_.Exception.Message)" }
}
if (-not $ligouPelaTarefa) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbsStartup`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 4

$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

$ligou = $false
$limiteLigar = (Get-Date).AddSeconds(40)
while (-not $ligou -and (Get-Date) -lt $limiteLigar) {
  try {
    $resposta = Invoke-WebRequest "http://localhost:$PORTA/api/status" -UseBasicParsing -TimeoutSec 5
    $ligou = $resposta.StatusCode -eq 200
  } catch { Start-Sleep -Seconds 2 }
}

Write-Host ""
if ($ligou) {
  Write-Host "  Pronto. O $NOME esta rodando." -ForegroundColor Green
} else {
  Write-Host "  Instalado, mas nao consegui confirmar que subiu." -ForegroundColor Yellow
  Write-Host "  Abra $DESTINO e rode: node iniciar.js  para ver a mensagem de erro."
}

Write-Host ""
Write-Host "  No celular, na mesma rede Wi-Fi, abra:" -ForegroundColor White
foreach ($ip in $ips) { Write-Host "     http://$ip`:$PORTA" -ForegroundColor White }
Write-Host ""
Write-Host "  Daqui para frente ele se atualiza sozinho, so quando a mesa estiver" -ForegroundColor White
Write-Host "  desligada e ninguem estiver conectado. Nao precisa rodar isto de novo." -ForegroundColor White
Write-Host ""
Write-Host "  Dicas para nunca mais mexer nisso:" -ForegroundColor DarkGray
Write-Host "   - no navegador do celular, use 'Adicionar a tela de inicio'" -ForegroundColor DarkGray
Write-Host "   - reserve o IP deste computador no roteador, para ele nao mudar" -ForegroundColor DarkGray
Write-Host "   - a calibracao de cada canal se faz pelo proprio celular, no botao de ajustes" -ForegroundColor DarkGray
Write-Host ""

} finally {
  # Se a tarefa foi pausada no comeco e a instalacao abortou, volta a habilitar.
  if ($tarefaPausada) {
    try { Enable-ScheduledTask -TaskName $TAREFA -ErrorAction SilentlyContinue | Out-Null } catch { }
  }
}
