# API сервера Schema Teams для приложения — сверка по ТЗ v4, раздел 3.1

Сверено 25.10.2026 с кодом `schema-teams`: выпущенный тег **0.11.2** и ветка `stage/e13` (0.11.3 в работе — для приложения в ней ничего не менялось). Пути в столбце «Где» — от корня `schema-teams`; `chat` = `apps/server/src/modules/chat`, `shared` = `packages/shared/src`. Чего нет — в постановке `docs/teams-request.md`.

Итог: для своего чата сервер готов почти полностью (0.8.0–0.11.0) — сообщения, файлы, реакции, закрепление, ключ повтора, «Фокус», «печатает», прочтение. Нет: реестра плагинов, события «Альбом выдан», признака «у меня есть задачи на объекте» в списке чатов, данных утренней сводки целиком, чата поддержки, закрепления чата в списке. Набор реакций расходился с ТЗ — решено добавить 🔥 и 🎉 на сервер (раздел 5).

## 1. Вход, CSRF, заголовки

| Нужно | Есть? | Как | Где |
|---|---|---|---|
| Cookie сессии | есть | `st_session`, httpOnly; гаснет через 14 дней без активности | `shared/auth.ts` (`SESSION_COOKIE`), `modules/auth/sessions.ts` |
| Кто вошёл | есть, **другое имя** | `GET /api/auth/me` → `SessionInfo {user: {id, login, fullName, shortName, roles, permissions, mustChangePassword}, csrfToken, theme?, navCollapsed?}`. Маршрута `/api/me` нет | `modules/auth/routes.ts`, `shared/auth.ts` |
| CSRF | есть | все запросы, кроме GET/HEAD/OPTIONS, по cookie — с заголовком `x-csrf-token: <csrfToken из /api/auth/me>`; иначе 403 `{error: {code: 'csrf'}}`. Токен живёт, пока жива сессия: брать при запуске и после 403 `csrf` перечитать | `modules/access/guard.ts`, `shared/auth.ts` (`CSRF_HEADER`) |
| Проверка `Origin` / `Referer` | нет | сервер их не проверяет; CORS не включён — для запросов из главного процесса не важно | `app.ts` |
| Временный пароль | есть | `user.mustChangePassword = true` → прочие маршруты 403 `password_change_required`; приложению — показать окно входа (сайт сам ведёт на смену пароля) | `modules/access/guard.ts` |
| Ошибки | есть | `{error: {code, message, field?}}`, `message` — по-русски, можно показывать | `modules/objects/shared.ts` (`fail`) |
| Версия сервера | есть, **другое имя** | `GET /api/health` (без входа) → `{status, db, version}`; при 503 `version` тоже есть. Маршрута `/api/version` нет | `app.ts` |
| Токены доступа (Bearer) | есть, но не для приложения | работают только на маршрутах MCP (`token: true`); чат, уведомления, таймер по токену — 403 | `modules/access/guard.ts` |

## 2. Сокет (Socket.IO)

Подключение — к адресу сервера, путь по умолчанию `/socket.io`, cookie `st_session` в заголовке рукопожатия (из главного процесса — `extraHeaders: {cookie}`). Без действующей сессии — ошибка `unauthenticated`. Комната — `user:<id>`, вход сам. При остановке сервера соединения закрываются, клиент переподключается сам. Где: `apps/server/src/realtime.ts`.

