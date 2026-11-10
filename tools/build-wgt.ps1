# Сборка пакета телевизора (.wgt) из чистой копии: в пакет идут только файлы плеера —
# без .git, документации, аддона и личных файлов. Готовый пакет — .buildResult\AssisTV.wgt.
#
#   .\tools\build-wgt.ps1 -Cert mytv
#   .\tools\build-wgt.ps1 -Cert mytv -Install 192.168.1.20:26101
#   .\tools\build-wgt.ps1 -Cert mytv -Defaults my-defaults.js   # свои умолчания (см. js/local-defaults.js)
#   .\tools\build-wgt.ps1 -Cert mytv -Legacy                     # для старых TV (Tizen 3–5) → AssisTV-legacy.wgt
#   .\tools\build-wgt.ps1 -Unsigned -Legacy -Out x.wgt            # без подписи и без Tizen Studio — для GitHub Releases
#
# Cert — профиль сертификата Tizen Studio (tizen security-profiles list).
# Install — sdb-адрес телевизора: пакет сразу ставится (sdb connect, tizen install, sdb disconnect).
# Legacy — JS в ES5, полифилы, CSS-заплатки (tools/legacy/build-legacy.js); нужен Node.js.
# Unsigned — пакет без подписи: его подписывает установщик (installer/) на компьютере пользователя.
param(
    [string]$Cert = '',
    [string]$Defaults = '',
    [string]$Install = '',
    [switch]$Legacy,
    [switch]$Unsigned,
    [string]$Out = ''
)
if (-not $Cert -and -not $Unsigned) { throw 'нужен -Cert <профиль> или -Unsigned' }
if ($Unsigned -and $Install) { throw '-Install без подписи не работает: телевизор не примет пакет' }
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tizenBin = 'C:\tizen-studio\tools\ide\bin', 'C:\tizen-studio\tools'
foreach ($p in $tizenBin) { if ((Test-Path $p) -and (($env:Path -split ';') -notcontains $p)) { $env:Path += ";$p" } }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('tizen-wgt-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $stage | Out-Null
try {
    foreach ($f in 'config.xml', 'index.html', 'icon.png') { Copy-Item (Join-Path $root $f) $stage }
    foreach ($d in 'css', 'js', 'libs', 'lang', 'images') { Copy-Item -Recurse (Join-Path $root $d) $stage }
    if ($Defaults) {
        Copy-Item (Resolve-Path $Defaults) (Join-Path $stage 'js\local-defaults.js') -Force
        Write-Host "умолчания: $Defaults"
    }
    if ($Legacy) {
        $legacyTools = Join-Path $PSScriptRoot 'legacy'
        if (-not (Test-Path (Join-Path $legacyTools 'node_modules'))) {
            Push-Location $legacyTools
            try { npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
            if ($LASTEXITCODE) { throw 'npm install в tools/legacy не прошёл' }
        }
        node (Join-Path $legacyTools 'build-legacy.js') $stage
        if ($LASTEXITCODE) { throw 'сборка legacy не прошла' }
    }

    if ($Unsigned) {
        # обычный zip из чистой копии; пути внутри — через «/» (.NET в PowerShell 7)
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $pkg = if ($Out) { [IO.Path]::GetFullPath($Out, (Get-Location).Path) } else { Join-Path $root ('.buildResult\AssisTV' + $(if ($Legacy) { '-legacy' } else { '' }) + '-unsigned.wgt') }
        New-Item -ItemType Directory -Force (Split-Path $pkg) | Out-Null
        Remove-Item $pkg -ErrorAction SilentlyContinue
        [IO.Compression.ZipFile]::CreateFromDirectory($stage, $pkg, [IO.Compression.CompressionLevel]::Optimal, $false)
        Write-Host ("пакет без подписи: {0} ({1:N0} КБ)" -f $pkg, ((Get-Item $pkg).Length / 1KB))
        return
    }

    Push-Location $stage
    try {
        tizen build-web -- . | Out-Null
        if ($LASTEXITCODE) { throw 'tizen build-web не прошёл' }
        $out = tizen package -t wgt -s $Cert -- .buildResult
        if ($LASTEXITCODE -or -not (Test-Path '.buildResult\*.wgt')) { $out; throw 'tizen package не прошёл' }
    } finally { Pop-Location }

    $dest = Join-Path $root '.buildResult'
    New-Item -ItemType Directory -Force $dest | Out-Null
    $wgt = Get-Item (Join-Path $stage '.buildResult\*.wgt')
    $name = if ($Legacy) { $wgt.BaseName + '-legacy.wgt' } else { $wgt.Name }
    $pkg = Join-Path $dest $name
    Copy-Item $wgt.FullName $pkg -Force
    Write-Host ("пакет: {0} ({1:N0} КБ)" -f $pkg, ((Get-Item $pkg).Length / 1KB))

    if ($Install) {
        sdb connect $Install
        try {
            tizen install -n $pkg -s $Install
            if ($LASTEXITCODE) { throw 'установка не прошла' }
        } finally { sdb disconnect $Install | Out-Null }
    }
} finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
