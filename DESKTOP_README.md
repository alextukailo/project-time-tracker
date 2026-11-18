# Time Tracker — Electron, этап 1 (архивная инструкция)

**Этап 2 (Google OAuth + Google Sheets) описан в `DESKTOP_GOOGLE_SETUP.md`.** Эта инструкция сохранена для истории первого этапа.


Этот патч предназначен для ветки `dev-desktop`, созданной из `dev-web`. Он не изменяет `public/manifest.json`, `scripts/setup-extension-id.mjs`, `chrome.storage.local` установленного расширения и Google OAuth Client ID.

## Что работает

- Отдельное desktop-окно с уже существующим React UI (Vite + Tailwind + TanStack Query).
- Создание/переименование/удаление локальных проектов.
- Запуск, пауза, остановка таймеров, история и удаление сессий.
- Хранение проектов и истории в файле `tracker-data.json` внутри `app.getPath('userData')`; данные переживают перезапуск приложения.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; renderer не имеет произвольного доступа к IPC или Node.js.

## Пока не работает (этап 2)

- Google OAuth, выбор таблицы и двусторонняя синхронизация Sheets. **Не подключайте рабочую таблицу на этом этапе.**
- Трей, фоновая синхронизация, автоматическая упаковка в `.dmg`/`.exe`.
- Автоматический импорт состояния из Chrome Extension (локальное хранилище desktop отдельное).

## Установка

1. Переключись на ветку `dev-desktop`, убедись, что нет незакоммиченных изменений: `git status`.
2. Сделай резервную копию проекта и распакуй патч **в корень репозитория**, сохраняя структуру каталогов.
3. Установи зависимости в ветке `dev-desktop`:

   ```bash
   npm install -D electron vite-plugin-electron@^1
   ```

4. Запуск в разработке (выполняется Vite + Electron):

   ```bash
   npm run desktop:dev
   ```

5. Сборка desktop и отдельный запуск:

   ```bash
   npm run desktop:build
   npm run desktop:start
   ```

6. Тесты локального хранилища и существующих операций:

   ```bash
   npm run lint
   npm run test:smoke
   ```

> `npm run build` продолжает собирать расширение Chrome в `dist/`. Desktop UI собирается в `dist-desktop/`, Electron main/preload — в `dist-electron/`. Не отправляй Electron-приложение пользователям как ZIP исходников: для распространения после тестов понадобится `electron-builder` или Electron Forge.

## Архитектура

```
electron/main.js     -> BrowserWindow + whitelist IPC handlers
electron/preload.js  -> window.desktop.storage через contextBridge
electron/storage.js  -> JSON в userData (атомарные последовательные записи)
src/shared/platform/chromeCompat.js
                     -> временный адаптер chrome.storage для существующей FSD-логики
vite.desktop.config.js -> отдельная сборка для Electron
```

## Google OAuth на этапе 2

Для Electron потребуется **новый OAuth Client типа Desktop app**, даже если существующий Chrome Extension OAuth Client полностью работает. Авторизация будет через системный браузер + PKCE + loopback redirect, refresh token — хранить в защищённом хранилище ОС. Никогда не помещай `client_secret` или refresh token в Vite frontend.

## Важно

Установленное Chrome-расширение и Desktop-приложение используют **разные локальные хранилища**. При закрытии desktop-окна на macOS приложение может оставаться запущенным; таймер хранит системную метку времени, поэтому при повторном открытии продолжит считать прошедшее время. До появления трея лучше останавливать таймер, когда заканчиваешь работу.

Если `npm run desktop:dev` не запускается, пришли лог терминала и ошибки DevTools приложения. `node -v`, `npm -v` тоже полезны.
