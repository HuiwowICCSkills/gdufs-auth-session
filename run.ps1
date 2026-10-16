# Locate a Python that can run the GDUFS auth helper.
$gdufsCandidates = @(
    (Join-Path $PSScriptRoot 'venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\python\versions\3.13.12\python.exe')
)
$gdufsPathPython = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($gdufsPathPython) { $gdufsCandidates += $gdufsPathPython }

function Get-GdufsPythonScore {
    param([string]$Candidate)
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return 0 }
    & $Candidate -c 'import requests, lxml, Crypto' 2>$null
    if ($LASTEXITCODE -eq 0) { return 2 }
    & $Candidate -c 'import requests, lxml' 2>$null
    if ($LASTEXITCODE -eq 0) { return 1 }
    return 0
}

$gdufsPython = $null
$gdufsBestScore = 0
foreach ($gdufsCandidate in $gdufsCandidates) {
    $gdufsScore = Get-GdufsPythonScore $gdufsCandidate
    if ($gdufsScore -gt $gdufsBestScore) {
        $gdufsPython = $gdufsCandidate
        $gdufsBestScore = $gdufsScore
        if ($gdufsBestScore -eq 2) { break }
    }
}
if (-not $gdufsPython) {
    throw 'No Python with requests and lxml was found. Install requirements.txt or run scripts/setup-venvs.ps1.'
}
if ($gdufsBestScore -lt 2) {
    throw 'Selected Python lacks pycryptodome. Install requirements.txt for full functionality.'
}
$gdufsArguments = foreach ($gdufsArgument in $args) {
    if ($gdufsArgument -is [array]) { $gdufsArgument -join ',' } else { $gdufsArgument }
}
& $gdufsPython -X utf8 (Join-Path $PSScriptRoot 'scripts\gdufs_auth.py') $gdufsArguments
exit $LASTEXITCODE
