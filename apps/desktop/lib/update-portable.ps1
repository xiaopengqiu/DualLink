param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = $null
$backupMade = $false
$newPlaced = $false

function Full([string]$Value) {
  if (-not [System.IO.Path]::IsPathRooted($Value)) { throw 'An absolute path is required.' }
  return [System.IO.Path]::GetFullPath($Value)
}
function Same([string]$Left,[string]$Right) { return [string]::Equals($Left,$Right,[StringComparison]::OrdinalIgnoreCase) }
function Child([string]$File,[string]$Directory) {
  $prefix = $Directory.TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
  return $File.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
}
function TargetChild([string]$File) {
  $absolute = Full $File
  if (-not (Same ([System.IO.Path]::GetDirectoryName($absolute)) $script:targetDir)) { throw 'Target path escaped the application directory.' }
  return $absolute
}
function WriteState([string]$Phase,[string]$Message) {
  if ($null -eq $script:config -or -not $script:statusPath) { return }
  @{phase=$Phase;message=$Message;updatedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:statusPath -Encoding UTF8
}
function CheckHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($actual -ne $script:config.sha256) { throw 'Update checksum verification failed.' }
}
function RetryMove([string]$Source,[string]$Destination) {
  $from = TargetChild $Source
  $to = TargetChild $Destination
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return }
    catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 300 }
  } while ($true)
}
function ApplicationAlive {
  try { $application = [Diagnostics.Process]::GetProcessById([int]$script:config.appPid) }
  catch [ArgumentException] { return $false }
  try { return -not $application.HasExited }
  finally { $application.Dispose() }
}

try {
  $configFile = Full $ConfigPath
  $configDirectory = [System.IO.Path]::GetDirectoryName($configFile)
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.schema -ne 1 -or $config.sha256 -notmatch '^[a-f0-9]{64}$' -or $config.appPid -le 0) { throw 'Invalid update configuration.' }
  $cacheDir = Full $config.cacheDir
  $source = Full $config.source
  $targetDir = Full $config.targetDir
  if (-not (Same ((Resolve-Path -LiteralPath $targetDir).ProviderPath) $targetDir)) { throw 'Target directory changed.' }
  if (-not (Child $configFile $cacheDir) -or -not (Child $source $cacheDir)) { throw 'Update source escaped the cache directory.' }
  $target = TargetChild $config.target
  $staged = TargetChild $config.staged
  $backup = TargetChild $config.backup
  if ((Child $target $cacheDir) -or (Same $target $source) -or (Same $target $staged) -or (Same $target $backup) -or (Same $staged $backup)) { throw 'Invalid portable target paths.' }
  $readyPath = Full $config.readyPath
  $statusPath = Full $config.statusPath
  $cancelPath = Full $config.cancelPath
  if (-not (Same ([System.IO.Path]::GetDirectoryName($readyPath)) $configDirectory) -or -not (Same ([System.IO.Path]::GetDirectoryName($statusPath)) $configDirectory) -or -not (Same ([System.IO.Path]::GetDirectoryName($cancelPath)) $configDirectory)) { throw 'Status path escaped update working directory.' }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or (Test-Path -LiteralPath $backup)) { throw 'Original portable executable is missing or backup already exists.' }
  CheckHash $source
  CheckHash $staged
  WriteState 'waiting' 'Waiting for the application to exit.'
  @{phase='ready'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $readyPath -Encoding UTF8
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (ApplicationAlive) {
    if (Test-Path -LiteralPath $cancelPath) { throw 'Update installation was cancelled.' }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'The application did not exit; the original executable was left unchanged.' }
    Start-Sleep -Milliseconds 200
  }
  # Recheck the exact paths and content after the wait, before moving any file.
  $target = TargetChild $target
  $staged = TargetChild $staged
  $backup = TargetChild $backup
  if (Test-Path -LiteralPath $cancelPath) { throw 'Update installation was cancelled.' }
  CheckHash $staged
  RetryMove $target $backup
  $backupMade = $true
  RetryMove $staged $target
  $newPlaced = $true
  Start-Process -FilePath $target -WorkingDirectory $targetDir -WindowStyle Hidden -ErrorAction Stop | Out-Null
  WriteState 'completed' 'The new portable version was started. The previous executable is kept as backup.'
} catch {
  $failure = $_.Exception.Message
  [Console]::Error.WriteLine($failure)
  if ($backupMade) {
    try {
      if ($newPlaced -and (Test-Path -LiteralPath $target)) {
        $failed = TargetChild ($backup + '.failed.exe')
        RetryMove $target $failed
      }
      RetryMove $backup $target
      try { Start-Process -FilePath $target -WorkingDirectory $targetDir -WindowStyle Hidden -ErrorAction Stop | Out-Null } catch { }
      WriteState 'rolled-back' ('Update failed; previous version restored. ' + $failure)
    } catch { WriteState 'failed' ('Update failed; restore the saved previous executable manually. ' + $failure + ' Rollback: ' + $_.Exception.Message) }
  } else { WriteState 'failed' $failure }
  exit 1
}