| Событие | Данные | Где |
|---|---|---|
| `notification` | `NotificationPush {item: NotificationItem, quiet}`; `quiet` — тихие часы, строка часовой сводки или «Фокус» (кроме `chat_mention`) | `shared/notifications.ts`, `modules/notifications/dispatcher.ts` |
| `chat:message` | `ChatMessage` (под получателя); приходит и автору — своё отбрасывать по `author.id` | `shared/chat.ts` (`CHAT_EVENTS`), `chat/events.ts` |
| `chat:update` | `ChatMessage` — правка или удаление | то же |
| `chat:read` | `{chatId, userId, upTo}` — для ✓✓ и счётчиков | то же |
| `chat:list` | без данных — перечитать `GET /api/chats` | то же |
| `chat:reaction` | `{chatId, messageId, reactions: ChatReaction[]}` | то же |
| `chat:typing` | от сервера `{chatId, userId, shortName}`; клиент шлёт `{chatId}` не чаще раза в 3 с, гаснет через 5 с | `chat/presence.ts` |
| `chat:pin` | `{chatId}` — перечитать `GET /api/chats/:id` | `shared/chat.ts` |
| `chat:presence` | `PresenceChange {userId, online, lastSeen, focusUntil}` — всем, в том числе себе: так видно, что свой «Фокус» включили на сайте | `chat/presence.ts` |
| `chat:poll`, `chat:stickers` | опросы и набор стикеров | `shared/chat.ts` |
| `time:timer` | `TimeTimerPush {timer: WorkTimer \| null}` | `shared/time-timer.ts`, `modules/time/timer-routes.ts` |
| `session` | без данных — права или вход изменились: перечитать `/api/auth/me`; при закрытом входе соединение рвётся сразу после события | `realtime.ts` (`pushSessionChanged`) |

Подключение приложения считается «в сети» для коллег — как вкладка сайта.

## 3. Таблица 3.1 ТЗ

