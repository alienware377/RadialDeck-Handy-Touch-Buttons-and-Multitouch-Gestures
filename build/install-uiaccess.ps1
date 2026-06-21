# RadialDeck — one-time UIAccess installer  (RUN AS ADMINISTRATOR)
#
# RadialDeck.exe runs at NORMAL integrity (so Chromium can render). The UIAccess
# privilege that lets it drive elevated windows (e.g. Revo Uninstaller as admin) with
# no UAC prompt lives in a tiny separate helper, RadialDeckInput.exe. Windows grants
# UIAccess to that helper only when ALL of these hold:
#   1. its manifest has uiAccess="true"                  (embedded at build by csc)
#   2. it is Authenticode-signed by a TRUSTED cert       (this script: self-signed + trusted)
#   3. it lives in a secure location (Program Files)     (this script: copies it there)
# So this script signs RadialDeckInput.exe (the one that matters); it also signs
# RadialDeck.exe for good measure.
#
# Re-run this any time you rebuild (npm run dist) to refresh the installed copy.

$ErrorActionPreference = 'Stop'

# --- resolve this script's folder robustly ---
# $PSScriptRoot / $PSCommandPath are only populated when PS runs a .ps1 FILE.
# If the body is pasted into a console they're empty, so fall back to a known path.
$scriptPath = $PSCommandPath
if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
if ($scriptPath) {
  $scriptDir = Split-Path -Parent $scriptPath
} else {
  # pasted interactively: assume the canonical project location
  $scriptDir = 'P:\My Documents\Claude Code\RadialDeck\build'
}

# --- must be elevated ---
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "Re-launching elevated..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -NoExit -ExecutionPolicy Bypass -File `"$scriptDir\install-uiaccess.ps1`""
  return
}

$root    = Split-Path -Parent $scriptDir             # project root (build\ -> ..)
$src     = Join-Path $root 'dist\win-unpacked'
$dest    = Join-Path $env:ProgramFiles 'RadialDeck'
$exeName = 'RadialDeck.exe'
$srcExe  = Join-Path $src $exeName

if (-not (Test-Path $srcExe)) { throw "Build output not found: $srcExe`nRun 'npm run dist' first." }

# --- 1. self-signed code-signing cert (reuse if present) ---
$subject = 'CN=RadialDeck Self-Signed'
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -eq $subject } | Select-Object -First 1
if (-not $cert) {
  Write-Host "Creating self-signed code-signing certificate..." -ForegroundColor Cyan
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -CertStoreLocation Cert:\LocalMachine\My -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
}

# --- 2. trust it: add public cert to Trusted Root + Trusted Publishers ---
$cer = Join-Path $env:TEMP 'radialdeck-codesign.cer'
Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root          | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
Remove-Item $cer -Force -ErrorAction SilentlyContinue
Write-Host "Certificate trusted (Root + TrustedPublisher)." -ForegroundColor Green

# --- 3. stop any running instance, then copy build into Program Files ---
Get-Process RadialDeck, RadialDeckInput -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $src '*') $dest -Recurse -Force
Write-Host "Installed to $dest" -ForegroundColor Green

# --- 4. sign the installed exes (RadialDeckInput.exe MUST be signed for UIAccess) ---
function Sign-Exe([string]$p) {
  if (-not (Test-Path $p)) { throw "Missing exe to sign: $p" }
  try {
    $s = Set-AuthenticodeSignature -FilePath $p -Certificate $cert -HashAlgorithm SHA256 `
           -TimestampServer 'http://timestamp.digicert.com' -ErrorAction Stop
  } catch {
    Write-Host "Timestamp server unreachable; signing $p without timestamp." -ForegroundColor Yellow
    $s = Set-AuthenticodeSignature -FilePath $p -Certificate $cert -HashAlgorithm SHA256
  }
  if ($s.Status -ne 'Valid') { throw "Signing failed for $p : $($s.Status) - $($s.StatusMessage)" }
  Write-Host "Signed: $p  ($($s.Status))" -ForegroundColor Green
}
$destExe = Join-Path $dest $exeName
Sign-Exe (Join-Path $dest 'RadialDeckInput.exe')
Sign-Exe $destExe

# --- 5. Start Menu + Desktop shortcuts ---
$ws = New-Object -ComObject WScript.Shell
foreach ($lnkDir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $lnk = $ws.CreateShortcut((Join-Path $lnkDir 'RadialDeck.lnk'))
  $lnk.TargetPath = $destExe
  $lnk.WorkingDirectory = $dest
  $lnk.Save()
}
Write-Host "Shortcuts created." -ForegroundColor Green

Write-Host "`nDone. Launch RadialDeck from the Start Menu / Desktop shortcut (NOT 'npm start')." -ForegroundColor White
Write-Host "It now runs with UIAccess and can control elevated windows with no UAC prompt." -ForegroundColor White
