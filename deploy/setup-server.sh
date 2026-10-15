#!/usr/bin/env bash
# Первичная настройка сервера (Debian 12/13, Ubuntu 22.04/24.04). Запуск от root:
#   bash setup-server.sh <домен> "<публичный SSH-ключ для деплоя>"
# Несколько доменов через запятую: "31-77-173-151.sslip.io, app.example.ru"
# Скрипт можно запускать повторно, например чтобы добавить домен.
set -euo pipefail

DOMAIN="${1:?Укажите домен, например 31-77-173-151.sslip.io}"
DEPLOY_KEY="${2:?Укажите публичный SSH-ключ для деплоя}"
APP_DIR=/srv/app
SERVICE=app-api

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Запустите от root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "Swap 1 ГБ"
if [[ -z "$(swapon --show --noheadings)" ]]; then
  if { fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; } \
    && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
    sysctl -q -p /etc/sysctl.d/99-swap.conf
  else
    echo "Swap на этой виртуализации недоступен, пропускаю"
    rm -f /swapfile
  fi
else
  echo "Swap уже есть"
fi

log "Зеркало пакетов Яндекса (deb.debian.org из России качает очень медленно)"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [[ -f "$f" ]] || continue
  sed -i -E \
    -e 's#https?://(deb|security)\.debian\.org/debian-security#https://mirror.yandex.ru/debian-security#g' \
    -e 's#https?://deb\.debian\.org/debian([/ ]|$)#https://mirror.yandex.ru/debian\1#g' "$f"
done

log "Пакеты"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl gnupg python3 rsync sudo sqlite3 ufw
if ! apt-cache show caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
fi
apt-get install -y -q caddy unattended-upgrades
timedatectl set-timezone Europe/Moscow 2>/dev/null || true

log "Обновления безопасности: сейчас и автоматически каждый день"
apt-get upgrade -y -q -o Dpkg::Options::=--force-confold
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades >/dev/null

log "Логи не больше 100 МБ"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

log "Пользователь deploy"
id deploy &>/dev/null || useradd --create-home --shell /bin/bash deploy
usermod -aG systemd-journal deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys || echo "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

install -d -o deploy -g deploy "$APP_DIR" "$APP_DIR/backend" "$APP_DIR/web"
install -d -m 700 -o deploy -g deploy "$APP_DIR/data"
chmod 700 "$APP_DIR/data"
find "$APP_DIR/data" -type f -exec chmod 600 {} +
[[ -f "$APP_DIR/.env" ]] || install -m 600 -o deploy -g deploy /dev/null "$APP_DIR/.env"
if [[ ! -f "$APP_DIR/web/index.html" ]]; then
  echo '<!doctype html><meta charset="utf-8"><title>Сервер работает</title><h1>Сервер работает, ждём первый деплой</h1>' \
    > "$APP_DIR/web/index.html"
  chown deploy:deploy "$APP_DIR/web/index.html"
fi

cat > /etc/sudoers.d/deploy <<EOF
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE, /bin/systemctl restart $SERVICE
EOF
chmod 440 /etc/sudoers.d/deploy
visudo -cqf /etc/sudoers.d/deploy

log "Сервис бэкенда ($SERVICE)"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Backend API (FastAPI)
After=network.target

[Service]
User=deploy
Group=deploy
WorkingDirectory=$APP_DIR/backend
Environment=PYTHONUNBUFFERED=1
# Библиотеки собираются в GitHub Actions и приходят в .deps вместе с кодом
Environment=PYTHONPATH=$APP_DIR/backend/.deps
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always
RestartSec=3
MemoryMax=450M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
# Новые файлы (база) доступны только пользователю deploy
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null

log "Caddy: HTTPS для $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
(app) {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:8000
	}
	handle {
		root * $APP_DIR/web
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@pages not path /assets/*
		header @pages Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}

$DOMAIN {
	import app
}

# Доступ по IP без HTTPS, на случай проблем с DNS
http:// {
	import app
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

log "Файрвол"
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
ufw allow "${SSH_PORT:-22}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null && ufw status | head -12 || echo "ufw не запустился, пропускаю"

log "SSH только по ключам"
if [[ -s /root/.ssh/authorized_keys ]]; then
  # sshd берёт первое найденное значение, поэтому глушим чужие настройки
  # (у LandVPS это 00password.conf с PasswordAuthentication yes)
  rm -f /etc/ssh/sshd_config.d/00-hardening.conf /etc/ssh/sshd_config.d/10-hardening.conf
  sed -i -E 's/^[[:space:]]*(PasswordAuthentication|PermitRootLogin|KbdInteractiveAuthentication)[[:space:]].*/# & (отключено setup-server.sh)/I' \
    /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true
  cat > /etc/ssh/sshd_config.d/00-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  SSHD_CFG=$(sshd -T)
  if grep -qx 'passwordauthentication no' <<<"$SSHD_CFG" \
    && grep -qxE 'permitrootlogin (without-password|prohibit-password)' <<<"$SSHD_CFG"; then
    echo "Вход по паролю отключён (проверено sshd -T)"
  else
    echo "ОШИБКА: sshd всё ещё принимает пароль:"
    grep -E '^(passwordauthentication|permitrootlogin) ' <<<"$SSHD_CFG"
    exit 1
  fi
else
  echo "Нет ключей у root, вход по паролю оставлен"
fi

log "Готово"
echo "Сайт:     https://${DOMAIN%%,*}"
echo "Данные:   $APP_DIR/data (база), ключи ИИ: $APP_DIR/.env"
echo "Логи API: journalctl -u $SERVICE -f"
