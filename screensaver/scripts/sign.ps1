# BirdWatchAI Community Feed — Authenticode signing helper
#
# electron-builder signs the app executable itself (see electron-builder.config.js).
# This script is for the pieces it does not produce: the System32 launcher stub.
#
# Signing is opt-in through the environment. Set ONE of:
#
#   CSC_LINK + CSC_KEY_PASSWORD   path to a .pfx and its password
#   BWAI_CERT_SHA1                thumbprint of a cert in the Windows store
#   BWAI_CERT_SUBJECT             subject name of a cert in the Windows store
#
# With none set, this exits 0 without doing anything, so an unsigned build is
# a normal outcome rather than a failure.
#
#   powershell -ExecutionPolicy Bypass -File sign.ps1 "path\to\file.scr"

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

$ErrorActionPreference = 'Stop'

$certFile    = if ($env:CSC_LINK) { $env:CSC_LINK } else { $env:BWAI_CERT_FILE }
$certSha1    = $env:BWAI_CERT_SHA1
$certSubject = $env:BWAI_CERT_SUBJECT

if (-not $certFile -and -not $certSha1 -and -not $certSubject) {
    Write-Output "  No signing certificate configured - skipping (unsigned build)."
    exit 0
}

if (-not $Files -or $Files.Count -eq 0) {
    Write-Output "  Nothing to sign."
    exit 0
}

# signtool ships with the Windows SDK; take the newest one installed.
$signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" `
                          -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1

if (-not $signtool) {
    Write-Error "signtool.exe not found. Install the Windows SDK signing tools."
    exit 1
}

$timestamp = if ($env:BWAI_TIMESTAMP_URL) { $env:BWAI_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

$common = @('sign', '/fd', 'sha256', '/td', 'sha256', '/tr', $timestamp)

if ($certFile) {
    $common += @('/f', $certFile)
    if ($env:CSC_KEY_PASSWORD) { $common += @('/p', $env:CSC_KEY_PASSWORD) }
} elseif ($certSha1) {
    $common += @('/sha1', $certSha1)
} else {
    $common += @('/n', $certSubject)
}

foreach ($f in $Files) {
    if (-not (Test-Path $f)) {
        Write-Output "  Skipping missing file: $f"
        continue
    }
    Write-Output "  Signing $f"
    & $signtool.FullName @common $f
    if ($LASTEXITCODE -ne 0) {
        Write-Error "signtool failed for $f (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Write-Output "  Signing complete."
