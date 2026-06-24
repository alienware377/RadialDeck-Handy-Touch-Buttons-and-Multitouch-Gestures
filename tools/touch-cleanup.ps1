# RadialDeck touch cleanup — removes phantom touch-routing devices that confuse Windows
# pointer→display mapping (root cause of "scroll jumps to a ghost monitor" bugs).
# Targets: non-present Monitor devices, non-present spacedesk DATRONICSOFT virtual
# digitizer nodes, non-present spacedesk Display adapters (SWD\{...}), and the
# spacedesk virtual Bus when non-present.
# HARD SAFETIES: never touches the real Goodix digitizer (VID_27C6) and never removes
# anything currently Status=OK.
$ErrorActionPreference = 'SilentlyContinue'
$out = 'C:\RadialDeckInstall\touch-cleanup-result.txt'
$log = @()
$log += "START $(Get-Date -Format o)"

$targets = @()
$targets += Get-PnpDevice -Class Monitor | Where-Object { $_.Status -ne 'OK' }
$targets += Get-PnpDevice -Class Display | Where-Object {
    $_.Status -ne 'OK' -and ($_.FriendlyName -match 'spacedesk' -or $_.InstanceId -match 'DATRONICSOFT|spacedesk')
}
$targets += Get-PnpDevice -Class System  | Where-Object {
    $_.Status -ne 'OK' -and ($_.FriendlyName -match 'spacedesk' -or $_.InstanceId -match 'DATRONICSOFT|SPACEDESK')
}
$targets += Get-PnpDevice | Where-Object {
    $_.Status -ne 'OK' -and ($_.InstanceId -match 'DATRONICSOFT' -or $_.FriendlyName -match 'spacedesk')
}
$targets = $targets | Sort-Object InstanceId -Unique

$log += "targets: " + $targets.Count
$removed = 0; $failed = 0
foreach ($d in $targets) {
    if ($d.InstanceId -match 'VID_27C6') { $log += "SKIP goodix $($d.InstanceId)"; continue }
    if ($d.Status -eq 'OK')              { $log += "SKIP present $($d.InstanceId)"; continue }
    $r = & pnputil /remove-device "$($d.InstanceId)" 2>&1 | Out-String
    $r = $r.Trim()
    if ($r -match 'success|removed') { $removed++ } else { $failed++ }
    $log += "REMOVE [$($d.Class)] $($d.FriendlyName) | $($d.InstanceId) => $r"
}
$log += "DONE removed=$removed failed=$failed"
$log += "END $(Get-Date -Format o)"
$log | Set-Content -Path $out -Encoding UTF8
