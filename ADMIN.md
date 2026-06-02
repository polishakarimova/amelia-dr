# Povod Admin

PostgreSQL is enabled when `DATABASE_URL` is set. On startup the server creates these tables if needed:

- `povod_users`
- `povod_sessions`
- `povod_login_tokens`
- `povod_events`
- `povod_gifts`
- `povod_broadcasts`

Admin is enabled when `ADMIN_TOKEN` is set.

Open the admin UI:

```text
https://mypovod.ru/admin?adminToken=YOUR_ADMIN_TOKEN
```

Local development:

```text
http://127.0.0.1:3000/admin?adminToken=YOUR_ADMIN_TOKEN
```

The token is stored in browser `localStorage`. Use `Logout` in admin to clear it.

Admin API:

- `GET /api/admin/overview`
- `GET /api/admin/broadcasts`
- `POST /api/admin/broadcasts`
- `PATCH /api/admin/broadcasts/:id`
- `DELETE /api/admin/broadcasts/:id`

Pass the token as `x-admin-token`, `Authorization: Bearer ...`, or the initial `adminToken` query parameter.
