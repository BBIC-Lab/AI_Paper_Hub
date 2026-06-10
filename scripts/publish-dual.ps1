#requires -Version 5.1
<#
Commits one scoped public-safe change to the primary repo, then runs
the origin-to-private sync script.

The script is intentionally conservative:
- It commits and pushes only to the primary public remote first (origin/main by default).
- It runs the privacy guard before the primary public commit is created.
- It delegates private updates to scripts/sync-origin-to-private.ps1, which
  preserves private/runtime paths.
- It uses per-command proxy overrides for pushes.
- Use -UseApiPushFallback to recover from GitHub HTTPS push resets after fast-forward checks.
- Use -DryRun to inspect the plan without staging, committing, or pushing.
- For multiple explicit paths, use PowerShell array syntax:
  -Paths scripts/publish-dual.ps1,app/app.css
#>

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)]
  [string]$Message,

  [string]$PrimaryRemote = "origin",
  [string]$PrivateSyncRemote = "private",
  [string]$Branch = "main",
  [string]$PrivateSyncBranch = "codex/private-sync",
  [string]$PrivateSyncWorktree = (Join-Path $env:USERPROFILE ".codex\worktrees\AI_Daily_Paper_Reader_private_sync"),

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths = @(),

  [switch]$DryRun,
  [switch]$SkipValidation,
  [switch]$NoPush,
  [switch]$UseApiPushFallback
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

function Quote-ProcessArgument {
  param([string]$Text)
  if ($Text -eq "") { return '""' }
  if ($Text -notmatch '[\s"]') { return $Text }
  return '"' + ($Text -replace '"', '\"') + '"'
}

function Invoke-GitBytes {
  param(
    [Parameter(Mandatory = $true)][string[]]$GitArgs,
    [string]$Cwd = (Get-Location).Path
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "git"
  $startInfo.Arguments = (($GitArgs | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
  $startInfo.WorkingDirectory = $Cwd
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdout = New-Object System.IO.MemoryStream
  $process.StandardOutput.BaseStream.CopyTo($stdout)
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "git $($GitArgs -join ' ') failed with exit code $($process.ExitCode): $stderr"
  }
  return ,([byte[]]$stdout.ToArray())
}

function Get-GitHubHeaders {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    throw "GitHub API fallback requires GitHub CLI (`gh`) for auth token lookup."
  }
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $tokenOutput = & $gh.Source auth token 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($code -ne 0) {
    throw "gh auth token failed with exit code ${code}: $($tokenOutput -join [Environment]::NewLine)"
  }
  $token = ($tokenOutput | Select-Object -First 1).ToString().Trim()
  if (-not $token) { throw "gh auth token returned an empty token." }
  return @{
    Authorization = "Bearer $token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "publish-dual.ps1"
  }
}

function Invoke-GitHubJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [hashtable]$Body = $null
  )
  if ($Body) {
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body $json -ContentType "application/json" -TimeoutSec 60
  }
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec 60
}

function Resolve-GitHubRepoSlug {
  param([string]$Remote, [string]$Cwd)
  $remoteUrl = (Invoke-GitRead -GitArgs @("remote", "get-url", $Remote) -Cwd $Cwd).Output[0].ToString().Trim()
  if ($remoteUrl -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/]+?)(?:\.git)?/?$") {
    return "$($Matches.owner)/$($Matches.repo)"
  }
  throw "Cannot derive GitHub owner/repo from remote '$Remote': $remoteUrl"
}

function Get-CommitMessageExact {
  param([string]$CommitSha, [string]$Cwd)
  $bytes = Invoke-GitBytes -GitArgs @("cat-file", "commit", $CommitSha) -Cwd $Cwd
  $start = -1
  for ($i = 0; $i -lt ($bytes.Length - 1); $i++) {
    if ($bytes[$i] -eq 10 -and $bytes[$i + 1] -eq 10) {
      $start = $i + 2
      break
    }
  }
  if ($start -lt 0) { throw "Could not find commit message boundary for $CommitSha" }
  $messageBytes = New-Object byte[] ($bytes.Length - $start)
  [Array]::Copy($bytes, $start, $messageBytes, 0, $messageBytes.Length)
  return [System.Text.Encoding]::UTF8.GetString($messageBytes)
}

