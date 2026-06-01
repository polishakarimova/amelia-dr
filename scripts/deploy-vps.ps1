param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

function Read-DotEnv($path) {
  $result = @{}
  if (!(Test-Path -LiteralPath $path)) {
    throw "Env file not found: $path"
  }
  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if (!$trimmed -or $trimmed.StartsWith("#") -or !$trimmed.Contains("=")) { continue }
    $parts = $trimmed.Split("=", 2)
    $value = $parts[1].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $result[$parts[0].Trim()] = $value
  }
  return $result
}

$envMap = Read-DotEnv $EnvFile
$serverIp = $envMap["SERVER_IP"]
$sshUser = $envMap["SSH_USER"]
$sshPort = $envMap["SSH_PORT"]
$domain = $envMap["DOMAIN"]
$appUrl = $envMap["APP_URL"]
$keyPath = $envMap["SSH_PRIVATE_KEY_PATH"]

if (!$serverIp) { throw "SERVER_IP is empty in $EnvFile" }
if (!$sshUser) { $sshUser = "root" }
if (!$sshPort) { $sshPort = "22" }
if (!$domain) { $domain = "mypovod.ru" }
if (!$appUrl) { $appUrl = "https://$domain" }

$target = "$sshUser@$serverIp"
$sshArgs = @("-p", $sshPort, "-o", "StrictHostKeyChecking=accept-new")
$scpArgs = @("-P", $sshPort, "-o", "StrictHostKeyChecking=accept-new")
if ($keyPath) {
  $sshArgs = @("-i", $keyPath) + $sshArgs
  $scpArgs = @("-i", $keyPath) + $scpArgs
}

Write-Host "Deploying Povod to $target for $domain"

ssh @sshArgs $target "mkdir -p /opt/povod"
scp @scpArgs $EnvFile "${target}:/opt/povod/.env"

$remoteScript = @"
set -e
if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then npm install -g pm2; fi
if [ ! -d /opt/povod/.git ]; then
  rm -rf /opt/povod/*
  git clone https://github.com/polishakarimova/amelia-dr.git /opt/povod
fi
cd /opt/povod
git fetch origin main
git reset --hard origin/main
npm install --omit=dev
npm run check
pm2 start server.mjs --name povod --update-env || pm2 restart povod --update-env
pm2 save
if command -v nginx >/dev/null 2>&1; then
cat >/etc/nginx/sites-available/povod <<'NGINX'
server {
  server_name mypovod.ru www.mypovod.ru;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host `$host;
    proxy_set_header X-Real-IP `$remote_addr;
    proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto `$scheme;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/povod /etc/nginx/sites-enabled/povod
nginx -t
systemctl reload nginx
fi
if command -v certbot >/dev/null 2>&1; then
  certbot --nginx -d mypovod.ru -d www.mypovod.ru --non-interactive --agree-tos -m admin@$domain || true
fi
"@

ssh @sshArgs $target $remoteScript
Write-Host "Done. Check: $appUrl"

