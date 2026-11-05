# Деплой EPG-сервиса как локального аддона Home Assistant OS на Raspberry Pi.
#
# Что делает:
#   1. кладёт в epg_builder/shared свежие копии парсеров из js/ (они же работают на TV —
#      нормализация имён на бэкенде и в плеере обязана совпадать) и переводы (js/i18n.js, lang/*.js);
#   2. копирует папку аддона на Pi через SSH (аддон «Terminal & SSH») в папку локальных аддонов:
#      /local_apps/epg_builder (Supervisor 2026.09+ переименовал монтирование) или /addons/epg_builder (раньше);
#   3. перечитывает локальные аддоны и ставит (первый раз) или пересобирает аддон.
#
#   .\ha-addon\deploy.ps1 -PiHost 192.168.1.10 [-Key ~/.ssh/ha_pi_ed25519]
#
# Требования: в аддоне «Terminal & SSH» добавлен публичный ключ (-Key + .pub)
# и в разделе «Сеть» задан порт SSH 2222 (без порта аддон SSH-сервер не запускает).
param(
    [Parameter(Mandatory = $true)][string]$PiHost,
    [int]$Port = 2222,
    [string]$User = 'root',
    [string]$Key = "$env:USERPROFILE\.ssh\ha_pi_ed25519"
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$addon = Join-Path $PSScriptRoot 'epg_builder'
$shared = Join-Path $addon 'shared'
$slug = 'local_epg_builder'

New-Item -ItemType Directory -Force $shared | Out-Null
$sharedFiles = 'channel-name.js', 'm3u-parser.js', 'xmltv-parser.js', 'channel-match.js', 'vod-sources.js', 'i18n.js'
foreach ($f in $sharedFiles) {
    Copy-Item (Join-Path $root "js\$f") (Join-Path $shared $f) -Force
}
# плагины-источники фильмов в образ не входят — их ставят со страницы аддона (раздел «Плагины»)
# словари: страница аддона, ответы для Assist и карточка HA — на тех же фразах, что и телевизор
$sharedLang = Join-Path $shared 'lang'
New-Item -ItemType Directory -Force $sharedLang | Out-Null
Remove-Item (Join-Path $sharedLang '*.js') -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'lang\*.js') $sharedLang -Force
$langFiles = Get-ChildItem (Join-Path $sharedLang '*.js') | ForEach-Object { $_.FullName }

$ssh = @('-p', $Port, '-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', "$User@$PiHost")

# 16.09.2026: после обновления Supervisor папка локальных аддонов в SSH-аддоне смонтирована как /local_apps, а /addons
# стал обычной папкой внутри контейнера — копирование туда «проходило», но Supervisor собирал старую версию.
# Поэтому берём ту папку, что реально смонтирована (есть в /proc/mounts).
$dest = (ssh @ssh "grep -qE ' /local_apps ' /proc/mounts && echo /local_apps/epg_builder || (grep -qE ' /addons ' /proc/mounts && echo /addons/epg_builder)").Trim()
if (-not $dest) { throw 'на Pi не смонтирована папка локальных аддонов (/local_apps или /addons)' }
Write-Host "папка аддона на Pi: $dest"

ssh @ssh "rm -rf $dest && mkdir -p $dest/shared/lang $dest/card $dest/web $dest/translations"
scp -P $Port -i $Key -o StrictHostKeyChecking=accept-new `
    "$addon\config.yaml" "$addon\Dockerfile" "$addon\package.json" "$addon\build.js" "$addon\server.js" `
    "$addon\card-data.js" "$addon\vod.js" "$addon\tmdb.js" "$addon\kinopoisk.js" "$addon\archive.js" "$addon\parental.js" `
    "$addon\favorites.js" "$addon\watchlist.js" "$addon\plugins.js" "$addon\guide.js" "$addon\history.js" "$addon\pairing.js" "$addon\mqtt-proxy.js" "$addon\sandbox.js" "$addon\plugin-host.js" "$addon\DOCS.md" `
    "$addon\icon.png" "$addon\logo.png" `
    "${User}@${PiHost}:${dest}/"
scp -P $Port -i $Key ($sharedFiles | ForEach-Object { Join-Path $shared $_ }) `
    "${User}@${PiHost}:${dest}/shared/"
scp -P $Port -i $Key "$addon\card\tizen-iptv-card.js" "${User}@${PiHost}:${dest}/card/"
scp -P $Port -i $Key $langFiles "${User}@${PiHost}:${dest}/shared/lang/"
scp -P $Port -i $Key "$addon\web\mapping.js" "${User}@${PiHost}:${dest}/web/"
scp -P $Port -i $Key (Get-ChildItem "$addon\translations\*.yaml" | ForEach-Object { $_.FullName }) "${User}@${PiHost}:${dest}/translations/"
# config.yaml ссылается на готовые образы GHCR (image:). Локальный аддон собирается из этих файлов — иначе
# Supervisor скачал бы опубликованный образ вместо только что скопированного кода.
ssh @ssh "sed -i '/^image:/d' $dest/config.yaml"

# Первый раз — install, дальше — rebuild (подхватывает новый код, настройки сохраняются)
$remote = @"
# 03.11.2026: store reload проходит успешно, но новую version локального аддона не видит — нужен ещё apps reload
ha store reload >/dev/null 2>&1
ha apps reload >/dev/null 2>&1
if ha apps info $slug 2>/dev/null | grep -qE '^state: (started|stopped|error)'; then
    # поменялась version в config.yaml — rebuild откажет, нужен update
    if ha apps info $slug | grep -q '^update_available: true'; then
        ha apps update $slug
    else
        ha apps rebuild $slug
    fi
    ha apps restart $slug
    # 15.09.2026: update на 2.1.0 поменял версию, но образ не собрал (Image ... does not exist) — тогда rebuild
    if ! ha apps info $slug | grep -q '^state: started'; then
        ha apps rebuild $slug && ha apps start $slug
    fi
else
    ha apps install $slug && ha apps start $slug
fi
ha apps info $slug | grep -E '^(state|version):'
"@
# CRLF из Windows-файла ломает bash на той стороне
ssh @ssh ($remote -replace "`r", '')
Write-Host "Готово. Статус: http://${PiHost}:8765/status"
