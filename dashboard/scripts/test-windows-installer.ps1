<#
.SYNOPSIS
    Functional tests for the generated Windows installer.

.DESCRIPTION
    Run by scripts/check-install-scripts.mjs when pwsh is available. Static
    checks catch typos; these catch behaviour.

    The installer no longer bootstraps a Python runtime -- the Windows agent is
    a single static Go binary -- so the old Python-detection tests are gone with
    the code they covered. What is left is the one piece of real logic in the
    script: the integrity check that decides whether the downloaded binary is
    allowed to run.

    Get-HmacSha256Hex must agree, byte for byte, with signBundleHash() in
    server/routes/bundle.js. If it ever drifts, every Windows install fails at
    the signature check with nothing to point at the cause. The expected value
    is therefore computed by Node, with the dashboard's own crypto call, and
    passed in rather than hardcoded here.

    Only the standalone helpers are exercised. The rest of the script drives
    Windows-only cmdlets (Get-Service, Unregister-ScheduledTask) that do not
    exist here.

.PARAMETER DefinitionsPath
    File holding the extracted function definitions.

.PARAMETER HmacValue
    Message to sign, as the installer would sign a SHA-256 hex digest.

.PARAMETER HmacSecret
    Key to sign with, standing in for the agent API token.

.PARAMETER ExpectedHmac
    The digest Node produced for that pair.
#>
param(
    [Parameter(Mandatory = $true)][string]$DefinitionsPath,
    [Parameter(Mandatory = $true)][string]$HmacValue,
    [Parameter(Mandatory = $true)][string]$HmacSecret,
    [Parameter(Mandatory = $true)][string]$ExpectedHmac
)

$ErrorActionPreference = 'Stop'
$failures = 0

function Assert-That([string]$Label, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        Write-Host "  OK   $Label"
    } else {
        Write-Host "  FAIL $Label$(if ($Detail) { " -- $Detail" })"
        $script:failures++
    }
}

. $DefinitionsPath

Write-Host 'Get-HmacSha256Hex'

$actual = Get-HmacSha256Hex -Value $HmacValue -Secret $HmacSecret
Assert-That 'agrees with the dashboard (bundle.js signBundleHash)' `
    ($actual -eq $ExpectedHmac) `
    "got $actual, expected $ExpectedHmac"

Assert-That 'returns lowercase hex without separators' `
    ($actual -cmatch '^[0-9a-f]{64}$') `
    "got $actual"

# A wrong token must not produce the expected digest: this is what stops a
# binary served by anything other than this dashboard from being installed.
$wrong = Get-HmacSha256Hex -Value $HmacValue -Secret 'not-the-agent-token'
Assert-That 'a different secret yields a different digest' ($wrong -ne $ExpectedHmac)

# The comparison in the installer is a plain string equality against a value
# lowercased from a response header, so casing must not vary.
$repeat = Get-HmacSha256Hex -Value $HmacValue -Secret $HmacSecret
Assert-That 'is deterministic' ($repeat -eq $actual)

Write-Host 'Test-IsElevated'

Assert-That 'is defined' ($null -ne (Get-Command Test-IsElevated -ErrorAction SilentlyContinue))

if ($IsWindows) {
    # It must return a usable boolean rather than, say, leak the output of an
    # external call -- the bug class that already shipped once in this script.
    $elevated = Test-IsElevated
    Assert-That 'returns a single boolean' `
        (($elevated -is [bool]) -and (@($elevated).Count -eq 1)) `
        "got type $($elevated.GetType().Name), count $(@($elevated).Count)"
} else {
    # WindowsIdentity::GetCurrent throws outside Windows, so the behaviour can
    # only be checked on the target platform.
    Write-Host '  SKIP returns a single boolean (Windows only)'
}

if ($failures -gt 0) {
    Write-Host ""
    Write-Host "$failures test(s) failed."
    exit 1
}
Write-Host ""
Write-Host 'test-windows-installer: OK'
