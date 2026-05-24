#requires -Version 5.1
<#
Publishes one scoped change to both repository roles:
1. Commit and push to the private remote (origin/main by default).
2. Re-apply the same commit on top of the public remote (public/main by default)
   from a disposable worktree, then push it.

The script is intentionally conservative:
- It never stages ignored/unrelated private runtime paths in auto mode.
- It aborts if the public worktree is dirty.
- It uses per-command proxy overrides for pushes.
- Use -DryRun to inspect the plan without staging, committing, or pushing.
- For multiple explicit paths, use PowerShell array syntax:
  -Paths README.md,scripts/publish-dual.ps1
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Message,

  [string]$PrivateRemote = "origin",
  [string]$PublicRemote = "public",
  [string]$Branch = "main",
  [string]$PublicBranch = "codex/public-sync",
  [string]$PublicWorktree = (Join-Path $env:USERPROFILE ".codex\worktrees\AI_Daily_Paper_Reader_public_sync"),

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths = @(),

  [switch]$DryRun,
  [switch]$SkipValidation,
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Text)
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Invoke-GitRead {
  param(
    [Parameter(Mandatory = $true)][string[]]$GitArgs,
    [string]$Cwd = (Get-Location).Path,
    [switch]$AllowFail
  )
  Push-Location $Cwd
  try {
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & git @GitArgs 2>&1
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $oldPreference
    }
    if ($code -ne 0 -and -not $AllowFail) {
      throw "git $($GitArgs -join ' ') failed with exit code ${code}: $($output -join [Environment]::NewLine)"
    }
    return [pscustomobject]@{ Code = $code; Output = @($output) }
  } finally {
    Pop-Location
  }
}

