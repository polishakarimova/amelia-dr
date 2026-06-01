# Повод: перенос на домен и сервер

Проект теперь можно запускать не только как GitHub Pages, но и как Node-сервер.
Сервер отдаёт текущий SPA и предоставляет базовые API для кабинета, авторизации, событий, подарков и бронирований.

## Локальный запуск

```bash
npm start
```

По умолчанию сервер откроется на:

```text
http://localhost:3000
```

Порт можно изменить:

```bash
PORT=8080 npm start
```

## Что уже есть на сервере

- статическая отдача `index.html`;
- fallback для SPA-маршрутов `/dashboard`, `/p/[slug]` и других;
- файловая база `data/db.json`;
- cookie-сессии организатора;
- email/password auth;
- упрощённый Telegram-auth endpoint для будущего бота;
- API событий;
- API подарков;
- публичное API карточки;
- бронирование подарка гостем без регистрации.

## API

Сервер реализует контракт из `API_CONTRACT.md`:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/telegram/start`
- `POST /api/auth/telegram/callback`
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

## Деплой на VPS

1. Установить Node.js 20+.
2. Склонировать репозиторий.
3. Запустить:

```bash
npm install --omit=dev
PORT=3000 npm start
```

4. Поставить процесс под `pm2` или systemd:

```bash
npm install -g pm2
pm2 start server.mjs --name povod
pm2 save
```

5. Настроить Nginx:

```nginx
server {
  server_name mypovod.ru www.mypovod.ru;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

6. Выпустить SSL:

```bash
certbot --nginx -d mypovod.ru -d www.mypovod.ru
```

## DNS

Для домена `mypovod.ru` нужно направить:

- `A` record `@` на IP сервера;
- `A` record `www` на IP сервера.

## Важный следующий шаг

Сейчас frontend всё ещё хранит рабочие данные в `localStorage`.
Серверное API уже подготовлено, следующий этап — подключить `index.html` к API:

1. заменить `users()`, `events()`, `saveEvents()` на fetch-запросы;
2. заменить локальный Telegram-login на `/api/auth/telegram/start`;
3. заменить бронирование подарка на `/api/public/gifts/:id/reserve`;
4. хранить картинки не в localStorage, а в storage или базе.

## Перед продакшеном

Файловая база подходит для первого теста на VPS, но для настоящего продукта лучше перейти на PostgreSQL:

- users;
- sessions;
- events;
- gifts;
- reservations или поля брони в gifts.
