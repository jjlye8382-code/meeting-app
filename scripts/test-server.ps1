$ErrorActionPreference = 'Stop'

# Load key if available
if (Test-Path 'API Key.txt') {
  $Env:OPENAI_API_KEY = Get-Content -Raw 'API Key.txt'
}

Write-Output "Starting server..."
$p = Start-Process node -ArgumentList 'server/server.js' -PassThru
Start-Sleep -Seconds 2

try {
  $root = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 5
  $status = $root.StatusCode
  $titleMatch = Select-String -InputObject $root.Content -Pattern '<title>(.*?)</title>'
  $title = if ($titleMatch.Matches.Count -gt 0) { $titleMatch.Matches[0].Groups[1].Value } else { '' }
  Write-Output ("STATUS: $status TITLE: $title")

  try {
    Invoke-WebRequest -Uri 'http://localhost:5173/api/transcribe' -UseBasicParsing -Method POST -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -ErrorAction Stop | Out-Null
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd(); $sr.Close()
      Write-Output ("TRANSCRIBE_STATUS: " + $resp.StatusCode)
      Write-Output ("TRANSCRIBE_BODY: " + $body)
    } else { Write-Output "TRANSCRIBE: no response" }
  }

  try {
    Invoke-WebRequest -Uri 'http://localhost:5173/api/summary-all' -UseBasicParsing -Method POST -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -ErrorAction Stop | Out-Null
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd(); $sr.Close()
      Write-Output ("SUMMARY_STATUS: " + $resp.StatusCode)
      Write-Output ("SUMMARY_BODY: " + $body)
    } else { Write-Output "SUMMARY: no response" }
  }
}
finally {
  if ($p -and !$p.HasExited) { Stop-Process -Id $p.Id -Force }
}

