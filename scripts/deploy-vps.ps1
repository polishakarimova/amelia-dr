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
$appPort = $envMap["APP_PORT"]

if (!$serverIp) { throw "SERVER_IP is empty in $EnvFile" }
if (!$sshUser) { $sshUser = "root" }
if (!$sshPort) { $sshPort = "22" }
if (!$domain) { $domain = "mypovod.ru" }
if (!$appUrl) { $appUrl = "https://$domain" }
if (!$appPort) { $appPort = "3100" }

$target = "$sshUser@$serverIp"
$sshArgs = @("-p", $sshPort, "-o", "StrictHostKeyChecking=accept-new")
$scpArgs = @("-P", $sshPort, "-o", "StrictHostKeyChecking=accept-new")
if ($keyPath) {
  $sshArgs = @("-i", $keyPath) + $sshArgs
  $scpArgs = @("-i", $keyPath) + $scpArgs
}
$sshArgs = $sshArgs + @("-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes")
$scpArgs = $scpArgs + @("-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes")

function Assert-LastExit($label) {
  if ($LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE"
  }
}

Write-Host "Deploying Povod to $target for $domain"

ssh @sshArgs $target "mkdir -p /opt/povod"
Assert-LastExit "ssh mkdir"

function Quote-EnvValue($value) {
  if ($null -eq $value) { $value = "" }
  return '"' + (($value -replace '\\', '\\') -replace '"', '\"') + '"'
}

$databaseUrl = Quote-EnvValue $envMap["DATABASE_URL"]
$pgSslRootCert = Quote-EnvValue $envMap["PGSSLROOTCERT"]
$telegramBotToken = Quote-EnvValue $envMap["TELEGRAM_BOT_TOKEN"]
$telegramWebhookSecret = Quote-EnvValue $envMap["TELEGRAM_WEBHOOK_SECRET"]
$quotedAppUrl = Quote-EnvValue $appUrl
$adminTelegramIds = Quote-EnvValue $envMap["ADMIN_TELEGRAM_IDS"]
$adminToken = Quote-EnvValue $envMap["ADMIN_TOKEN"]
$quotedDomain = Quote-EnvValue $domain
$quotedAppPort = Quote-EnvValue $appPort

$appEnvPath = Join-Path $env:TEMP "povod-app.env"
@(
  "DATABASE_URL=$databaseUrl",
  "PGSSLROOTCERT=$pgSslRootCert",
  "TELEGRAM_BOT_TOKEN=$telegramBotToken",
  "TELEGRAM_WEBHOOK_SECRET=$telegramWebhookSecret",
  "APP_URL=$quotedAppUrl",
  "ADMIN_TELEGRAM_IDS=$adminTelegramIds",
  "ADMIN_TOKEN=$adminToken",
  "DOMAIN=$quotedDomain",
  "PORT=$quotedAppPort",
  "HOST=""127.0.0.1""",
  "DATA_DIR=""/var/lib/povod"""
) | Set-Content -LiteralPath $appEnvPath -Encoding UTF8

scp @scpArgs $appEnvPath "${target}:/opt/povod/.env"
Assert-LastExit "scp env"
Remove-Item -LiteralPath $appEnvPath -Force

$remoteScript = @"
set -e
if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if [ ! -d /opt/povod/.git ]; then
  rm -rf /opt/povod/*
  git clone https://github.com/polishakarimova/amelia-dr.git /opt/povod
fi
cd /opt/povod
git fetch origin main
git reset --hard origin/main
npm install --omit=dev
npm run check
mkdir -p /var/lib/povod
cat >/etc/systemd/system/povod.service <<'SERVICE'
[Unit]
Description=Povod app
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/povod
EnvironmentFile=-/opt/povod/.env
Environment=NODE_ENV=production
Environment=PORT=$appPort
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/var/lib/povod
ExecStart=/usr/bin/node /opt/povod/server.mjs
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable povod
systemctl restart povod
if command -v nginx >/dev/null 2>&1; then
cat >/etc/nginx/sites-available/povod <<'NGINX'
server {
  server_name mypovod.ru www.mypovod.ru;

  location / {
    proxy_pass http://127.0.0.1:$appPort;
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
  certbot --nginx -d mypovod.ru -d www.mypovod.ru --non-interactive --agree-tos -m admin@$domain --redirect || true
fi
"@

$remoteScript | ssh @sshArgs $target "bash -s"
Assert-LastExit "remote deploy"
Write-Host "Done. Check: $appUrl"