| Что (ТЗ 3.1) | Есть? | Маршрут и формат | Где |
|---|---|---|---|
| Кто вошёл, версия сервера | есть | `GET /api/auth/me`, `GET /api/health` (раздел 1) | см. выше |
| Счётчики | есть | `GET /api/notifications/unread` → `{unread}`; `GET /api/chats` → `unreadTotal` | `modules/notifications/routes.ts`, `chat/routes.ts` |
| Список чатов | есть | `GET /api/chats` → `ChatList {items: ChatSummary[], unreadTotal}`. `ChatSummary`: `id, kind ('direct' \| 'group' \| 'object' \| 'bureau'), title, peer, objectId, objectCode, memberCount, last {id, authorShortName, authorId, preview, at, deleted}, unread, mentioned, photoFileId` | `shared/chat.ts` |
| Разговор | есть | `GET /api/chats/:id` → `ChatDetail {chat, members [{user, readUpTo, photoFileId}], canWrite, pinned, canPin, …}` | то же |
| Сообщения постранично | есть | `GET /api/chats/:id/messages?before=<id>` / `?after=<id>` / `?around=<id>` → `ChatMessagePage {items (старые сверху), hasMore, hasNewer}`, по 50 | то же |
| Отправка | есть | `POST /api/chats/:id/messages` `{text, replyTo?, fileIds?, mentions?}` → `ChatMessage` (201). Тело строгое (`strictObject`): лишнее поле — 400. Текст до 4000 знаков | то же |
| Ключ повтора (5.4) | есть (0.10.0) | заголовок `Idempotency-Key`, 8–100 знаков `[A-Za-z0-9._:-]`; повтор в течение суток → то же сообщение (200), ключ другого разговора → 409 `idempotency_conflict` | `chat/routes.ts`, `shared/desktop-bridge.ts` (`IDEMPOTENCY_*`) |
| Прочитано | есть | `POST /api/chats/:id/read` `{upTo: <id сообщения>}`; «✓ Прочитано» в строке списка — `upTo = last.id` | `shared/chat.ts` |
| Правка, удаление своего | есть | `PATCH` / `DELETE /api/chats/:id/messages/:mid` (24 часа) | то же |
| Вложения: скачивание | есть | `GET /api/files/:fileId` по cookie; `ChatFile {fileId, fileName, size, mime, isImage}` в сообщении | `modules/filestore/routes.ts` |
| Вложения: загрузка | есть | `POST /api/chats/:id/files`, тело — байты файла, `Content-Type: application/octet-stream` (или тип картинки), имя — заголовок `X-File-Name` (`encodeURIComponent`) → `ChatFile`; затем `fileId` в `fileIds` сообщения. До 50 МБ, до 10 файлов в сообщении; запрещены `exe, msi, bat, cmd, com, scr, ps1, vbs, vbe, js, mjs, jar, dll, hta, wsf, html, htm, xhtml, svg, svgz` и исполняемое по содержимому; `.zip` можно | `chat/routes.ts`, `shared/tasks.ts` (`FORBIDDEN_EXTENSIONS`, `MAX_ATTACHMENT_BYTES`) |
| Вложения разговора (панель) | есть (0.11.0) | `GET /api/chats/:id/attachments?kind=image\|file&before=` | `chat/info.ts` |
| Реакции | есть, **другой набор** | `POST /api/chats/:id/messages/:mid/reactions` `{kind}`, `DELETE …/reactions/:kind` → `ChatReaction[] {kind, users}`. Набор фиксированный: `like` 👍, `done` ✅, `look` 👀, `heart` ❤️, `laugh` 😂, `question` ❓. В ТЗ 2.5 панель 👍 ❤️ 🔥 ✅ 👀 🎉 — 🔥 и 🎉 на сервере нет, 😂 и ❓ в ТЗ нет. Решено 25.10: 🔥 и 🎉 добавить на сервер | постановка, п. 2; `shared/chat.ts` (`CHAT_REACTIONS`) |
| Закрепление сообщения | есть (0.9.0) | `POST /api/chats/:id/pin` `{messageId \| null}` (null — открепить); право — `ChatDetail.canPin`; закреплённое — `ChatDetail.pinned`; событие `chat:pin` | `shared/chat.ts` |
| Закрепление **чата** в списке (6.1: булавка, «Закрепить») | **нет** | — | постановка, п. 6 |
| Поиск в чате | есть | `GET /api/chats/:id/search?q=` → до 30 `ChatMessage` | `shared/chat.ts` |
| «Печатает…» | есть | событие `chat:typing` (раздел 2) | `chat/presence.ts` |
| Лента колокольчика | есть | `GET /api/notifications?before=<id>&limit=` → `NotificationPage {items, unread, nextBefore}`; `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` → `{unread}` | `modules/notifications/routes.ts`, `shared/notifications.ts` |
| «Фокус» | есть (0.9.0) | `GET /api/focus` → `{until, startedAt}`; `PUT /api/focus` `{until: ISO \| null}` (до суток вперёд); `GET /api/focus/summary` → `FocusSummary {messages, mentions, chats[{chatId, title, count, mentions, last}]}`. Окончание по времени события не шлёт — считать по `until` | `chat/focus.ts` |
| Тихие часы, выбор событий | есть, на сервере | сервер ставит `quiet` у `notification`; настройки — `GET/PUT /api/notification-settings` (в приложении не дублируются, ТЗ 5.2) | `modules/notifications/settings-routes.ts` |
| Группа «Ждут вашего ответа» (6.1) | есть | в `ChatSummary`: `unread > 0` и (`kind = 'direct'` или `mentioned`) | `shared/chat.ts` |
| Группы по объектам | **частично** | у чата объекта есть `objectId`, `objectCode`; «мои активные задачи» — `GET /api/my` (`MyPage.tasks`), но в `MyTaskRow` есть только `objectName`, без номера объекта. Сопоставлять по названию ненадёжно | постановка, п. 3 |
| Чаты задач (6.1, папка «Объекты»; шапка с состоянием задачи) | **нет такого вида** | виды разговоров — `direct`, `group`, `object`, `bureau`; чатов отдельных задач на сервере нет, обсуждение задачи — комментарии на сайте. Решено 25.10: чатов задач нет и не будет | раздел 5 |
| События для служебного чата (6.2) | **частично** | `NotificationItem {id, event, at, read, author, task {id, kind, mark, title, objectName, stageCode}, changes [{field, from, to}], reason, subject, link}`. Виды для плиток: упоминание — `mention`, `chat_mention` (ссылка `/chat/<id>?m=<id>`); назначение — `assigned`; сроки — `due_soon`, `overdue`, `due_changed`. **Нет** события «Альбом выдан» исполнителю (есть только `subtasks_done` проверяющему) и «Все замечания закрыты»; плагинов на сервере нет | постановка, п. 7; `shared/notifications.ts`, `modules/notifications/rules.ts` |
| Таймер, трудозатраты | есть (0.10.0) | `GET /api/time/timer` → `{timer}`; `POST /api/time/timer/start` `{taskId}`, `…/pause` `{at?, reason?: 'lock' \| 'manual'}`, `…/resume`, `GET …/proposal`, `POST …/finish` `{rows, note?}`, `DELETE /api/time/timer`; `GET /api/time/options` → `{today, editableFrom, workday {start, end, lunchStart, lunchEnd}, tasks}`; событие `time:timer`. Окна `/desktop/pick` и `/desktop/finish` на сайте есть, закрываются сами (`window.close()`), мост не нужен | `modules/time/timer-routes.ts`, `shared/time-timer.ts`, `apps/web/src/pages/DesktopTimerPage.tsx` |
| Конец рабочего дня бюро (9.5) | есть | `GET /api/time/options` → `workday.end` (минуты) | `shared/time.ts` |
| Новая версия приложения | есть (0.10.0) | `GET /api/desktop/latest` (без входа) → `{version, notes, file, sha256, size, url}`, 404 `no_release`; файл — `GET /api/desktop/files/:name`. Данные — `data/desktop/latest.json`, кладёт администратор | `modules/desktop/routes.ts`, `shared/desktop-bridge.ts` |
| Плагины Revit | **нет** | — | постановка, п. 1 |
| Утренняя сводка (5.5) | **частично** | «Сроки сегодня» — из `GET /api/my` (`tasks[].dueDate = today`); «На проверке» — `MyPage.review` (только с правом `review`) или свои задачи в статусе проверки; рабочий ли день — `GET /api/time?from=&to=` (`days[].norm > 0`). **«Новых замечаний» нет**; три запроса вместо одного | постановка, п. 4 |
| Чат поддержки (13) | **нет** | настройки бюро «чат поддержки» нет. Есть обратная связь: `POST /api/feedback` `{kind: 'bug' \| 'idea' \| 'question', text, page?}` + `POST /api/feedback/:id/screenshot` (одна картинка) → уведомление администраторам; архив журналов приложить нельзя | постановка, п. 5; `modules/feedback/routes.ts` |
| Фото пользователя (шапка меню трея) | есть | `GET /api/profile` → `photoFileId`; файл — `GET /api/files/:id` | `modules/profile/routes.ts` |
| Чат «без звука» (5.2, п. 5) | нет | ТЗ: «если появится» — не обязательно | постановка, п. 8 (по желанию) |

