# Повод: backend contract

Текущий GitHub Pages MVP работает как static SPA и хранит данные в `localStorage`.
Этот контракт фиксирует следующий шаг: заменить локальное хранение на настоящий backend, не меняя продуктовую логику интерфейса.

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

Основной сценарий для организатора — сохранение и вход через Telegram-бота. Email и пароль остаются запасным способом.
Гость открывает публичную карточку и бронирует подарок без регистрации.

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

- `POST /api/auth/telegram/start`
- `POST /api/auth/telegram/callback`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Telegram-токен бота нельзя хранить на фронте. Эти routes должны жить на backend и создавать сессию организатора после подтверждения Telegram-пользователя.

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

- Подключить базу данных и заменить `localStorage` на API.
- Подключить настоящего Telegram-бота как основной вход и канал уведомлений.
- Хранить пароль только как `passwordHash`, не в открытом виде.
- Добавить серверную проверку владельца события для `/dashboard`.
- Добавить storage для обложек и картинок подарков.
- Настроить домен `mypovod.ru` и маршрутизацию SPA/SSR.
