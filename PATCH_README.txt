Time Tracker v4 — исправление возвращающихся удалённых проектов

Сначала сохраните резервную копию Google Таблицы и chrome.storage.local.

Установить:
1. Распаковать этот патч в корень project-time-tracker с заменой файлов.
2. Скопировать содержимое google-apps-script/Code.gs в текущий Google Apps Script.
3. Apps Script: Deploy > Manage deployments > Edit > New version > Deploy.
4. Открыть URL /exec: ответ должен содержать version 4.0.0 и build safe-delete-2.
5. В папке расширения выполнить npm run lint && npm run build.
6. Перезагрузить то же расширение в chrome://extensions, не удаляя его.
7. Уже вернувшийся проект удалить ещё раз. Следующее фоновое обновление не должно восстановить его.

Важно: файл .env с секретом не включён, не удаляйте свой .env.
Проверено: node --test tests/*.test.mjs (18/18).
Сборка Vite не проверялась (в рабочей среде отсутствует node_modules).