function Get-CommitMetadata {
  param([string]$CommitSha, [string]$Cwd)
  $raw = (Invoke-GitRead -GitArgs @("show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", $CommitSha) -Cwd $Cwd).Output -join "`n"
  $parts = $raw.Split([char]0)
  if ($parts.Count -lt 6) { throw "Could not parse commit metadata for $CommitSha" }
  return @{
    Message = Get-CommitMessageExact -CommitSha $CommitSha -Cwd $Cwd
    Author = @{ name = $parts[0]; email = $parts[1]; date = $parts[2] }
    Committer = @{ name = $parts[3]; email = $parts[4]; date = $parts[5] }
  }
}

function New-GitHubBlobFromCommitPath {
  param(
    [string]$RepoSlug,
    [string]$CommitSha,
    [string]$RepoPath,
    [hashtable]$Headers,
    [string]$Cwd
  )
  $bytes = Invoke-GitBytes -GitArgs @("cat-file", "blob", "${CommitSha}:$RepoPath") -Cwd $Cwd
  $blob = Invoke-GitHubJson -Method "Post" -Uri "https://api.github.com/repos/$RepoSlug/git/blobs" -Headers $Headers -Body @{
    content = [Convert]::ToBase64String($bytes)
    encoding = "base64"
  }
  return $blob.sha
}

function Ensure-GitHubCommitObject {
  param(
    [string]$RepoSlug,
    [string]$RemoteSha,
    [string]$CommitSha,
    [hashtable]$Headers,
    [string]$Cwd
  )
  $parents = @(((Invoke-GitRead -GitArgs @("rev-list", "--parents", "-n", "1", $CommitSha) -Cwd $Cwd).Output[0] -split " ") | Select-Object -Skip 1)
  if ($parents.Count -ne 1 -or $parents[0] -ne $RemoteSha) {
    throw "API fallback only supports single-parent commits; $CommitSha is not based on $RemoteSha."
  }

  $baseTree = (Invoke-GitRead -GitArgs @("rev-parse", "$RemoteSha^{tree}") -Cwd $Cwd).Output[0].Trim()
  $treeItems = New-Object System.Collections.Generic.List[object]
  $changes = (Invoke-GitRead -GitArgs @("diff", "--name-status", "--no-renames", "$RemoteSha..$CommitSha") -Cwd $Cwd).Output
  foreach ($change in $changes) {
    if (-not $change) { continue }
    $columns = $change -split "`t"
    $status = $columns[0]
    $repoPath = $columns[1]
    if ($status -eq "D") {
      $treeItems.Add(@{ path = $repoPath; sha = $null }) | Out-Null
      continue
    }
    $lsTree = (Invoke-GitRead -GitArgs @("ls-tree", $CommitSha, "--", $repoPath) -Cwd $Cwd).Output[0]
    if ($lsTree -notmatch "^(?<mode>\d+)\s+(?<type>\S+)\s+(?<sha>[0-9a-f]{40})\t") {
      throw "Could not parse tree entry for $repoPath at $CommitSha"
    }
    $blobSha = New-GitHubBlobFromCommitPath -RepoSlug $RepoSlug -CommitSha $CommitSha -RepoPath $repoPath -Headers $Headers -Cwd $Cwd
    if ($blobSha -ne $Matches.sha) {
      throw "Uploaded blob SHA mismatch for ${repoPath}: expected $($Matches.sha), got $blobSha"
    }
    $treeItems.Add(@{
      path = $repoPath
      mode = $Matches.mode
      type = $Matches.type
      sha = $blobSha
    }) | Out-Null
  }

  $tree = Invoke-GitHubJson -Method "Post" -Uri "https://api.github.com/repos/$RepoSlug/git/trees" -Headers $Headers -Body @{
    base_tree = $baseTree
    tree = @($treeItems)
  }
  $localTree = (Invoke-GitRead -GitArgs @("rev-parse", "$CommitSha^{tree}") -Cwd $Cwd).Output[0].Trim()
  if ($tree.sha -ne $localTree) {
    throw "API fallback tree mismatch: expected $localTree, got $($tree.sha)"
  }

  $metadata = Get-CommitMetadata -CommitSha $CommitSha -Cwd $Cwd
  $commit = Invoke-GitHubJson -Method "Post" -Uri "https://api.github.com/repos/$RepoSlug/git/commits" -Headers $Headers -Body @{
    message = $metadata.Message
    tree = $tree.sha
    parents = @($RemoteSha)
    author = $metadata.Author
    committer = $metadata.Committer
  }
  if ($commit.sha -ne $CommitSha) {
    throw "API fallback commit mismatch: expected $CommitSha, got $($commit.sha)"
  }
}

