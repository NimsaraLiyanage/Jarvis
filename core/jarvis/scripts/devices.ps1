# Lists connected Bluetooth devices and external USB devices as JSON.
# Run by devices.py; kept as one script so PowerShell starts only once per scan.
$ErrorActionPreference = 'SilentlyContinue'
$IsConnected = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
# Devices built into the PC all share this container id.
$Internal = '{00000000-0000-0000-ffff-ffffffffffff}'
$out = @()

$bt = Get-PnpDevice -Class Bluetooth | Where-Object { $_.InstanceId -match '^BTH(ENUM|LE)\\DEV_' }
$seen = @{}
foreach ($d in $bt) {
  $addr = $d.InstanceId.Split('\')[1]
  if ($seen[$addr]) { continue }
  if ((Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $IsConnected).Data -eq $true) {
    $seen[$addr] = $true
    $out += [pscustomobject]@{ kind = 'bluetooth'; id = $addr; name = $d.FriendlyName }
  }
}

$usb = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\' -and $_.Class -ne 'USB' }
foreach ($d in $usb) {
  $props = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_BusReportedDeviceDesc'
  $container = ($props | Where-Object KeyName -eq 'DEVPKEY_Device_ContainerId').Data
  if ("$container".ToLower() -eq $Internal) { continue }
  $name = ($props | Where-Object KeyName -eq 'DEVPKEY_Device_BusReportedDeviceDesc').Data
  if (-not $name) { $name = $d.FriendlyName }
  $out += [pscustomobject]@{ kind = 'usb'; id = $d.InstanceId; name = $name; type = $d.Class }
}

ConvertTo-Json -InputObject @($out) -Compress
