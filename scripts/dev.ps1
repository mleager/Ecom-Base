param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('init-env', 'database', 'migrate', 'status', 'generate', 'run', 'reconcile', 'fixtures', 'fixture-check', 'fixture-run', 'fixture-remove', 'test', 'integration', 'check')]
  [string]$Action,
  [switch]$Race,
  [switch]$Apply,
  [int]$Limit = 100,
  [string]$Fixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  if ($Race -and $Action -notin @('test', 'integration')) { throw '-Race is supported only for test and integration.' }
  if (($Apply -or $PSBoundParameters.ContainsKey('Limit')) -and $Action -ne 'reconcile') { throw '-Apply and -Limit are supported only for reconcile.' }
  $fixtureActions = @('fixture-check', 'fixture-run', 'fixture-remove')
  if ($Action -in $fixtureActions) {
    if ($Fixture -cnotmatch '^ecom_fixture_[a-f0-9]{16}$') { throw 'Provide -Fixture with an isolated fixture identifier.' }
  } elseif ($PSBoundParameters.ContainsKey('Fixture')) { throw '-Fixture is supported only for fixture-check/run/remove.' }
  $env:GOTOOLCHAIN = 'local'
  $env:GOCACHE = Join-Path $projectRoot '.cache/go-build'
  $envFile = Join-Path $projectRoot '.env'

  if ($Action -eq 'init-env') {
    if (Test-Path -LiteralPath $envFile) { throw '.env already exists; it will not be overwritten.' }
    $contents = [System.IO.File]::ReadAllText((Join-Path $projectRoot '.env.example'))
    foreach ($key in @('POSTGRES_PASSWORD', 'MIGRATOR_PASSWORD', 'APP_DB_PASSWORD', 'JWT_SECRET_BASE64')) {
      $randomBytes = New-Object byte[] 32
      $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
      $value = if ($key -eq 'JWT_SECRET_BASE64') { [Convert]::ToBase64String($randomBytes) } else { [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant() }
      $contents = [regex]::Replace($contents, "(?m)^$key=.*$", "$key=$value")
    }
    [System.IO.File]::WriteAllText($envFile, $contents, [System.Text.UTF8Encoding]::new($false))
    Write-Output 'Created ignored .env with independent random local secrets.'
    return
  }

  function Load-EnvironmentFile([string]$Path) {
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
      if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
      if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw 'Invalid .env entry: use plain KEY=value syntax.' }
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
  }
  if (Test-Path -LiteralPath $envFile) { Load-EnvironmentFile $envFile }

  function Require-Setting([string]$Name) {
    $setting = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrEmpty($setting)) { throw "Missing $Name; run init-env or provide an explicit process setting." }
    return $setting
  }

  function Database-URL([string]$User, [string]$Password) {
    $portValue = [Environment]::GetEnvironmentVariable('POSTGRES_PORT', 'Process')
    if ([string]::IsNullOrEmpty($portValue)) { $portValue = '5432' }
    $portNumber = 0
    if (-not [int]::TryParse($portValue, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) { throw 'POSTGRES_PORT must be 1-65535.' }
    return ('postgresql://{0}:{1}@127.0.0.1:{2}/ecom?sslmode=disable' -f $User, [Uri]::EscapeDataString($Password), $portNumber)
  }

  function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE." }
  }

  if ($Action -eq 'fixtures' -or $Action -in $fixtureActions) {
    $env:ECOM_TEST_ADMIN_URL = Database-URL 'postgres' (Require-Setting 'POSTGRES_PASSWORD')
    $env:ECOM_TEST_MIGRATOR_PASSWORD = Require-Setting 'MIGRATOR_PASSWORD'
    $env:ECOM_TEST_APP_PASSWORD = Require-Setting 'APP_DB_PASSWORD'
  }

  switch ($Action) {
    'init-env' { throw 'init-env must be handled before loading environment.' }
    'database' {
      $null = Require-Setting 'POSTGRES_PASSWORD'
      $null = Require-Setting 'MIGRATOR_PASSWORD'
      $null = Require-Setting 'APP_DB_PASSWORD'
      Invoke-Checked { docker compose --env-file $envFile -f compose.yaml up -d --wait --pull never postgres }
    }
    'migrate' {
      $env:GOOSE_DRIVER = 'postgres'
      $env:GOOSE_DBSTRING = Database-URL 'ecom_migrator' (Require-Setting 'MIGRATOR_PASSWORD')
      Invoke-Checked { goose -env=none -dir backend/migrations up }
    }
    'status' {
      $env:GOOSE_DRIVER = 'postgres'
      $env:GOOSE_DBSTRING = Database-URL 'ecom_migrator' (Require-Setting 'MIGRATOR_PASSWORD')
      Invoke-Checked { goose -env=none -dir backend/migrations status }
      Invoke-Checked { goose -env=none -dir backend/migrations version }
    }
    'generate' { Invoke-Checked { sqlc generate } }
    'run' {
      $env:DATABASE_URL = Database-URL 'ecom_app' (Require-Setting 'APP_DB_PASSWORD')
      Invoke-Checked { go run ./backend/cmd/api }
    }
    'reconcile' {
      $env:DATABASE_URL = Database-URL 'ecom_app' (Require-Setting 'APP_DB_PASSWORD')
      if ($Apply) { Invoke-Checked { go run ./backend/cmd/reconcile --apply --limit $Limit } }
      else { Invoke-Checked { go run ./backend/cmd/reconcile --dry-run --limit $Limit } }
    }
    'fixtures' { Invoke-Checked { go run ./backend/cmd/fixtures create } }
    'fixture-check' { Invoke-Checked { go run ./backend/cmd/fixtures check $Fixture } }
    'fixture-remove' { Invoke-Checked { go run ./backend/cmd/fixtures remove $Fixture } }
    'fixture-run' {
      Invoke-Checked { go run ./backend/cmd/fixtures check $Fixture }
      Load-EnvironmentFile (Join-Path $projectRoot ".cache/fixtures/$Fixture/api.env")
      Invoke-Checked { go run ./backend/cmd/api }
    }
    'test' {
      if ($Race) { Invoke-Checked { go test -race ./... } }
      else { Invoke-Checked { go test ./... } }
    }
    'integration' {
      $env:ECOM_TEST_ADMIN_URL = Database-URL 'postgres' (Require-Setting 'POSTGRES_PASSWORD')
      $env:ECOM_TEST_MIGRATOR_PASSWORD = Require-Setting 'MIGRATOR_PASSWORD'
      $env:ECOM_TEST_APP_PASSWORD = Require-Setting 'APP_DB_PASSWORD'
      if ($Race) { Invoke-Checked { go test -race -tags=integration -count=1 -v ./... } }
      else { Invoke-Checked { go test -tags=integration -count=1 ./... } }
    }
    'check' {
      $unformatted = @(gofmt -l backend fixtures)
      if ($LASTEXITCODE -ne 0 -or $unformatted.Count -ne 0) { throw 'Run gofmt on backend Go files.' }
      Invoke-Checked { sqlc vet }
      $beforeGeneration = @{}
      foreach ($file in Get-ChildItem -LiteralPath backend/internal/db/sqlc -Filter '*.go') {
        $beforeGeneration[$file.Name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
      }
      Invoke-Checked { sqlc generate }
      $generatedFiles = @(Get-ChildItem -LiteralPath backend/internal/db/sqlc -Filter '*.go')
      if ($generatedFiles.Count -ne $beforeGeneration.Count) { throw 'sqlc output changed; review and commit regenerated files.' }
      foreach ($file in $generatedFiles) {
        if (-not $beforeGeneration.ContainsKey($file.Name) -or $beforeGeneration[$file.Name] -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) {
          throw 'sqlc output changed; review and commit regenerated files.'
        }
      }
      Invoke-Checked { goose -env=none -dir backend/migrations validate }
      Invoke-Checked { go vet ./... }
      Invoke-Checked { go test ./... }
    }
  }
} finally { Pop-Location }

