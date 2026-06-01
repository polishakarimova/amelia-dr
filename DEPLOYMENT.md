# Повод: домен, сервер и деплой

Проект запускается как Node-сервер: он отдает текущий SPA-интерфейс и предоставляет API для кабинета, авторизации, событий, подарков, публичной карточки и бронирований.

## Локальный запуск

```bash
npm start
```

По умолчанию сервер открывается на:

```text
http://localhost:3000
```

Порт можно изменить:

```bash
PORT=8080 npm start
```

## Что уже есть

- статическая отдача `index.html`;
- fallback для SPA-маршрутов `/dashboard`, `/p/[slug]` и других;
- файловая база `data/db.json` локально или `/var/lib/povod/db.json` на сервере;
- cookie-сессии организатора;
- email/password auth как запасной вход;
- Telegram Bot webhook;
- Telegram Mini App auth через проверку `initData`;
- API событий;
- API подарков;
- публичное API карточки;
- бронирование подарка гостем без регистрации.

## API

Сервер реализует основные routes из `API_CONTRACT.md`:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/telegram-mini-app`
- `GET /api/telegram/config`
- `POST /api/telegram/webhook`
- `POST /api/telegram/setup-webhook`
- `GET /api/events`
- `POST /api/events`
- `GET /api/events/:id`
- `PATCH /api/events/:id`
- `DELETE /api/events/:id`
- `POST /api/events/:id/publish`
- `POST /api/events/:id/unpublish`
- `GET /api/events/:id/gifts`
- `POST /api/events/:id/gifts`
- `PATCH /api/gifts/:id`
- `DELETE /api/gifts/:id`
- `POST /api/gifts/:id/unreserve`
- `GET /api/public/events/:slug`
- `POST /api/public/gifts/:id/reserve`

## Текущий production

- домен: `mypovod.ru` и `www.mypovod.ru`;
- приложение на сервере: `/opt/povod`;
- systemd service: `povod.service`;
- порт приложения: `127.0.0.1:3100`;
- reverse proxy: Nginx;
- SSL: Certbot;
- данные: `/var/lib/povod/db.json`;
- env-файл: `/opt/povod/.env`.

Проверка на сервере:

```bash
systemctl status povod --no-pager
journalctl -u povod -n 80 --no-pager
curl -I https://mypovod.ru
```

## Деплой на VPS

Минимальный ручной деплой:

```bash
cd /opt/povod
git fetch origin main
git reset --hard origin/main
npm install --omit=dev
npm run check
systemctl restart povod
systemctl is-active povod
```

Systemd service должен запускать:

```bash
PORT=3100 HOST=127.0.0.1 DATA_DIR=/var/lib/povod npm start
```

Nginx проксирует на:

```nginx
proxy_pass http://127.0.0.1:3100;
```

## DNS

Для домена `mypovod.ru` нужны:

- `A` record `@` на IP сервера;
- `A` record `www` на IP сервера.

## Безопасность сервера

Сейчас SSH настроен на вход по ключу:

- `PasswordAuthentication no`;
- `PermitRootLogin prohibit-password`;
- `PubkeyAuthentication yes`.

Также включены `ufw` и `fail2ban`. Это снижает риск перебора пароля ботами, но порт `22` все равно будет видеть попытки сканирования в логах. Для живого продукта важно не отключать `fail2ban` и не возвращать парольный вход.

## Что уже подключено к frontend

Frontend уже использует серверное API для основных рабочих сценариев:

- вход и регистрация: `/api/auth/*`;
- Telegram Mini App auth: `/api/auth/telegram-mini-app`;
- кабинет и список карточек: `/api/events`;
- создание черновика карточки: `POST /api/events`;
- редактирование деталей и обложки: `PATCH /api/events/:id`;
- добавление, редактирование и удаление подарков: `/api/events/:id/gifts` и `/api/gifts/:id`;
- публикация и снятие с публикации: `/api/events/:id/publish`, `/api/events/:id/unpublish`;
- публичная карточка гостя: `/api/public/events/:slug`;
- бронирование подарка гостем: `/api/public/gifts/:id/reserve`.

`localStorage` пока оставлен только как мягкий fallback для старого демо и локального кэша. Перед большим production-трафиком нужно вынести обложки и картинки подарков в нормальный storage, потому что сейчас они могут сохраняться как длинные data URL в файловую базу.

Telegram Mini App auth уже подключен на backend. Если Telegram открывает только чат, а не Mini App, нужно проверить настройки Mini App/Web App в BotFather.

## Перед production

Файловая база подходит для первого теста на VPS, но для настоящего продукта лучше перейти на PostgreSQL:

- users;
- sessions;
- events;
- gifts;
- reservations или поля брони в gifts.
