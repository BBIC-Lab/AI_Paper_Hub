#requires -Version 5.1
<#
Synchronize public-safe changes from the primary public repo to the private
auxiliary repo only. This script never commits to origin; it only updates the
private remote after copying the allowed file set from origin/main.

Protected private/runtime paths are never copied from origin and never removed
from private:
- secret.private
- config.yaml and docs/config.yaml
- docs/README.md, which is the private runtime homepage
- docs/_sidebar.md; only the local PDF upload entry may be inserted
- dated generated docs: docs/YYYYMM/**
- local PDF runtime artifacts: docs/local-pdf/** and docs/assets/local_pdfs/**
- generated figures: docs/assets/figures/**
- archive/**
- runtime trash: trash/**
- .env files, logs, caches, .codex/**, TODO.md
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$OriginRemote = "origin",
  [string]$PrivateRemote = "private",
  [string]$Branch = "main",
  [string]$SyncBranch = "codex/private-sync",
  [string]$Worktree = (Join-Path $env:USERPROFILE ".codex\worktrees\AI_Daily_Paper_Reader_private_sync"),
  [string]$Message = "chore: sync private with origin main",
  [switch]$DryRun,
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

function Normalize-RepoPath {
  param([string]$PathText)
  $normalized = ($PathText -replace "\\", "/").Trim()
  while ($normalized.StartsWith("./")) {
    $normalized = $normalized.Substring(2)
  }
  return $normalized.TrimStart("/")
}

function Test-ProtectedPrivatePath {
  param([string]$RepoPath)
  $patterns = @(
    "^secret\.private$",
    "^config\.yaml$",
    "^docs/config\.yaml$",
    "^docs/README\.md$",
    "^docs/_sidebar\.md$",
    "^docs/\d{6}/",
    "^docs/local-pdf/",
    "^docs/assets/local_pdfs/",
    "^docs/assets/figures/",
    "^archive/",
    "^trash/",
    "^\.codex/",
    "^TODO\.md$",
    "^\.env($|\.)",
    "(^|/)\.env($|\.)",
    "\.log$",
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

function Ensure-LocalPdfSidebarEntry {
  param([string]$SidebarPath)
  if (-not (Test-Path $SidebarPath)) { return $false }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $text = [System.IO.File]::ReadAllText($SidebarPath, [System.Text.Encoding]::UTF8)
  if ($text -match 'href="#/local-pdf"') {
    return $false
  }

  $newline = "`n"
  if ($text.Contains("`r`n")) { $newline = "`r`n" }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($text -split "\r?\n", -1)) { $lines.Add($line) | Out-Null }
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
    $lines.RemoveAt($lines.Count - 1)
  }

  $rootLabel = [System.Text.Encoding]::UTF8.GetString([byte[]](0xE6,0x9C,0xAC,0xE5,0x9C,0xB0,0x20,0x50,0x44,0x46,0x20,0xE8,0xA7,0xA3,0xE6,0x9E,0x90))
  $uploadLabel = [System.Text.Encoding]::UTF8.GetString([byte[]](0xE4,0xB8,0x8A,0xE4,0xBC,0xA0,0xE8,0xA7,0xA3,0xE6,0x9E,0x90))
  $rootLine = "* $rootLabel"
  $uploadLine = "  * <a class=`"dpr-sidebar-brief-link`" href=`"#/local-pdf`">$uploadLabel</a>"
  $rootIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $rootLine -or $lines[$i].Contains('href="#/local-pdf"')) {
      $rootIdx = $i
      break
    }
  }

  if ($rootIdx -lt 0) {
    $dailyIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i].Trim() -eq "* Daily Papers") {
        $dailyIdx = $i
        break
      }
    }
    $insertAt = if ($dailyIdx -ge 0) { $dailyIdx } else { $lines.Count }
    $lines.Insert($insertAt, $rootLine)
    $lines.Insert($insertAt + 1, $uploadLine)
  } else {
    $lines[$rootIdx] = $rootLine
    $nextTop = $lines.Count
    for ($i = $rootIdx + 1; $i -lt $lines.Count; $i++) {
      if ($lines[$i].StartsWith("* ")) {
        $nextTop = $i
        break
      }
    }
    $hasUpload = $false
    for ($i = $rootIdx + 1; $i -lt $nextTop; $i++) {
      if ($lines[$i].Contains('href="#/local-pdf"')) {
        $hasUpload = $true
        break
      }
    }
    if (-not $hasUpload) {
      $lines.Insert($rootIdx + 1, $uploadLine)
    }
  }

  [System.IO.File]::WriteAllText($SidebarPath, (($lines -join $newline) + $newline), $utf8NoBom)
  return $true
}

function Test-PathExistsInGitRef {
  param([string]$GitRef, [string]$RepoPath, [string]$Cwd)
  $result = Invoke-GitRead -GitArgs @("cat-file", "-e", "${GitRef}:$RepoPath") -Cwd $Cwd -AllowFail
  return $result.Code -eq 0
}

$rootResult = Invoke-GitRead -GitArgs @("rev-parse", "--show-toplevel")
$Root = ($rootResult.Output | Select-Object -First 1).ToString().Trim()
if (-not $Root) { throw "Could not resolve repository root." }
Set-Location $Root

$OriginRef = "$OriginRemote/$Branch"
$PrivateRef = "$PrivateRemote/$Branch"

Write-Step "Repository"
Write-Host "Root: $Root"
Write-Host "Origin source: $OriginRef"
Write-Host "Private target: $PrivateRef"
Write-Host "Private worktree: $Worktree"
if ($DryRun) { Write-Host "Mode: dry-run (no worktree writes, commits, or pushes)" -ForegroundColor Yellow }

Invoke-GitRead -GitArgs @("remote", "get-url", $OriginRemote) -Cwd $Root | Out-Null
Invoke-GitRead -GitArgs @("remote", "get-url", $PrivateRemote) -Cwd $Root | Out-Null

Write-Step "Fetch remotes"
Invoke-GitRead -GitArgs @("fetch", $OriginRemote, $Branch) -Cwd $Root | Out-Null
Invoke-GitRead -GitArgs @("fetch", $PrivateRemote, $Branch) -Cwd $Root | Out-Null

$originSha = (Invoke-GitRead -GitArgs @("rev-parse", $OriginRef) -Cwd $Root).Output[0].Trim()
$privateSha = (Invoke-GitRead -GitArgs @("rev-parse", $PrivateRef) -Cwd $Root).Output[0].Trim()
Write-Host "Origin SHA:  $originSha"
Write-Host "Private SHA: $privateSha"

Write-Step "Select safe paths"
$changedFiles = @(
  (Invoke-GitRead -GitArgs @("-c", "core.quotePath=false", "diff", "--name-only", "$PrivateRef..$OriginRef") -Cwd $Root).Output |
    ForEach-Object { Normalize-RepoPath $_ } |
    Where-Object { $_ } |
    Select-Object -Unique
)

$safeFiles = New-Object System.Collections.Generic.List[string]
$protectedFiles = New-Object System.Collections.Generic.List[string]
foreach ($file in $changedFiles) {
  if (Test-ProtectedPrivatePath $file) {
    $protectedFiles.Add($file) | Out-Null
  } else {
    $safeFiles.Add($file) | Out-Null
  }
}

if ($safeFiles.Count -eq 0) {
  Write-Host "No public-safe paths to sync."
  if ($protectedFiles.Count -gt 0) {
    Write-Host "Skipped protected private/runtime paths:" -ForegroundColor Yellow
    $protectedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  }
  exit 0
}

Write-Host "Public-safe paths to sync:"
$safeFiles | ForEach-Object { Write-Host "  $_" }
if ($protectedFiles.Count -gt 0) {
  Write-Host "Skipped protected private/runtime paths:" -ForegroundColor Yellow
  $protectedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if ($DryRun) {
  Write-Host "[dry-run] Would copy safe paths from $OriginRef to a private worktree, commit, and push $PrivateRemote/$Branch." -ForegroundColor DarkGray
  exit 0
}

Write-Step "Prepare private worktree"
if (-not (Test-Path $Worktree)) {
  $parent = Split-Path -Parent $Worktree
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
  Invoke-GitWrite -GitArgs @("worktree", "add", "-B", $SyncBranch, $Worktree, $PrivateRef) -Cwd $Root
} else {
  Invoke-GitRead -GitArgs @("rev-parse", "--is-inside-work-tree") -Cwd $Worktree | Out-Null
  $dirty = (Invoke-GitRead -GitArgs @("status", "--porcelain") -Cwd $Worktree).Output
  if ($dirty.Count -gt 0) {
    throw "Private sync worktree is dirty: $Worktree"
  }
  Invoke-GitWrite -GitArgs @("fetch", $PrivateRemote, $Branch) -Cwd $Worktree
  Invoke-GitWrite -GitArgs @("switch", "-C", $SyncBranch, $PrivateRef) -Cwd $Worktree
}

Write-Step "Apply safe paths"
foreach ($file in $safeFiles) {
  if (Test-PathExistsInGitRef -GitRef $OriginRef -RepoPath $file -Cwd $Root) {
    Invoke-GitWrite -GitArgs @("checkout", $OriginRef, "--", $file) -Cwd $Worktree
  } else {
    Invoke-GitWrite -GitArgs @("rm", "-f", "--ignore-unmatch", "--", $file) -Cwd $Worktree
  }
}

# Preserve private runtime sidebar history while still surfacing the local PDF tool.
$privateSidebar = Join-Path $Worktree "docs\_sidebar.md"
if (Ensure-LocalPdfSidebarEntry -SidebarPath $privateSidebar) {
  Write-Host "Updated protected private sidebar with local PDF entry."
}

# Stage the whole disposable worktree so deletions from origin are captured too.
Invoke-GitWrite -GitArgs @("add", "-A", "--", ".") -Cwd $Worktree
$stagedFiles = @((Invoke-GitRead -GitArgs @("diff", "--cached", "--name-only") -Cwd $Worktree).Output | ForEach-Object { Normalize-RepoPath $_ })
foreach ($file in $stagedFiles) {
  if (Test-ProtectedPrivatePath $file) {
    throw "Refusing to stage protected private/runtime path: $file"
  }
}
if ($stagedFiles.Count -eq 0) {
  Write-Host "Private already matches origin for public-safe paths."
  exit 0
}

Write-Step "Validate staged sync"
Invoke-GitWrite -GitArgs @("diff", "--check", "--cached") -Cwd $Worktree

Write-Step "Commit private sync"
Invoke-GitWrite -GitArgs @("commit", "-m", $Message) -Cwd $Worktree
$syncCommit = (Invoke-GitRead -GitArgs @("rev-parse", "--short", "HEAD") -Cwd $Worktree).Output[0].Trim()
Write-Host "Private sync commit: $syncCommit"

if (-not $NoPush) {
  Write-Step "Push private"
  Invoke-GitWrite -GitArgs @("-c", "http.proxy=", "-c", "https.proxy=", "push", $PrivateRemote, "HEAD:$Branch") -Cwd $Worktree
} else {
  Write-Host "Private push skipped by -NoPush." -ForegroundColor Yellow
}

Write-Step "Done"
Write-Host "Origin:  $OriginRef @ $originSha"
Write-Host "Private: $PrivateRemote/$Branch @ $syncCommit"
