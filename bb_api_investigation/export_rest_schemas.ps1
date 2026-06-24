$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\gdeswardt1.cnslt\Documents\wallet-budget-tracker-appsscript'
New-Item -ItemType Directory -Force -Path .\bb_api_investigation | Out-Null
$envPath = 'C:\Users\gdeswardt1.cnslt\OneDrive - Aspen Global Inc\VS Code Projects\Budget Baker\.env'
$token = ((Get-Content $envPath | Where-Object { $_ -match '^BBToken=' } | Select-Object -First 1) -replace '^BBToken=', '').Trim('"').Trim("'")
$base = 'https://rest.budgetbakers.com/wallet'
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }

function ConvertTo-RedactedJson($obj) {
  $json = $obj | ConvertTo-Json -Depth 100
  $json = $json -replace '(?i)"(token|access_token|authorization|password|secret|jwt|bbJwtToken)"\s*:\s*"[^"]*"', '"$1":"<redacted>"'
  return $json
}

function Get-ObjectPaths($obj, [string]$prefix = '') {
  $rows = New-Object System.Collections.ArrayList
  if ($null -eq $obj) { return $rows }

  if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string]) -and -not ($obj -is [pscustomobject])) {
    $arr = @($obj)
    [void]$rows.Add([pscustomobject]@{ Path = $prefix; Types = 'array'; Examples = "count=$($arr.Count)" })
    if ($arr.Count -gt 0) {
      foreach ($c in (Get-ObjectPaths $arr[0] ($prefix + '[]'))) { [void]$rows.Add($c) }
    }
    return $rows
  }

  foreach ($p in $obj.PSObject.Properties) {
    $path = if ($prefix) { "$prefix.$($p.Name)" } else { $p.Name }
    $v = $p.Value
    if ($null -eq $v) {
      [void]$rows.Add([pscustomobject]@{ Path = $path; Types = 'null'; Examples = '' })
    } elseif ($v -is [pscustomobject]) {
      foreach ($c in (Get-ObjectPaths $v $path)) { [void]$rows.Add($c) }
    } elseif ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
      $arr = @($v)
      [void]$rows.Add([pscustomobject]@{ Path = $path; Types = 'array'; Examples = "count=$($arr.Count)" })
      if ($arr.Count -gt 0) {
        foreach ($c in (Get-ObjectPaths $arr[0] ($path + '[]'))) { [void]$rows.Add($c) }
      }
    } else {
      $s = [string]$v
      [void]$rows.Add([pscustomobject]@{ Path = $path; Types = $v.GetType().Name; Examples = $s.Substring(0, [Math]::Min(120, $s.Length)) })
    }
  }
  return $rows
}

$endpoints = @(
  @{ Name = 'categories'; Path = '/v1/api/categories'; ArrayKey = 'categories' },
  @{ Name = 'accounts'; Path = '/v1/api/accounts'; ArrayKey = 'accounts' },
  @{ Name = 'records'; Path = '/v1/api/records?limit=200&offset=0'; ArrayKey = 'records' },
  @{ Name = 'budgets'; Path = '/v1/api/budgets'; ArrayKey = 'budgets' }
)

$summary = New-Object System.Collections.ArrayList
foreach ($ep in $endpoints) {
  try {
    $data = Invoke-RestMethod -Uri ($base + $ep.Path) -Headers $headers -Method Get -TimeoutSec 60
    ConvertTo-RedactedJson $data | Set-Content -Path (".\bb_api_investigation\rest_{0}_sample.json" -f $ep.Name) -Encoding UTF8
    $items = @($data.($ep.ArrayKey))
    $allPaths = @{}
    foreach ($item in ($items | Select-Object -First 50)) {
      foreach ($row in (Get-ObjectPaths $item)) {
        if (-not $allPaths.ContainsKey($row.Path)) {
          $allPaths[$row.Path] = [pscustomobject]@{ Path = $row.Path; Types = New-Object System.Collections.ArrayList; Examples = New-Object System.Collections.ArrayList }
        }
        if (-not $allPaths[$row.Path].Types.Contains($row.Types)) { [void]$allPaths[$row.Path].Types.Add($row.Types) }
        if ($row.Examples -and $allPaths[$row.Path].Examples.Count -lt 5 -and -not $allPaths[$row.Path].Examples.Contains($row.Examples)) { [void]$allPaths[$row.Path].Examples.Add($row.Examples) }
      }
    }
    $schema = $allPaths.Values | Sort-Object Path | ForEach-Object { [pscustomobject]@{ Path = $_.Path; Types = ($_.Types -join '|'); Examples = ($_.Examples -join ' || ') } }
    $schema | Export-Csv -Path (".\bb_api_investigation\rest_{0}_schema.csv" -f $ep.Name) -NoTypeInformation
    [void]$summary.Add([pscustomobject]@{ Name = $ep.Name; Status = 'OK'; TopLevelKeys = ($data.PSObject.Properties.Name -join ', '); ItemCount = $items.Count; SchemaFields = @($schema).Count })
  } catch {
    [void]$summary.Add([pscustomobject]@{ Name = $ep.Name; Status = 'ERR ' + $_.Exception.Message; TopLevelKeys = ''; ItemCount = 0; SchemaFields = 0 })
  }
}
$summary | Export-Csv .\bb_api_investigation\rest_summary.csv -NoTypeInformation
$summary | Format-Table -AutoSize
