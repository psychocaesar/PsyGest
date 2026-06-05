# clear-cache.ps1 — Vide le cache WebView2 de PsyGest
# Usage : .\clear-cache.ps1 (puis relancer npm run tauri dev)

Write-Host "Fermeture de psygest.exe..." -ForegroundColor Yellow
Stop-Process -Name "psygest" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$cachePath = "$env:LOCALAPPDATA\fr.cesarbroche.psygest"
if (Test-Path $cachePath) {
    Remove-Item $cachePath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Cache WebView2 supprimé." -ForegroundColor Green
} else {
    Write-Host "Aucun cache à supprimer." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Relancez l'app avec :" -ForegroundColor Cyan
Write-Host '  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"' -ForegroundColor White
Write-Host "  npm run tauri dev" -ForegroundColor White