## 4. Что учесть в Д3 (без изменений сервера)

- CSRF: `csrfToken` из `/api/auth/me` в заголовок `x-csrf-token` у каждого POST/PUT/PATCH/DELETE; 403 `csrf` → перечитать `/api/auth/me` и повторить один раз.
- Быстрый ответ: `Idempotency-Key` — постоянный для одного ответа (например, `desk-<uuid>`), повторять с тем же ключом. Проверка «последнего своего сообщения» (ТЗ 5.4) не нужна.
- Версия: `/api/health`, не `/api/version`. 0.10.0 — нижняя граница (ТЗ 3.3); весь нужный чат есть с 0.11.0 (панель вложений) — проверку версии ставить на **0.11.0**. **[Предложение Claude]**, записать в `decisions.md` при Д3.
- Реакции: показывать набор, который отдаёт сервер (неизвестный `kind` — пропускать), до решения по п. 2 постановки.
- Мост `desktop-bridge.ts` по ТЗ v4 больше не нужен; из него используются только постоянные `IDEMPOTENCY_*` и тип `DesktopLatest`.

## 5. Решения руководителя по итогам сверки (25.10.2026)

1. **Чаты задач — нет.** Только чаты объектов, личные, групповые и общий чат бюро. Папка «Объекты» — чаты объектов; в шапке чата объекта — объект и «Об объекте» («Открыть на сайте ↗»), плашки состояния задачи нет. Подписи вроде «КЖ2 · Монолит» на макете v4 — образцы. ТЗ v4, 3.1 и 6.1.
2. **Реакции 🔥 и 🎉 — добавить на сервер** (постановка, п. 2). До выхода версии Teams с ними приложение показывает набор сервера.
