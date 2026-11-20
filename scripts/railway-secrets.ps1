# Copies the secret keys from .env into the linked Railway service (Variables), without printing them.
# Run from the repository root after `railway login` and `railway link` (see README → Deploy).
#   powershell -ExecutionPolicy Bypass -File scripts\railway-secrets.ps1
$ErrorActionPreference = 'Stop'
# A UTF-8 console would otherwise put a byte-order mark in front of every value sent to the CLI.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$secretNames = @(
  'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'ENCRYPTION_KEY', 'MANAGER_BOT_TOKEN',
  # Backup model (Grok or another OpenAI-compatible API); skipped while empty.
  'GROK_API_KEY', 'GROK_BASE_URL', 'GROK_MODEL',
  # Card payments (Freedom Pay merchant cabinet → Settings); skipped while empty.
  'FREEDOMPAY_MERCHANT_ID', 'FREEDOMPAY_SECRET_KEY', 'FREEDOMPAY_TESTING'
)

# Railway CLI: $env:RAILWAY_CLI, `railway` on PATH, or the copy installed by the setup assistant.
$cli = $env:RAILWAY_CLI
if (-not $cli) { $cli = (Get-Command railway -ErrorAction SilentlyContinue).Source }
if (-not $cli) {
  $cli = Get-ChildItem "$env:LOCALAPPDATA\Temp\claude" -Recurse -Filter railway.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $cli) { throw 'Railway CLI not found. Install it (npm i -g @railway/cli) or set RAILWAY_CLI.' }

if (-not (Test-Path .env)) { throw '.env not found in the repository root.' }
$values = @{}
foreach ($line in Get-Content .env) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $values[$matches[1]] = $matches[2].Trim().Trim('"') }
}

foreach ($name in $secretNames) {
  $value = $values[$name]
  if (-not $value) { Write-Host "skip  $name (empty in .env)"; continue }
  # The value goes through stdin, so it never appears in a command line or log.
  $psi = New-Object System.Diagnostics.ProcessStartInfo $cli
  $psi.Arguments = "variable set $name --stdin --skip-deploys"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Write($value)
  $proc.StandardInput.Close()
  $null = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "Railway rejected $name" }
  Write-Host "set   $name"
}
Write-Host ''
Write-Host 'Railway now has the secret keys from .env. Restarting the service with them...'
& $cli redeploy --yes | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'Could not start the redeploy: press "Redeploy" on the service in Railway.' }
else { Write-Host 'Deploying. The site will be live in about 2 minutes.' }
