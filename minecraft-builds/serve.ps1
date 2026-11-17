# Build Archive — tiny static file server (no Node/Python required)
# Usage:
#   powershell -ExecutionPolicy Bypass -File serve.ps1
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8090

param(
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$root = (Split-Path -Parent $MyInvocation.MyCommand.Path).TrimEnd('\')
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Host "Could not start on port $Port. Try -Port 8090." -ForegroundColor Red
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "Build Archive is running at $url" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
  Start-Process $url | Out-Null
}

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".webp" = "image/webp"
  ".ico"  = "image/x-icon"
  ".md"   = "text/markdown; charset=utf-8"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath)
    if ($path -eq "/") { $path = "/index.html" }

    $file = Join-Path $root ($path.TrimStart("/"))
    $full = [System.IO.Path]::GetFullPath($file)

    if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" }
      $ctx.Response.Headers.Add("Cache-Control", "no-cache")
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not found")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.Close()
  } catch {
    # ignore aborted requests
  }
}
