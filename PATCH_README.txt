TIME TRACKER — ПРОСТОЙ ПЕРВЫЙ ЗАПУСК (OAuth + Sheets)

Изменены:
- src/pages/tracker/ui/TrackerPage.jsx
- src/features/google-sheets/ui/GoogleSheetsPanel.jsx
- src/features/google-sheets/api/googleSheetsApi.js
- src/**/*.js(x): удалены ненужные директивы eslint-disable no-undef
- README.md и tests/onboarding.test.mjs

Новые пользователи видят только вход через Google и ссылку на таблицу.
После подключения открывается обычный интерфейс таймеров.
В настройках подключенной таблицы остаётся смена/отключение.

Разработчику: в public/manifest.json один раз настроить настоящий OAuth Client ID.
Для публичного выпуска со scope spreadsheets потребуется Google OAuth verification.

Установка: распаковать патч в корень проекта, npm ci, npm run lint,
npm run test:smoke, npm run build, обновить Chrome Extension.
