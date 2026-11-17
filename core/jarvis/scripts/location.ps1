# Asks Windows Location for the current position and prints it as JSON.
# Windows works it out from nearby Wi-Fi networks (or GPS where there is one),
# which is far closer than an IP address. Prints {"status": ...} when it can't.
Add-Type -AssemblyName System.Device
$watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
if (-not $watcher.TryStart($false, [TimeSpan]::FromSeconds(1))) {
  ConvertTo-Json @{ status = 'unavailable' } -Compress
  exit
}
$deadline = (Get-Date).AddSeconds(15)
while ($watcher.Status -ne 'Ready' -and $watcher.Permission -ne 'Denied' -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
}
$loc = $watcher.Position.Location
if ($watcher.Permission -eq 'Denied') {
  ConvertTo-Json @{ status = 'denied' } -Compress
} elseif ($loc.IsUnknown) {
  ConvertTo-Json @{ status = "$($watcher.Status)".ToLower() } -Compress
} else {
  ConvertTo-Json @{ status = 'ok'; latitude = $loc.Latitude; longitude = $loc.Longitude; accuracy_m = $loc.HorizontalAccuracy } -Compress
}
$watcher.Stop()
