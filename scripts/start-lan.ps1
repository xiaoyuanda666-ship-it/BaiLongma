param(
  [ValidateSet('app', 'backend')]
  [string]$Mode = 'app'
)

$ErrorActionPreference = 'Stop'

function New-RandomBase64Url {
  param([int]$ByteCount = 32)
  $bytes = New-Object byte[] $ByteCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-PrivateLanAddress {
  param([string]$Address)

  $parts = $Address.Split('.') | ForEach-Object { [int]$_ }
  return $parts[0] -eq 10 -or
    ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or
    ($parts[0] -eq 192 -and $parts[1] -eq 168)
}

function New-LanCertificates {
  param(
    [string]$LanDir,
    [string[]]$Addresses
  )

  New-Item -ItemType Directory -Force -Path $LanDir | Out-Null
  $rootPfx = Join-Path $LanDir 'root-ca.pfx'
  $rootCer = Join-Path $LanDir 'bailongma-lan-root-ca.cer'
  $serverPfx = Join-Path $LanDir 'server.pfx'
  $passwordFile = Join-Path $LanDir 'pfx-passphrase.txt'
  $metadataFile = Join-Path $LanDir 'certificate-metadata.json'

  if (Test-Path $passwordFile) {
    $passwordPlain = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
  } else {
    $passwordPlain = New-RandomBase64Url 36
    Set-Content -LiteralPath $passwordFile -Value $passwordPlain -Encoding ascii
  }
  $password = ConvertTo-SecureString $passwordPlain -AsPlainText -Force

  $metadata = $null
  if (Test-Path $metadataFile) {
    try { $metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json } catch {}
  }

  $rootNeedsCreation = !(Test-Path $rootPfx) -or !(Test-Path $rootCer) -or !$metadata.rootThumbprint
  if ($rootNeedsCreation) {
    $root = New-SelfSignedCertificate `
      -Type Custom `
      -Subject 'CN=Bailongma LAN Root CA' `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -KeyExportPolicy Exportable `
      -KeyUsage CertSign, CRLSign, DigitalSignature `
      -NotAfter (Get-Date).AddYears(10) `
      -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1')
    Export-PfxCertificate -Cert $root -FilePath $rootPfx -Password $password -Force | Out-Null
    Export-Certificate -Cert $root -FilePath $rootCer -Force | Out-Null
    $rootThumbprint = $root.Thumbprint
  } else {
    $rootThumbprint = [string]$metadata.rootThumbprint
    $root = Get-ChildItem 'Cert:\CurrentUser\My' |
      Where-Object { $_.Thumbprint -eq $rootThumbprint -and $_.HasPrivateKey } |
      Select-Object -First 1
    if (!$root) {
      $root = Import-PfxCertificate `
        -FilePath $rootPfx `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Password $password `
        -Exportable |
        Select-Object -First 1
    }
  }

  $addressKey = (($Addresses | Sort-Object) -join ',')
  $storedAddressKey = if ($metadata.addresses) {
    ((@($metadata.addresses) | ForEach-Object { [string]$_ } | Sort-Object) -join ',')
  } else { '' }
  $serverNeedsCreation = !(Test-Path $serverPfx) -or $addressKey -ne $storedAddressKey -or $rootNeedsCreation

  if ($serverNeedsCreation) {
    $sanParts = @('DNS=localhost', 'IPAddress=127.0.0.1')
    if ($env:COMPUTERNAME) {
      $sanParts += "DNS=$($env:COMPUTERNAME)"
      $sanParts += "DNS=$($env:COMPUTERNAME).local"
    }
    $sanParts += $Addresses | ForEach-Object { "IPAddress=$_" }

    $server = New-SelfSignedCertificate `
      -Type Custom `
      -Subject 'CN=Bailongma LAN' `
      -Signer $root `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -KeyExportPolicy Exportable `
      -KeyUsage DigitalSignature, KeyEncipherment `
      -NotAfter (Get-Date).AddYears(3) `
      -TextExtension @(
        '2.5.29.37={text}1.3.6.1.5.5.7.3.1',
        "2.5.29.17={text}$($sanParts -join '&')"
      )
    Export-PfxCertificate -Cert $server -FilePath $serverPfx -Password $password -ChainOption BuildChain -Force | Out-Null

    [pscustomobject]@{
      rootThumbprint = $rootThumbprint
      addresses = @($Addresses | Sort-Object)
      generatedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $metadataFile -Encoding utf8
  }

  return [pscustomobject]@{
    Pfx = $serverPfx
    Passphrase = $passwordPlain
    RootCertificate = $rootCer
  }
}

$env:BAILONGMA_HOST = '0.0.0.0'
$env:BAILONGMA_ALLOW_LAN = '1'
if (!$env:BAILONGMA_API_TOKEN) {
  $env:BAILONGMA_API_TOKEN = New-RandomBase64Url 32
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.PrefixOrigin -ne 'WellKnown' -and
    (Test-PrivateLanAddress $_.IPAddress)
  } |
  Select-Object -ExpandProperty IPAddress -Unique

if (!$addresses) {
  throw 'No private IPv4 LAN address was found.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tls = New-LanCertificates -LanDir (Join-Path $repoRoot 'data\lan-tls') -Addresses $addresses
$env:BAILONGMA_TLS_PFX = $tls.Pfx
$env:BAILONGMA_TLS_PFX_PASSPHRASE = $tls.Passphrase
$env:BAILONGMA_LAN_CA_CERT = $tls.RootCertificate

Write-Host ''
Write-Host 'Bailongma secure LAN mode is enabled.'
Write-Host ''
Write-Host 'First-time iPad setup:'
Write-Host '  1. Open the certificate URL below and install the downloaded profile.'
Write-Host '  2. In Settings > General > About > Certificate Trust Settings, enable full trust.'
Write-Host '  3. Open the matching Bailongma URL. The pairing token is removed from the address bar automatically.'
Write-Host ''
foreach ($address in $addresses) {
  Write-Host "Certificate: https://$address`:3721/bailongma-lan-root-ca.cer"
  Write-Host "Bailongma:   https://$address`:3721/#token=$($env:BAILONGMA_API_TOKEN)"
}
Write-Host ''
Write-Host "Root certificate file: $($tls.RootCertificate)"
Write-Host 'If the page does not open, allow Node/Electron through Windows Firewall for private networks.'
Write-Host ''

if ($Mode -eq 'backend') {
  node --env-file=.env src/index.js
} else {
  electron .
}