function Invoke-GitHubApiPushFallback {
  param(
    [string]$Remote,
    [string]$Branch,
    [string]$Cwd
  )
  Write-Step "GitHub API push fallback"
  Invoke-GitWrite -GitArgs @("fetch", $Remote, $Branch) -Cwd $Cwd
  $remoteSha = (Invoke-GitRead -GitArgs @("rev-parse", "$Remote/$Branch") -Cwd $Cwd).Output[0].Trim()
  $localSha = (Invoke-GitRead -GitArgs @("rev-parse", "HEAD") -Cwd $Cwd).Output[0].Trim()
  $fastForward = Invoke-GitRead -GitArgs @("merge-base", "--is-ancestor", $remoteSha, $localSha) -Cwd $Cwd -AllowFail
  if ($fastForward.Code -ne 0) {
    throw "Refusing API fallback because $Remote/$Branch is not an ancestor of HEAD."
  }

  $repoSlug = Resolve-GitHubRepoSlug -Remote $Remote -Cwd $Cwd
  $headers = Get-GitHubHeaders
  $commits = @((Invoke-GitRead -GitArgs @("rev-list", "--reverse", "$remoteSha..$localSha") -Cwd $Cwd).Output | Where-Object { $_ })
  foreach ($commitToCreate in $commits) {
    $parentSha = @(((Invoke-GitRead -GitArgs @("rev-list", "--parents", "-n", "1", $commitToCreate) -Cwd $Cwd).Output[0] -split " ") | Select-Object -Skip 1)[0]
    Ensure-GitHubCommitObject -RepoSlug $repoSlug -RemoteSha $parentSha -CommitSha $commitToCreate -Headers $headers -Cwd $Cwd
  }
  $update = Invoke-GitHubJson -Method "Patch" -Uri "https://api.github.com/repos/$repoSlug/git/refs/heads/$Branch" -Headers $headers -Body @{
    sha = $localSha
    force = $false
  }
  if ($update.object.sha -ne $localSha) {
    throw "API fallback updated $Remote/$Branch to $($update.object.sha), expected $localSha"
  }
  Write-Host "API fallback updated $Remote/$Branch to $($localSha.Substring(0, 7))"
}

