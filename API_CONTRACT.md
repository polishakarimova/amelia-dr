# Повод: backend contract

Текущий MVP работает как SPA с Node-backend. Этот контракт фиксирует серверные сущности и routes, к которым нужно постепенно подключить frontend вместо локального хранения в `localStorage`.

## Entities

### User

- `id`
- `email`
- `passwordHash`
- `name`
- `authProvider`: `telegram` или `email`
- `telegramId`
- `telegramUsername`
- `createdAt`

Основной сценарий для организатора - сохранение и вход через Telegram Mini App. Email и пароль остаются запасным способом. Гость открывает публичную карточку и бронирует подарок без регистрации.

### Event

- `id`
- `userId`
- `title`
- `slug`
- `type`
- `theme`
- `date`
- `time`
- `placeName`
- `address`
- `mapUrl`
- `description`
- `wishes`
- `coverImage`
- `status`: `draft` или `published`
- `createdAt`
- `updatedAt`

### Gift

- `id`
- `eventId`
- `title`
- `description`
- `url`
- `price`
- `image`
- `category`
- `status`: `available` или `reserved`
- `reservedByName`
- `reservedByContact`
- `reservedComment`
- `reservedAt`
- `createdAt`
- `updatedAt`

## API routes

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/telegram-mini-app`
- `POST /api/auth/telegram-login-token`
- `GET /api/auth/telegram-login-token/:token`

Telegram-токен бота нельзя хранить на фронте. Mini App присылает `initData`, backend проверяет подпись через bot token и создает cookie-сессию организатора.

### Telegram bot

- `GET /api/telegram/config`
- `POST /api/telegram/webhook`
- `POST /api/telegram/setup-webhook`

Webhook принимает события от Telegram. Команда `/start` отправляет кнопку, которая открывает Mini App/сайт. `setup-webhook` защищен секретом из `.env`.

### Events

- `GET /api/events`
- `POST /api/events`
- `GET /api/events/[id]`
- `PATCH /api/events/[id]`
- `DELETE /api/events/[id]`
- `POST /api/events/[id]/publish`
- `POST /api/events/[id]/unpublish`

### Public

- `GET /api/public/events/[slug]`

### Gifts

- `POST /api/gift-preview`
- `GET /api/events/[id]/gifts`
- `POST /api/events/[id]/gifts`
- `PATCH /api/gifts/[id]`
- `DELETE /api/gifts/[id]`

`POST /api/gift-preview` принимает `{ "url": "..." }` и возвращает `preview` с `title`, `price`, `image`, `description`. Сейчас автозаполнение поддерживает ссылки Wildberries.

### Reservations

- `POST /api/public/gifts/[id]/reserve`
- `POST /api/gifts/[id]/unreserve`

## Production TODO

- Заменить локальную папку uploads на S3-compatible storage перед большим потоком пользователей.
- Расширить Telegram-уведомления: присылать организатору сообщение о новой брони подарка.
- Добавить expiry/очистку старых cookie-сессий.
