# RadialDeck post-install UIAccess setup (run elevated by the NSIS installer's customInstall).
# RadialDeck.exe stays NORMAL integrity (so Chromium renders); the UIAccess privilege that
# lets it drive elevated windows lives in the separate RadialDeckInput.exe. Windows grants
# UIAccess only when that helper is (1) manifested uiAccess=true [done at build], (2) signed
# by a TRUSTED cert [this script], and (3) in a secure location [Program Files, by the installer].
param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

# 1. self-signed code-signing cert (reuse if already present)
$subject = 'CN=RadialDeck Self-Signed'
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -eq $subject } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -CertStoreLocation Cert:\LocalMachine\My -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
}

# 2. trust it (Root + TrustedPublisher) so the UIAccess signature check passes
$cer = Join-Path $env:TEMP 'radialdeck-codesign.cer'
Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
Remove-Item $cer -Force -ErrorAction SilentlyContinue

# 3. sign the helper (required for UIAccess) and the main exe (for good measure)
foreach ($name in @('RadialDeckInput.exe', 'RadialDeck.exe')) {
  $p = Join-Path $InstallDir $name
  if (Test-Path $p) {
    try { Set-AuthenticodeSignature -FilePath $p -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com' -ErrorAction Stop | Out-Null }
    catch { Set-AuthenticodeSignature -FilePath $p -Certificate $cert -HashAlgorithm SHA256 | Out-Null }
  }
}

# 4. Start Menu + Desktop shortcuts
$exe = Join-Path $InstallDir 'RadialDeck.exe'
if (Test-Path $exe) {
  $ws = New-Object -ComObject WScript.Shell
  foreach ($lnkDir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = $ws.CreateShortcut((Join-Path $lnkDir 'RadialDeck.lnk'))
    $lnk.TargetPath = $exe; $lnk.WorkingDirectory = $InstallDir; $lnk.Save()
  }
}
Write-Output 'UIAccess setup complete.'
