# Выпуск на GitHub (Releases) — после каждой новой версии плеера:
#   .\tools\release.ps1            — собрать и выложить релиз v<версия из config.xml>
#   .\tools\release.ps1 -DryRun    — только собрать, ничего не выкладывать
#
# В релиз идут два файла с постоянными именами (ссылки .../releases/latest/download/<имя> не меняются):
#   AssisTV.wgt            — плеер, сборка -Legacy (один пакет для всех TV, Tizen 3+), БЕЗ подписи:
#                            подписывает установщик на компьютере пользователя;
#   AssisTV-Installer.exe  — установщик (installer/). Пункт «AssisTV» в нём берёт .wgt из последнего релиза.
# Релиз с таким тегом уже есть — файлы в нём заменяются.
# Нужны: PowerShell 7, Node.js 25.5+, gh (вход в GitHub).
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$repo = 'indoor25/AssisTV'
$version = ([xml](Get-Content (Join-Path $root 'config.xml') -Raw)).widget.version
if (-not $version) { throw 'нет версии в config.xml' }
$tag = "v$version"
$out = Join-Path $root '.buildResult\release'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null

& (Join-Path $PSScriptRoot 'build-wgt.ps1') -Unsigned -Legacy -Out (Join-Path $out 'AssisTV.wgt')
& (Join-Path $root 'installer\build.ps1')
Copy-Item (Join-Path $root 'installer\dist\AssisTV-Installer.exe') $out

$files = Get-ChildItem $out | ForEach-Object { $_.FullName }
$files | ForEach-Object { Write-Host (" {0}  {1:N0} КБ" -f (Split-Path $_ -Leaf), ((Get-Item $_).Length / 1KB)) }
if ($DryRun) { Write-Host "DryRun: релиз $tag не выкладывался"; return }

$notes = @"
**AssisTV $version**

Install on a Samsung TV without Tizen Studio: download **AssisTV-Installer.exe**, start it and follow the page
(turn on Developer Mode on the TV — the installer shows how). Details: [docs/en/install-tv.md](https://github.com/$repo/blob/main/docs/en/install-tv.md).

Установка на телевизор Samsung без Tizen Studio: скачайте **AssisTV-Installer.exe**, запустите и следуйте странице
(включить на телевизоре режим разработчика — установщик покажет как). Подробно: [docs/install-tv.md](https://github.com/$repo/blob/main/docs/install-tv.md).

What's new / что нового — [CHANGELOG.md](https://github.com/$repo/blob/main/CHANGELOG.md).
"@

gh release view $tag -R $repo *> $null
if ($LASTEXITCODE -eq 0) {
    gh release upload $tag @files -R $repo --clobber
} else {
    gh release create $tag @files -R $repo --title "AssisTV $version" --notes $notes --latest
}
if ($LASTEXITCODE) { throw 'gh release не прошёл' }
Write-Host "готово: https://github.com/$repo/releases/tag/$tag"
