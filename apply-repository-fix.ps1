param(
    [string]$PatchPath = ".\ttc-repo-fix.patch",
    [string]$DestinationPath = ""
)

$ErrorActionPreference = "Stop"
$sourceRepo = (Get-Location).Path
$resolvedPatch = (Resolve-Path $PatchPath).Path
$expectedHead = "5739601f2776cbcfce69e5ab115ebcbfa3da7dc0"
$bashPath = "C:\Program Files\Git\bin\bash.exe"
if (!(Test-Path $bashPath)) { throw "Git Bash was not found at $bashPath. Install Git for Windows before continuing." }
if (!$DestinationPath) { $DestinationPath = Join-Path (Split-Path $sourceRepo -Parent) "ttc-work7-fixed" }
if (Test-Path $DestinationPath) { throw "Destination already exists. Keep it intact and choose a new -DestinationPath." }

function Invoke-Checked {
    param([string]$Command, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE. Stop; do not commit or push." }
}

Invoke-Checked git.exe clone https://github.com/NhatTiens/ttc.git $DestinationPath
Set-Location $DestinationPath
Invoke-Checked git.exe checkout main
Invoke-Checked git.exe pull --rebase origin main
$actualHead = (& git.exe rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to read repository HEAD." }
if ($actualHead -ne $expectedHead) {
    throw "main has changed: $actualHead. This patch targets $expectedHead; request a rebase before applying. Your original repository is untouched."
}
Invoke-Checked git.exe apply --check $resolvedPatch
Invoke-Checked git.exe apply --index $resolvedPatch
if (!(Test-Path ".\scripts\work7-verify.sh")) { throw "The complete verification script is missing. Stop." }

$sourceEnv = Join-Path $sourceRepo ".env"
if (Test-Path $sourceEnv) {
    Copy-Item $sourceEnv ".env"
} else {
    Copy-Item ".env.example" ".env"
    throw "Code updated in $((Get-Location).Path). Configure .env (AUTH_SECRET, DATABASE_URL, separate TEST_DATABASE_URL) and start PostgreSQL, then run the commands in REPOSITORY_FIX_REPORT.md. No tests or push were performed."
}

Invoke-Checked npm.cmd ci
Invoke-Checked npm.cmd run db:generate
Invoke-Checked npm.cmd run db:validate
Invoke-Checked npm.cmd run db:migrate
Invoke-Checked $bashPath ./scripts/work7-verify.sh
Invoke-Checked git.exe status
Invoke-Checked git.exe diff --cached --stat
Write-Host "All local verification gates succeeded. Review the staged diff before committing. This script never commits or pushes."