function Invoke-GitWrite {
  param(
    [Parameter(Mandatory = $true)][string[]]$GitArgs,
    [string]$Cwd = (Get-Location).Path
  )
  if ($DryRun) {
    Write-Host "[dry-run] git $($GitArgs -join ' ')" -ForegroundColor DarkGray
    return
  }
  $result = Invoke-GitRead -GitArgs $GitArgs -Cwd $Cwd
  if ($result.Output.Count -gt 0) {
    $result.Output | ForEach-Object { Write-Host $_ }
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Args,
    [string]$Cwd = (Get-Location).Path
  )
  Push-Location $Cwd
  try {
    Write-Host "+ $Exe $($Args -join ' ')" -ForegroundColor DarkGray
    & $Exe @Args
    if ($LASTEXITCODE -ne 0) {
      throw "$Exe $($Args -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Resolve-NodeExe {
  $bundled = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundled) { return $bundled }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Resolve-PythonExe {
  $bundled = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  if (Test-Path $bundled) { return $bundled }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Test-AnyPath {
  param([string[]]$Files, [string]$Pattern)
  foreach ($file in $Files) {
    if ($file -match $Pattern) { return $true }
  }
  return $false
}

function Invoke-Validation {
  param(
    [string]$Cwd,
    [string[]]$Files,
    [switch]$StagedDiff
  )
  if ($SkipValidation) {
    Write-Host "Validation skipped by -SkipValidation." -ForegroundColor Yellow
    return
  }

  Write-Step "Run validation"
  if ($StagedDiff) {
    Invoke-GitWrite -GitArgs @("diff", "--check", "--cached") -Cwd $Cwd
  } else {
    Invoke-GitWrite -GitArgs @("diff", "--check", "HEAD~1..HEAD") -Cwd $Cwd
  }

  $node = Resolve-NodeExe
  if ($node -and (Test-AnyPath -Files $Files -Pattern "^app/docsify-plugin\.js$")) {
    Invoke-External -Exe $node -Args @("--check", "app\docsify-plugin.js") -Cwd $Cwd
    if (Test-Path (Join-Path $Cwd "tests\test_docsify_markdown_math.js")) {
      Invoke-External -Exe $node -Args @("tests\test_docsify_markdown_math.js") -Cwd $Cwd
    }
  } elseif (Test-AnyPath -Files $Files -Pattern "^app/docsify-plugin\.js$") {
    Write-Host "WARN: node not found; skipped JS syntax check." -ForegroundColor Yellow
  }

  $needsGen6 = Test-AnyPath -Files $Files -Pattern "^(src/6\.generate_docs\.py|tests/test_generate_docs_meta_parse\.py)$"
  if ($needsGen6) {
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
      Write-Host "WARN: uv not found; skipped Python checks." -ForegroundColor Yellow
      return
    }
    Invoke-External -Exe $uv.Source -Args @("run", "--with", "requests", "--with", "pillow", "python", "-m", "py_compile", "src\6.generate_docs.py") -Cwd $Cwd
    Invoke-External -Exe $uv.Source -Args @(
      "run", "--with", "requests", "--with", "pillow", "python", "-m", "unittest",
      "tests.test_generate_docs_meta_parse.GenerateDocsMetaParseTest.test_update_sidebar_removes_initial_empty_daily_placeholder",
      "tests.test_generate_docs_meta_parse.GenerateDocsMetaParseTest.test_update_sidebar_handles_template_without_trailing_newline",
      "tests.test_generate_docs_meta_parse.GenerateDocsMetaParseTest.test_update_sidebar_repairs_existing_same_line_daily_item"
    ) -Cwd $Cwd
  }
}

function Invoke-PublicPrivacyGuard {
  param([string]$Cwd)
  $guard = Join-Path $Cwd "scripts\privacy_guard.py"
  if (-not (Test-Path $guard)) {
    Write-Host "WARN: scripts\privacy_guard.py not found; skipped public privacy guard." -ForegroundColor Yellow
    return
  }
  $python = Resolve-PythonExe
  if (-not $python) {
    Write-Host "WARN: python not found; skipped public privacy guard." -ForegroundColor Yellow
    return
  }
  Write-Step "Run public privacy guard"
  Invoke-External -Exe $python -Args @("scripts\privacy_guard.py") -Cwd $Cwd
}

function Normalize-RepoPath {
  param([string]$PathText)
  $normalized = ($PathText -replace "\\", "/").Trim()
  while ($normalized.StartsWith("./")) {
    $normalized = $normalized.Substring(2)
  }
  return $normalized.TrimStart("/")
}

function Is-HardDeniedPath {
  param([string]$RepoPath)
  $patterns = @(
    "^secret\.private$",
    "^archive/",
    "^\.env($|\.)",
    "(^|/)\.env($|\.)"
  )
  foreach ($pattern in $patterns) {
    if ($RepoPath -match $pattern) { return $true }
  }
  return $false
}

function Is-AutoExcludedPath {
  param([string]$RepoPath)
  $patterns = @(
    "^TODO\.md$",
    "^AGENTS\.md$",
    "^codex-httpserver\.(out|err)\.log$",
    "(^|/)__pycache__/",
    "(^|/)\.pytest_cache/",
    "(^|/)node_modules/",
    "(^|/)\.venv/",
    "(^|/)tmp/",
    "(^|/)temp/"
  )
  foreach ($pattern in $patterns) {
    if ($RepoPath -match $pattern) { return $true }
  }
  return $false
}

$rootResult = Invoke-GitRead -GitArgs @("rev-parse", "--show-toplevel")
$Root = ($rootResult.Output | Select-Object -First 1).ToString().Trim()
if (-not $Root) { throw "Could not resolve repository root." }
Set-Location $Root

$Paths = @(
  $Paths |
    ForEach-Object { [string]$_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)

Write-Step "Repository"
Write-Host "Root: $Root"
Write-Host "Private remote: $PrivateRemote/$Branch"
Write-Host "Public remote:  $PublicRemote/$Branch"
Write-Host "Public worktree: $PublicWorktree"
if ($DryRun) { Write-Host "Mode: dry-run (no staging, commits, worktree writes, or pushes)" -ForegroundColor Yellow }

$currentBranch = (Invoke-GitRead -GitArgs @("branch", "--show-current") -Cwd $Root).Output[0].Trim()
if ($currentBranch -ne $Branch) {
  throw "Current branch is '$currentBranch'; expected '$Branch'. Switch branches or pass -Branch."
}

Invoke-GitRead -GitArgs @("remote", "get-url", $PrivateRemote) -Cwd $Root | Out-Null
Invoke-GitRead -GitArgs @("remote", "get-url", $PublicRemote) -Cwd $Root | Out-Null

Write-Step "Refresh remotes"
Invoke-GitWrite -GitArgs @("fetch", $PrivateRemote, $Branch) -Cwd $Root
Invoke-GitWrite -GitArgs @("fetch", $PublicRemote, $Branch) -Cwd $Root

$trackedDirty = (Invoke-GitRead -GitArgs @("status", "--porcelain", "--untracked-files=no") -Cwd $Root).Output
$behindText = (Invoke-GitRead -GitArgs @("rev-list", "--count", "HEAD..$PrivateRemote/$Branch") -Cwd $Root).Output[0].Trim()
$behind = [int]$behindText
if ($behind -gt 0) {
  if ($trackedDirty.Count -gt 0) {
    throw "Local $Branch is behind $PrivateRemote/$Branch and has tracked changes. Commit/stash or pull before publishing."
  }
  Write-Step "Fast-forward private branch"
  Invoke-GitWrite -GitArgs @("pull", "--ff-only", $PrivateRemote, $Branch) -Cwd $Root
}

Write-Step "Select files"
$explicitPaths = $Paths.Count -gt 0
if ($explicitPaths) {
  $candidateFiles = $Paths | ForEach-Object { Normalize-RepoPath $_ }
} else {
  $candidateFiles = @()
  $candidateFiles += (Invoke-GitRead -GitArgs @("diff", "--name-only") -Cwd $Root).Output
  $candidateFiles += (Invoke-GitRead -GitArgs @("diff", "--cached", "--name-only") -Cwd $Root).Output
  $candidateFiles += (Invoke-GitRead -GitArgs @("ls-files", "--others", "--exclude-standard") -Cwd $Root).Output
  $candidateFiles = $candidateFiles | ForEach-Object { Normalize-RepoPath $_ } | Where-Object { $_ } | Select-Object -Unique
}

$publishFiles = New-Object System.Collections.Generic.List[string]
$excludedFiles = New-Object System.Collections.Generic.List[string]
foreach ($file in $candidateFiles) {
  if (Is-HardDeniedPath $file) {
    throw "Refusing to publish private/sensitive path: $file"
  }
  if ((-not $explicitPaths) -and (Is-AutoExcludedPath $file)) {
    $excludedFiles.Add($file) | Out-Null
    continue
  }
  $publishFiles.Add($file) | Out-Null
}

if ($publishFiles.Count -eq 0) {
  Write-Host "No publishable files found."
  if ($excludedFiles.Count -gt 0) {
    Write-Host "Excluded files:" -ForegroundColor Yellow
    $excludedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  }
  exit 0
}

Write-Host "Files to publish:"
$publishFiles | ForEach-Object { Write-Host "  $_" }
if ($excludedFiles.Count -gt 0) {
  Write-Host "Excluded from auto mode:" -ForegroundColor Yellow
  $excludedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if ($DryRun) {
  Write-Host "[dry-run] Would stage, validate, commit, push private, cherry-pick to public worktree, validate, and push public." -ForegroundColor DarkGray
  exit 0
}

Write-Step "Stage private commit"
Invoke-GitWrite -GitArgs (@("add", "--") + [string[]]$publishFiles) -Cwd $Root
$stagedFiles = (Invoke-GitRead -GitArgs @("diff", "--cached", "--name-only") -Cwd $Root).Output
if ($stagedFiles.Count -eq 0) { throw "No staged changes after git add." }

Invoke-Validation -Cwd $Root -Files ([string[]]$publishFiles) -StagedDiff

Write-Step "Commit private"
Invoke-GitWrite -GitArgs @("commit", "-m", $Message) -Cwd $Root
$privateCommit = (Invoke-GitRead -GitArgs @("rev-parse", "--short", "HEAD") -Cwd $Root).Output[0].Trim()
$privateCommitFull = (Invoke-GitRead -GitArgs @("rev-parse", "HEAD") -Cwd $Root).Output[0].Trim()
Write-Host "Private commit: $privateCommit"

if (-not $NoPush) {
  Write-Step "Push private"
  Invoke-GitWrite -GitArgs @("-c", "http.proxy=", "-c", "https.proxy=", "push", $PrivateRemote, $Branch) -Cwd $Root
} else {
  Write-Host "Private push skipped by -NoPush." -ForegroundColor Yellow
}

Write-Step "Prepare public worktree"
if (-not (Test-Path $PublicWorktree)) {
  $parent = Split-Path -Parent $PublicWorktree
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
  Invoke-GitWrite -GitArgs @("worktree", "add", "-B", $PublicBranch, $PublicWorktree, "$PublicRemote/$Branch") -Cwd $Root
} else {
  Invoke-GitRead -GitArgs @("rev-parse", "--is-inside-work-tree") -Cwd $PublicWorktree | Out-Null
  $publicDirty = (Invoke-GitRead -GitArgs @("status", "--porcelain") -Cwd $PublicWorktree).Output
  if ($publicDirty.Count -gt 0) {
    throw "Public worktree is dirty: $PublicWorktree"
  }
  Invoke-GitWrite -GitArgs @("fetch", $PublicRemote, $Branch) -Cwd $PublicWorktree
  Invoke-GitWrite -GitArgs @("switch", "-C", $PublicBranch, "$PublicRemote/$Branch") -Cwd $PublicWorktree
}

Write-Step "Apply commit to public"
Invoke-GitWrite -GitArgs @("cherry-pick", $privateCommitFull) -Cwd $PublicWorktree
$publicCommit = (Invoke-GitRead -GitArgs @("rev-parse", "--short", "HEAD") -Cwd $PublicWorktree).Output[0].Trim()
Write-Host "Public commit: $publicCommit"

Invoke-Validation -Cwd $PublicWorktree -Files ([string[]]$publishFiles)
Invoke-PublicPrivacyGuard -Cwd $PublicWorktree

if (-not $NoPush) {
  Write-Step "Push public"
  Invoke-GitWrite -GitArgs @("-c", "http.proxy=", "-c", "https.proxy=", "push", $PublicRemote, "HEAD:$Branch") -Cwd $PublicWorktree
} else {
  Write-Host "Public push skipped by -NoPush." -ForegroundColor Yellow
}

Write-Step "Done"
Write-Host "Private: $PrivateRemote/$Branch @ $privateCommit"
Write-Host "Public:  $PublicRemote/$Branch @ $publicCommit"
