# Сборка установщика в один файл: installer\dist\AssisTV-Installer.exe
#   .\installer\build.ps1
# Нужен Node.js 25.5+ (ключ --build-sea). Внутри .exe — сам Node и весь код, ставить ничего не надо.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path 'node_modules')) {
        npm install --no-audit --no-fund | Out-Null
        if ($LASTEXITCODE) { throw 'npm install не прошёл' }
    }
    node test/selftest.js --offline
    if ($LASTEXITCODE) { throw 'самопроверка не прошла' }

    New-Item -ItemType Directory -Force dist | Out-Null
    npx esbuild src/main.js --bundle --platform=node --format=cjs --loader:.html=text --outfile=dist/main.cjs --log-level=warning
    if ($LASTEXITCODE) { throw 'esbuild не прошёл' }

    '{ "main": "main.cjs", "output": "AssisTV-Installer.exe", "disableExperimentalSEAWarning": true }' | Set-Content dist/sea.json
    Push-Location dist
    try {
        node --build-sea sea.json
        if ($LASTEXITCODE) { throw 'node --build-sea не прошёл' }
    } finally { Pop-Location }
    $exe = Get-Item dist/AssisTV-Installer.exe
    Write-Host ("готово: {0} ({1:N0} МБ)" -f $exe.FullName, ($exe.Length / 1MB))
} finally { Pop-Location }
