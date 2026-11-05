# Сборка APK «AssisTV: На TV» без Android Studio и Gradle — только JDK 17 и Android SDK
# (platforms;android-35, build-tools;35.0.0). Готовый пакет — android\build\assistv-send.apk.
#
#   .\android\build.ps1 -Sdk C:\android\sdk -Jdk C:\android\jdk17 -Keystore my.jks
#
# Keystore — ключ подписи; нет файла — создаётся (храните его: обновление приложения подписывается тем же ключом).
# Пароль ключа — переменная окружения ASSISTV_KEY_PASS (по умолчанию «android»).
param(
    [Parameter(Mandatory = $true)][string]$Sdk,
    [Parameter(Mandatory = $true)][string]$Jdk,
    [Parameter(Mandatory = $true)][string]$Keystore
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$bt = Join-Path $Sdk 'build-tools\35.0.0'
$androidJar = Join-Path $Sdk 'platforms\android-35\android.jar'
$env:JAVA_HOME = $Jdk
$env:Path = (Join-Path $Jdk 'bin') + ';' + $env:Path
$pass = if ($env:ASSISTV_KEY_PASS) { $env:ASSISTV_KEY_PASS } else { 'android' }

function Run([string]$exe, [string[]]$params) {
    & $exe @params
    if ($LASTEXITCODE) { throw "$exe завершился с кодом $LASTEXITCODE" }
}

$out = Join-Path $here 'build'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
$gen = Join-Path $out 'gen'; $cls = Join-Path $out 'classes'; $dex = Join-Path $out 'dex'
New-Item -ItemType Directory $gen, $cls, $dex | Out-Null

# 1. ресурсы → resources.zip, затем манифест + ресурсы → base.apk и R.java
$resZip = Join-Path $out 'resources.zip'
Run (Join-Path $bt 'aapt2.exe') @('compile', '--dir', (Join-Path $here 'res'), '-o', $resZip)
$base = Join-Path $out 'base.apk'
Run (Join-Path $bt 'aapt2.exe') @('link', '-o', $base, '-I', $androidJar, '--manifest', (Join-Path $here 'AndroidManifest.xml'),
    '--java', $gen, '--min-sdk-version', '26', '--target-sdk-version', '35', $resZip)

# 2. Java → classes → classes.dex
$sources = @(Get-ChildItem -Recurse (Join-Path $here 'src'), $gen -Filter *.java | ForEach-Object { $_.FullName })
Run 'javac' (@('--release', '11', '-encoding', 'UTF-8', '-classpath', $androidJar, '-d', $cls) + $sources)
$classFiles = @(Get-ChildItem -Recurse $cls -Filter *.class | ForEach-Object { $_.FullName })
Run (Join-Path $bt 'd8.bat') (@('--release', '--min-api', '26', '--lib', $androidJar, '--output', $dex) + $classFiles)

# 3. classes.dex в пакет, выравнивание, подпись
Copy-Item $base (Join-Path $out 'unsigned.apk')
Push-Location $dex
try { Run 'jar' @('uf', (Join-Path $out 'unsigned.apk'), 'classes.dex') } finally { Pop-Location }
$aligned = Join-Path $out 'aligned.apk'
Run (Join-Path $bt 'zipalign.exe') @('-f', '-p', '4', (Join-Path $out 'unsigned.apk'), $aligned)

if (-not (Test-Path $Keystore)) {
    $dir = Split-Path -Parent $Keystore
    if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Run 'keytool' @('-genkeypair', '-keystore', $Keystore, '-alias', 'assistv', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '10000', '-storepass', $pass, '-keypass', $pass, '-dname', 'CN=AssisTV')
    Write-Host "создан ключ подписи: $Keystore"
}
$apk = Join-Path $out 'assistv-send.apk'
Run (Join-Path $bt 'apksigner.bat') @('sign', '--ks', $Keystore, '--ks-key-alias', 'assistv', '--ks-pass', "pass:$pass",
    '--key-pass', "pass:$pass", '--out', $apk, $aligned)
# копия рядом с исходниками — готовый файл для установки на другой телефон (просьба пользователя)
$ready = Join-Path $here 'AssisTV-To-TV.apk'
Copy-Item $apk $ready -Force
Write-Host ("пакет: {0} ({1:N0} КБ)" -f $ready, ((Get-Item $ready).Length / 1KB))