function Invoke-GitPush {
  param(
    [string]$Remote,
    [string]$Branch,
    [string]$RefSpec,
    [string]$Cwd
  )
  try {
    Invoke-GitWrite -GitArgs @("-c", "http.proxy=", "-c", "https.proxy=", "push", $Remote, $RefSpec) -Cwd $Cwd
  } catch {
    if (-not $UseApiPushFallback) { throw }
    Write-Host "WARN: git push failed; trying fast-forward GitHub API fallback." -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    Invoke-GitHubApiPushFallback -Remote $Remote -Branch $Branch -Cwd $Cwd
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

function Invoke-PrimaryPrivacyGuard {
  param([string]$Cwd)
  $guard = Join-Path $Cwd "scripts\privacy_guard.py"
  if (-not (Test-Path $guard)) {
    Write-Host "WARN: scripts\privacy_guard.py not found; skipped primary privacy guard." -ForegroundColor Yellow
    return
  }
  $python = Resolve-PythonExe
  if (-not $python) {
    Write-Host "WARN: python not found; skipped primary privacy guard." -ForegroundColor Yellow
    return
  }
  Write-Step "Run primary privacy guard"
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
    "^config\.yaml$",
    "^docs/config\.yaml$",
    "^docs/\d{6}/",
    "^docs/reports/",
    "^docs/reader-db/",
    "^docs/assets/figures/",
    "^archive/",
    "^\.codex/",
    "^TODO\.md$",
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
    "^docs/reports/",
    "^docs/reader-db/",
    "^docs/config\.yaml$",
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
Write-Host "Primary remote: $PrimaryRemote/$Branch"
Write-Host "Private sync remote:  $PrivateSyncRemote/$Branch"
Write-Host "Private sync worktree: $PrivateSyncWorktree"
if ($DryRun) { Write-Host "Mode: dry-run (no staging, commits, worktree writes, or pushes)" -ForegroundColor Yellow }
if ($UseApiPushFallback) { Write-Host "GitHub API push fallback: enabled" -ForegroundColor Yellow }

$currentBranch = (Invoke-GitRead -GitArgs @("branch", "--show-current") -Cwd $Root).Output[0].Trim()
if ($currentBranch -ne $Branch) {
  throw "Current branch is '$currentBranch'; expected '$Branch'. Switch branches or pass -Branch."
}

Invoke-GitRead -GitArgs @("remote", "get-url", $PrimaryRemote) -Cwd $Root | Out-Null
Invoke-GitRead -GitArgs @("remote", "get-url", $PrivateSyncRemote) -Cwd $Root | Out-Null

Write-Step "Refresh remotes"
Invoke-GitWrite -GitArgs @("fetch", $PrimaryRemote, $Branch) -Cwd $Root
Invoke-GitWrite -GitArgs @("fetch", $PrivateSyncRemote, $Branch) -Cwd $Root

$trackedDirty = (Invoke-GitRead -GitArgs @("status", "--porcelain", "--untracked-files=no") -Cwd $Root).Output
$behindText = (Invoke-GitRead -GitArgs @("rev-list", "--count", "HEAD..$PrimaryRemote/$Branch") -Cwd $Root).Output[0].Trim()
$behind = [int]$behindText
if ($behind -gt 0) {
  if ($trackedDirty.Count -gt 0) {
    throw "Local $Branch is behind $PrimaryRemote/$Branch and has tracked changes. Commit/stash or pull before publishing."
  }
  Write-Step "Fast-forward primary branch"
  Invoke-GitWrite -GitArgs @("pull", "--ff-only", $PrimaryRemote, $Branch) -Cwd $Root
}
$primaryBaseForSync = (Invoke-GitRead -GitArgs @("rev-parse", "$PrimaryRemote/$Branch") -Cwd $Root).Output[0].Trim()

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
  if ((-not $explicitPaths) -and (Is-AutoExcludedPath $file)) {
    $excludedFiles.Add($file) | Out-Null
    continue
  }
  if (Is-HardDeniedPath $file) {
    throw "Refusing to publish private/sensitive path: $file"
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
  Write-Host "Excluded from publish scope:" -ForegroundColor Yellow
  $excludedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if ($DryRun) {
  Write-Host "[dry-run] Would stage, validate, privacy-check, commit, push primary, then run sync-origin-to-private.ps1." -ForegroundColor DarkGray
  exit 0
}

Write-Step "Stage primary commit"
Invoke-GitWrite -GitArgs (@("add", "--") + [string[]]$publishFiles) -Cwd $Root
$stagedFiles = (Invoke-GitRead -GitArgs @("diff", "--cached", "--name-only") -Cwd $Root).Output
if ($stagedFiles.Count -eq 0) { throw "No staged changes after git add." }

Invoke-Validation -Cwd $Root -Files ([string[]]$publishFiles) -StagedDiff
Invoke-PrimaryPrivacyGuard -Cwd $Root

Write-Step "Commit primary"
Invoke-GitWrite -GitArgs @("commit", "-m", $Message) -Cwd $Root
$primaryCommit = (Invoke-GitRead -GitArgs @("rev-parse", "--short", "HEAD") -Cwd $Root).Output[0].Trim()
$primaryCommitFull = (Invoke-GitRead -GitArgs @("rev-parse", "HEAD") -Cwd $Root).Output[0].Trim()
Write-Host "Primary commit: $primaryCommit"

if (-not $NoPush) {
  Write-Step "Push primary"
  Invoke-GitPush -Remote $PrimaryRemote -Branch $Branch -RefSpec $Branch -Cwd $Root
} else {
  Write-Host "Primary push skipped by -NoPush." -ForegroundColor Yellow
}

if (-not $NoPush) {
  Write-Step "Sync private from origin"
  $syncScript = Join-Path $Root "scripts\sync-origin-to-private.ps1"
  if (-not (Test-Path $syncScript)) {
    throw "Missing sync script: $syncScript"
  }
  Invoke-External -Exe "powershell" -Args @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $syncScript,
    "-OriginRemote", $PrimaryRemote,
    "-PrivateRemote", $PrivateSyncRemote,
    "-Branch", $Branch,
    "-SyncBranch", $PrivateSyncBranch,
    "-Worktree", $PrivateSyncWorktree,
    "-Message", "chore: sync private with origin main"
  ) -Cwd $Root
} else {
  Write-Host "Private sync skipped by -NoPush." -ForegroundColor Yellow
}

Write-Step "Done"
Write-Host "Primary: $PrimaryRemote/$Branch @ $primaryCommit"
Write-Host "Private sync: run scripts/sync-origin-to-private.ps1 for $PrivateSyncRemote/$Branch"
