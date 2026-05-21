# Бесплатное бронирование через Google Sheets

Этот вариант заменяет Supabase: бронирования хранятся в обычной Google-таблице, а сайт на GitHub Pages обращается к ней через Google Apps Script.

## 1. Создать таблицу

1. Откройте Google Sheets.
2. Создайте новую таблицу, например `wishlist-reservations`.
3. Откройте `Extensions` -> `Apps Script`.

## 2. Вставить backend

1. Удалите код в `Code.gs`.
2. Вставьте туда содержимое файла `google-apps-script.js`.
3. Нажмите `Save`.

## 3. Опубликовать Web App

1. Нажмите `Deploy` -> `New deployment`.
2. Выберите тип `Web app`.
3. `Execute as`: `Me`.
4. `Who has access`: `Anyone`.
5. Нажмите `Deploy` и разрешите доступ к таблице.
6. Скопируйте `Web app URL`.

## 4. Подключить сайт

В `index.html` найдите строку:

```js
const RESERVATION_API_URL = '';
```

И вставьте URL:

```js
const RESERVATION_API_URL = 'https://script.google.com/macros/s/ВАШ_ID/exec';
```

После этого закоммитьте и запушьте изменения. GitHub Pages обновит публичную ссылку, а кнопки бронирования будут работать для всех гостей.

## Что будет в таблице

Скрипт сам создаст лист `reservations` с колонками:

```text
gift_id | name | device_id | updated_at
```

`device_id` нужен, чтобы отменять бронь мог только тот же браузер, который ее поставил.
