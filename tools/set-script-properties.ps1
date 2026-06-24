param(
  [string]$EnvPath = "C:\Users\gdeswardt1.cnslt\OneDrive - Aspen Global Inc\VS Code Projects\Budget Baker\.env",
  [switch]$UseClaspRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $true
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Env file not found: $EnvPath"
}

function Read-DotEnv([string]$Path) {
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }
  return $map
}

$envValues = Read-DotEnv -Path $EnvPath
$required = @('BBToken', 'WAToken', 'WAPhoneNumberID', 'ClaudeAPIKey', 'ClaudeAgentID', 'ClaudeEnvID', 'ClaudeVaultID')
$missing = @($required | Where-Object { -not $envValues.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($envValues[$_]) })
if ($missing.Count -gt 0) {
  throw "Missing required .env keys: $($missing -join ', ')"
}

$properties = [ordered]@{
  WALLET_API_TOKEN = $envValues['BBToken']
  WHATSAPP_ACCESS_TOKEN = $envValues['WAToken']
  WHATSAPP_PHONE_NUMBER_ID = $envValues['WAPhoneNumberID']
  CLAUDE_API_KEY = $envValues['ClaudeAPIKey']
  CLAUDE_AGENT_ID = $envValues['ClaudeAgentID']
  CLAUDE_ENV_ID = $envValues['ClaudeEnvID']
  CLAUDE_VAULT_IDS = $envValues['ClaudeVaultID']
}

if ($envValues.ContainsKey('ClaudeVaultCredentialID') -and -not [string]::IsNullOrWhiteSpace($envValues['ClaudeVaultCredentialID'])) {
  $properties['CLAUDE_VAULT_CREDENTIAL_ID'] = $envValues['ClaudeVaultCredentialID']
}

if (-not $UseClaspRun) {
  Write-Host "Validated .env keys. Secret values were not printed."
  Write-Host "Official Google path: Apps Script editor > Project Settings > Script Properties > Edit script properties."
  Write-Host "Set these script property keys from the matching .env values:"
  Write-Host "  WALLET_API_TOKEN              <= BBToken"
  Write-Host "  WHATSAPP_ACCESS_TOKEN         <= WAToken"
  Write-Host "  WHATSAPP_PHONE_NUMBER_ID      <= WAPhoneNumberID"
  Write-Host "  CLAUDE_API_KEY                <= ClaudeAPIKey"
  Write-Host "  CLAUDE_AGENT_ID               <= ClaudeAgentID"
  Write-Host "  CLAUDE_ENV_ID                 <= ClaudeEnvID"
  Write-Host "  CLAUDE_VAULT_IDS              <= ClaudeVaultID"
  if ($properties.Contains('CLAUDE_VAULT_CREDENTIAL_ID')) {
    Write-Host "  CLAUDE_VAULT_CREDENTIAL_ID    <= ClaudeVaultCredentialID"
  }
  Write-Host "After saving properties in Apps Script, run setup(), debugStatus(), and testWalletAuth() from the Apps Script editor."
  Write-Host "This script does not call clasp by default to avoid triggering blocked/broad OAuth flows."
  Write-Host "Only use -UseClaspRun after the Apps Script API executable and OAuth client are officially configured."
  return
}

$tempFile = Join-Path $env:TEMP ("wallet-budget-script-properties-{0}.json" -f ([guid]::NewGuid()))
try {
  $propertiesJson = $properties | ConvertTo-Json -Depth 3 -Compress
  @($propertiesJson) | ConvertTo-Json -Compress | Set-Content -LiteralPath $tempFile -Encoding UTF8
  npx --yes @google/clasp run setScriptPropertiesFromJson --params (Get-Content -LiteralPath $tempFile -Raw) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "clasp run setScriptPropertiesFromJson failed with exit code $LASTEXITCODE" }
  Write-Host "Script properties set: $($properties.Keys -join ', ')"
  Write-Host "Secret values were not printed."
}
finally {
  if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force }
}
