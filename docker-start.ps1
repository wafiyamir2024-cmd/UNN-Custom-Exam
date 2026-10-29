param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [switch]$AllowNetwork
)

$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $compose = 'docker-compose'
}
elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $compose = 'docker'
}
else {
    throw 'Docker was not found. Install and start Docker Desktop first.'
}

$previousPassword = [Environment]::GetEnvironmentVariable('EXAM_ADMIN_PASSWORD', 'Process')
$previousPort = [Environment]::GetEnvironmentVariable('EXAM_PORT', 'Process')
$previousBind = [Environment]::GetEnvironmentVariable('EXAM_BIND_IP', 'Process')

if ([string]::IsNullOrEmpty($previousPassword)) {
    $securePassword = Read-Host 'Create an admin password (at least 12 characters)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plainPassword.Length -lt 12) {
            throw 'The admin password must contain at least 12 characters.'
        }
        $env:EXAM_ADMIN_PASSWORD = $plainPassword
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $plainPassword = $null
    }
}
elseif ($previousPassword.Length -lt 12) {
    throw 'EXAM_ADMIN_PASSWORD must contain at least 12 characters.'
}

$env:EXAM_PORT = [string]$Port
$env:EXAM_BIND_IP = if ($AllowNetwork) { '0.0.0.0' } else { '127.0.0.1' }

try {
    if ($compose -eq 'docker-compose') {
        & docker-compose -f $composeFile up --build -d
    }
    else {
        & docker compose -f $composeFile up --build -d
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker could not build or start the exam.'
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $state = Invoke-RestMethod "http://127.0.0.1:$Port/api/candidate/state" -TimeoutSec 2
            if ($state.exam) { $ready = $true; break }
        }
        catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) {
        throw 'The container started, but the exam site did not become ready. Check docker-compose logs.'
    }

    Write-Host "Applicant link: http://127.0.0.1:$Port/exam"
    Write-Host "Admin link:     http://127.0.0.1:$Port/admin"
    if ($AllowNetwork) {
        Write-Host 'Network access is enabled. Share the server computer address with applicants.'
    }
    Write-Host 'Stop the site from this folder with: docker-compose down'
}
finally {
    if ($null -eq $previousPassword) { Remove-Item Env:EXAM_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
    else { $env:EXAM_ADMIN_PASSWORD = $previousPassword }
    if ($null -eq $previousPort) { Remove-Item Env:EXAM_PORT -ErrorAction SilentlyContinue }
    else { $env:EXAM_PORT = $previousPort }
    if ($null -eq $previousBind) { Remove-Item Env:EXAM_BIND_IP -ErrorAction SilentlyContinue }
    else { $env:EXAM_BIND_IP = $previousBind }
}
