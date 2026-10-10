# Re-create the DSH profile junction for the Bing web-search provider.
#
# The DSH profile resolves plugin package names from
#   %APPDATA%\dsh-desktop\harness\profiles\web\node_modules\
# Running `pnpm install` in that profile (which the DSH plugin market does when
# it installs, updates, or removes a plugin) prunes every entry that no
# package.json dependency names, so the junction below disappears and web
# search starts failing with WEB_PROVIDER_CONFIGURED_MISSING. Run this script
# again after any such install and restart DSH Desktop.
#
# It is idempotent: an existing correct junction is reported and left alone.

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$profileWeb = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
$nodeModules = Join-Path $profileWeb 'node_modules'
$link = Join-Path $nodeModules 'dsh-web-search-bing'

if (-not (Test-Path $profileWeb)) {
    throw "DSH web profile not found: $profileWeb"
}
if (-not (Test-Path $nodeModules)) {
    throw "DSH profile node_modules not found: $nodeModules"
}

if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType) {
        Write-Host "already linked: $link -> $($item.Target)"
        exit 0
    }
    throw "path exists and is not a link; remove it manually first: $link"
}

New-Item -ItemType Junction -Path $link -Target $source | Out-Null
Write-Host "linked: $link -> $source"
Write-Host 'Restart DSH Desktop (or let profile HMR reload) for the provider to register.'
