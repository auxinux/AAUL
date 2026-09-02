<#
.SYNOPSIS
    Functional tests for the generated Windows installer.

.DESCRIPTION
    Run by scripts/check-install-scripts.mjs when pwsh is available. Static
    checks catch typos; these catch behaviour. Both bugs that reached production
    were behavioural:

      - Get-PythonCommand returned winget's install report instead of a path,
        because a PowerShell function returns everything written to the output
        stream, not just its `return`;
      - Python detection accepted the Microsoft Store alias, which is not an
        interpreter.

    Only the prerequisite functions are exercised. The rest of the script drives
    Windows-only cmdlets (Register-ScheduledTask, Get-CimInstance) that do not
    exist here.

.PARAMETER DefinitionsPath
    File holding the extracted function definitions.
#>
param([Parameter(Mandatory = $true)][string]$DefinitionsPath)

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

# A stand-in for winget that prints a verbose report, like the real one.
$fakeWinget = Join-Path ([System.IO.Path]::GetTempPath()) 'aaul-fake-winget'
@'
#!/bin/sh
echo "Found Python 3.12 [Python.Python.3.12] Version 3.12.10"
echo "Downloading https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
echo "Successfully installed C:\Program Files\Python312\python.exe"
exit 0
'@ | Set-Content -Path $fakeWinget -Encoding Ascii
if ($IsLinux -or $IsMacOS) { & chmod +x $fakeWinget }

function Get-Command {
    param([Parameter(Position = 0)]$Name, [Parameter(ValueFromRemainingArguments = $true)]$Rest)
    if ($Name -eq 'winget') { return [pscustomobject]@{ Source = $script:fakeWingetPath } }
    return $null
}
$script:fakeWingetPath = $fakeWinget

$realPython = if ($IsWindows) { (Get-Process -Id $PID).Path } else { '/usr/bin/python3' }

Write-Host 'Get-PythonCommand'

# 1. Python already present: returned as-is, and winget is never invoked.
function Find-Python { return $realPython }
$result = Get-PythonCommand
Assert-That 'retourne le chemin quand Python est deja present' (@($result).Count -eq 1 -and "$result" -eq $realPython) "obtenu: '$result'"

# 2. Python missing then installed: the value must be ONLY the path.
#    This is the regression that shipped — winget's report leaked into it.
$script:calls = 0
function Find-Python {
    $script:calls++
    if ($script:calls -eq 1) { return $null }
    return $realPython
}
$result = Get-PythonCommand
Assert-That 'la sortie de winget ne pollue pas la valeur de retour' (@($result).Count -eq 1) "elements: $(@($result).Count), premier: '$(@($result)[0])'"
Assert-That 'le chemin retourne est correct apres installation' ("$result" -eq $realPython) "obtenu: '$result'"

# 3. Still missing after install: must throw, not return something unusable.
function Find-Python { return $null }
$threw = $false
try { Get-PythonCommand | Out-Null } catch { $threw = $true }
Assert-That 'echoue clairement si Python reste introuvable' $threw

Write-Host 'Assert-PythonPath'
Assert-That 'accepte un fichier existant' ((Assert-PythonPath $realPython) -eq $realPython)
$invalidCases = @(
    @{ Label = 'null';                 Value = $null },
    @{ Label = 'chaine vide';          Value = '' },
    @{ Label = 'sortie de winget';     Value = 'Found Python 3.12 [Python.Python.3.12] Version 3.12.10' },
    @{ Label = 'chemin inexistant';    Value = '/no/such/interpreter' }
)
foreach ($case in $invalidCases) {
    $threw = $false
    try { Assert-PythonPath $case.Value | Out-Null } catch { $threw = $true }
    Assert-That "rejette une valeur invalide : $($case.Label)" $threw
}

Write-Host 'Test-PythonCandidate'
Assert-That 'accepte un interpreteur reel' (Test-PythonCandidate $realPython)
Assert-That 'rejette l alias du Microsoft Store' (-not (Test-PythonCandidate 'C:\Users\x\AppData\Local\Microsoft\WindowsApps\python.exe'))
Assert-That 'rejette un chemin vide' (-not (Test-PythonCandidate ''))
Assert-That 'rejette un binaire non-Python' (-not (Test-PythonCandidate '/bin/ls'))

Remove-Item $fakeWinget -Force -ErrorAction SilentlyContinue

if ($failures -gt 0) {
    Write-Host ''
    Write-Host "$failures test(s) en echec"
    exit 1
}
Write-Host ''
Write-Host 'Tous les tests PowerShell passent'
