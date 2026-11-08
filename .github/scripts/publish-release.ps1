param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [switch]$PublishExistingOnly
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { throw 'A stable version tag is required' }
$version = $Tag.Substring(1)
$repo = $env:GITHUB_REPOSITORY
if (-not $repo) { throw 'GITHUB_REPOSITORY is required' }
$names = @("DualLink-$version-x64-setup.exe", "DualLink-$version-x64-portable.exe", "DualLink-source-$version.zip", "DualLink-web-$version.zip", "SHA256SUMS-$version.txt")
function Get-TargetRelease {
  $all = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot list releases' }
  $found = @($all | Where-Object { $_.tag_name -eq $Tag })
  if ($found.Count -gt 1) { throw 'Multiple releases have the same tag' }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
$release = Get-TargetRelease
if (-not $PublishExistingOnly) {
  if ($release -and -not $release.draft) { throw 'Refusing to replace a published release' }
  if (-not $release) {
    gh release create $Tag --draft --verify-tag --title "DualLink $Tag" --generate-notes
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create release draft' }
    $release = Get-TargetRelease
  }
  if (-not $release) { throw 'Release draft not found' }
  foreach ($name in $names) {
    $file = if ($name.EndsWith('.exe')) { "release/windows/$name" } else { "release/$name" }
    if (-not (Test-Path $file)) { throw "Missing build asset: $file" }
    $old = @($release.assets | Where-Object { $_.name -eq $name })
    foreach ($asset in $old) {
      gh api --method DELETE "repos/$repo/releases/assets/$($asset.id)"
      if ($LASTEXITCODE -ne 0) { throw "Cannot replace draft asset: $name" }
    }
    $escaped = [Uri]::EscapeDataString($name)
    gh api --method POST "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$escaped" -H 'Content-Type: application/octet-stream' --input $file > $null
    if ($LASTEXITCODE -ne 0) { throw "Cannot upload asset: $name" }
  }
  $release = Get-TargetRelease
}
if (-not $release) { throw 'Release not found' }
foreach ($name in $names) {
  $asset = @($release.assets | Where-Object { $_.name -eq $name })
  if ($asset.Count -ne 1 -or $asset[0].size -le 0) { throw "Missing or empty uploaded asset: $name" }
}
$sums = @($release.assets | Where-Object { $_.name -eq "SHA256SUMS-$version.txt" })[0]
$lines = @(gh api "repos/$repo/releases/assets/$($sums.id)" -H 'Accept: application/octet-stream')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read uploaded checksums' }
$hashes = @{}
foreach ($line in $lines) {
  if ($line.Trim() -match '^([a-f0-9]{64})\s+(.+)$') { $hashes[$Matches[2]] = $Matches[1] }
}
if ($hashes.Count -ne 4) { throw 'Invalid checksum manifest' }
foreach ($name in $names[0..3]) {
  $asset = @($release.assets | Where-Object { $_.name -eq $name })[0]
  if (-not $hashes.ContainsKey($name) -or $asset.digest -ne "sha256:$($hashes[$name])") { throw "Uploaded checksum mismatch: $name" }
}
if ($release.draft) {
  gh api --method PATCH "repos/$repo/releases/$($release.id)" -F draft=false -f make_latest=true > $null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot publish release' }
}
Write-Output "Published $Tag; all five assets are present and all four package digests match the uploaded checksums."
