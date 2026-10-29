param(
    [string]$Url
)

$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'The .NET Framework C# compiler was not found on this Windows computer.'
}

$binDirectory = Join-Path $appRoot 'bin'
New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
$serverExecutable = Join-Path $binDirectory 'ExamServer.exe'
$serverSource = Join-Path $appRoot 'server\ExamServer.cs'
& $compiler /nologo /target:exe "/out:$serverExecutable" /r:System.Web.Extensions.dll $serverSource
if ($LASTEXITCODE -ne 0) {
    throw 'The exam server could not be compiled.'
}

$previousRoot = [Environment]::GetEnvironmentVariable('EXAM_APP_ROOT', 'Process')
$previousUrl = [Environment]::GetEnvironmentVariable('EXAM_URL', 'Process')
$previousPassword = [Environment]::GetEnvironmentVariable('EXAM_ADMIN_PASSWORD', 'Process')

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

$env:EXAM_APP_ROOT = $appRoot
if (-not [string]::IsNullOrWhiteSpace($Url)) {
    $env:EXAM_URL = $Url
}

try {
    & $serverExecutable
    if ($LASTEXITCODE -ne 0) {
        throw 'The exam server stopped with an error.'
    }
}
finally {
    if ($null -eq $previousRoot) { Remove-Item Env:EXAM_APP_ROOT -ErrorAction SilentlyContinue }
    else { $env:EXAM_APP_ROOT = $previousRoot }
    if ($null -eq $previousUrl) { Remove-Item Env:EXAM_URL -ErrorAction SilentlyContinue }
    else { $env:EXAM_URL = $previousUrl }
    if ($null -eq $previousPassword) { Remove-Item Env:EXAM_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
    else { $env:EXAM_ADMIN_PASSWORD = $previousPassword }
}
