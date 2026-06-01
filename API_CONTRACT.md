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

- `GET /api/events/[id]/gifts`
- `POST /api/events/[id]/gifts`
- `PATCH /api/gifts/[id]`
- `DELETE /api/gifts/[id]`

### Reservations

- `POST /api/public/gifts/[id]/reserve`
- `POST /api/gifts/[id]/unreserve`

## Production TODO

- Подключить frontend-кабинет, события, подарки и публичную карточку к API вместо `localStorage`.
- Перейти с файловой базы на PostgreSQL перед большим потоком пользователей.
- Хранить пароль только как `passwordHash`, не в открытом виде.
- Добавить storage для обложек и картинок подарков.
- Расширить Telegram-уведомления: присылать организатору сообщение о новой брони подарка.
- Добавить серверную проверку владельца события для всех действий в `/dashboard`.
