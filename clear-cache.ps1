# clear-cache.ps1 — Vide TOUS les caches de PsyGest (WebView2 + Vite)
# Usage : .\clear-cache.ps1  puis  npm run tauri dev

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Fermeture de psygest..." -ForegroundColor Yellow
Stop-Process -Name "psygest" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 1. Cache WebView2 (navigateur embarqué Tauri)
$webview = "$env:LOCALAPPDATA\fr.cesarbroche.psygest"
if (Test-Path $webview) {
    Remove-Item $webview -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Cache WebView2 supprimé" -ForegroundColor Green
}

# 2. Cache Vite (modules JS transformés — LE plus important)
$viteCaches = @(
    "$root\node_modules\.vite",
    "$root\.vite",
    "$root\src\.vite"
)
foreach ($path in $viteCaches) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Cache Vite supprimé : $path" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Tous les caches vidés. Lancez maintenant :" -ForegroundColor Cyan
Write-Host '  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"' -ForegroundColor White
Write-Host "  npm run tauri dev" -ForegroundColor White
