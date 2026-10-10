# Re-create the DSH profile link for the Bing web-search provider.
#
# The DSH profile resolves plugin package names from
#   %APPDATA%\dsh-desktop\harness\profiles\web\node_modules\
#
# The normal path is declarative: the profile's package.json carries
#   "dsh-web-search-bing": "link:D:/codex_proj/dev/projects/dsh-web-search-bing"
# and pnpm keeps that link across installs. Run this script only when that line
# was rewritten (the DSH plugin market regenerates package.json when it
# installs, updates, or removes a plugin) or when the link is otherwise gone --
# the symptom is web search failing with WEB_PROVIDER_CONFIGURED_MISSING.
#
# It is idempotent: an existing correct link is reported and left alone.

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
    }
    else {
        throw "path exists and is not a link; remove it manually first: $link"
    }
}
else {
    New-Item -ItemType Junction -Path $link -Target $source | Out-Null
    Write-Host "linked: $link -> $source"
}

# Report whether the declarative dependency line is present, so the caller knows
# whether the next pnpm install will keep the link.
$manifestPath = Join-Path $profileWeb 'package.json'
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $declared = $manifest.dependencies.'dsh-web-search-bing'
    if ($declared) { Write-Host "package.json declares: $declared" }
    else { Write-Host 'WARNING: package.json has no "dsh-web-search-bing" dependency; re-add it or the next pnpm install will prune the link.' }
}
catch {
    Write-Host "WARNING: could not read $manifestPath ($($_.Exception.Message))"
}

Write-Host 'Restart DSH Desktop (or let profile HMR reload) for the provider to register.'
