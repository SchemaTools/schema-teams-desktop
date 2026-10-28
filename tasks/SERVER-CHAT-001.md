# SERVER-CHAT-001 — договор для собственного интерфейса Desktop-чата

Статус: **проект постановки**, не реализация и не утверждённый договор.
Дата: 28.10.2026. Руководитель потребовал собственный интерфейс чата в приложении.
Руководитель сообщил 28.10: ожидается новый макет интерфейса. Собственный чат
реализуется по нему; прежний макет v1 не принят за основу новой реализации.
До получения нового макета состав MVP ниже является предварительным.
Заказчик результата — разработчик Schema Teams Desktop. Исполнитель — ответственный за сервер.
До выбора образца и согласования объёма этот проект не считается готовым заданием
для реализации; публикация в ветке обмена предназначена для обсуждения.

## 1. Проверенная основа и результат

Основа: Schema Teams `0.11.2`, commit `f176f7635a50832b78ba570b56fd9ec5aa2813d4`.
Desktop-договор сейчас 1.1, blob `21bb1258ab9f82b05786e1ba11f58f7ec4fa56f6`.
API чата уже существует; требуются web service-page и типизированный shared-мост к собственному UI.
Ниже новые имена команд, envelope, capabilities и ограничения — **предложение**, не поля текущего API.
Desktop-разработчик не меняет сервер. Серверный исполнитель не меняет desktop-код.

Первичные источники на проверенном commit:
- [Chat DTO и лимиты](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/packages/shared/src/chat.ts).
- [Chat REST](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/modules/chat/routes.ts), [вид под читателя](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/modules/chat/view.ts).
- [Web chat-клиент](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/web/src/chat.ts), [Socket.IO web](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/web/src/connection.ts), [Socket.IO server](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/realtime.ts).
- [Login/cookie](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/modules/auth/routes.ts), [CSRF/доступ](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/modules/access/guard.ts), [web API](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/web/src/api.ts).
- [Shared Desktop 1.1](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/packages/shared/src/desktop-bridge.ts), [текущие web handlers](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/web/src/desktop/useDesktop.ts), [правила уведомлений](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/web/src/desktop/notify.ts).
- [HTTP/CSP](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/app.ts), [файлы и их права](https://github.com/SchemaTools/schema-teams/blob/f176f7635a50832b78ba570b56fd9ec5aa2813d4/apps/server/src/modules/filestore/routes.ts).

## 2. Объём первой итерации

MVP: список разговоров; детали и права; история с подгрузкой; отправка простого текста;
прочтение реально просмотренного; realtime-инвалидация; reconnect; открытие нужного сообщения;
синхронизация видимого разговора для корректных уведомлений. Данные остаются на существующем сервере.
Не создавать отдельный чат, отдельную БД сообщений или второе соединение Socket.IO в native/main.
Не переделывать округление/таймер и не объявлять выполненным `SERVER-D5-001` этой работой.

Реакции, цитирование при отправке, правка/удаление, группы, поиск людей, опросы, стикеры,
живые карточки и бинарные вложения — отдельное продолжение после подтверждения объёма.
Существующие сложные сообщения не прятать: сохранять текст/системную отметку и понятный fallback
«Открыть в Teams». Не рисовать неподдержанный опрос как обычный текст или потерянную пустую строку.
Файлы/картинки пока показываются метаданными и fallback; поддержка загрузки/скачивания не заявляется.

## 3. Авторизация и service-page

Добавить same-origin web-маршрут `/desktop/service`: клиентский обработчик с существующими
session/API/Socket.IO модулями. Он работает в отдельном webContents с cookie-разделом Teams;
локальный UI не встраивает его iframe (сервер сейчас запрещает embedding через CSP/X-Frame-Options).
Вход выполняется обычной серверной страницей; пароли вводятся только там. Service-page не
пересылает native `SessionInfo` целиком: он содержит csrfToken. Достаточны безопасный hello и DTO.
Cookie `st_session` остаётся HttpOnly/SameSite=Strict; CSRF — только в памяти server-origin страницы.
API вызывается этой страницей. Main/local renderer не получают cookie, пароль, CSRF или Bearer.
Не добавлять CORS `*`, доступ для `null`/file-origin, MCP-токен для чата, обход SameSite или webSecurity=false.
Не вводить новый backend-auth и не раскрывать общий fetch/URL/method/header RPC. DOM не считывается.
Текущие membership, canWrite, 401/403/404 и обязательная смена временного пароля сохраняются.

## 4. Совместимость и одно определение договора

Согласовать **единый совместимый minor** с исполнителем `SERVER-D5-001` (там предложен 1.2).
Нельзя выпускать два разных desktop-bridge.ts под одинаковым номером или переписывать новые поля Д5.
Один source commit/blob SHA; обе стороны копируют именно его. Старшие несовместимости — по прежним правилам.
В согласованный hello/capabilities добавить `chatUi:1`; не включать capability до готовности всех MVP-команд.
В 1.1 сохраняются прежние reply/markRead/navigate и Д3/Д4. Нет chatUi — собственный UI явно недоступен,
разрешён прежний переход в веб; нельзя молча показать макет с фиктивными данными как работающий чат.
Новые typed success `{ok:true,data:T}` и ошибки объединить с результатами Д5; legacy `{ok:true}` не ломать.

## 5. Envelope, адресат и время жизни

Каждая новая команда содержит `{requestId, consumerId, sessionEpoch, ...поляКоманды}`.
requestId — UUID, удовлетворяющий существующему IDEMPOTENCY_KEY_PATTERN; consumerId — UUID конкретного
локального окна, sessionEpoch — новый UUID native при принятом hello, навигации service-page или logout.
Native привязывает consumer через отдельную typed `chatBind`; пользовательское окно не назначает себе
epoch/адресат. Service-page обслуживает только актуальные привязки подтверждённого входа.
Результат/событие содержит consumerId/sessionEpoch; запросный результат также requestId и имя команды.
Native проверяет источник service-page, origin, главный фрейм, схему, epoch и зарегистрированный target;
затем пересылает результат только исходному локальному webContents, не broadcast всем окнам.
Смена входа/источника закрывает bindings, отменяет чтение и очищает pending/cache/UI прежнего пользователя.
Поздний ответ старого epoch не попадает в новый UI, даже если совпали userId или chatId.

## 6. Конкретные команды и существующий REST

Все числовые ID — положительные safe integer; строки/объекты строго проверяются с обеих сторон.
Следующие data-типы берутся из packages/shared/src/chat.ts без переименования или выдуманных полей:

| Новая команда | Вход помимо envelope | Вызов service-page | data успешного результата |
|---|---|---|---|
| chatBind | нет; envelope назначен native для зарегистрированного окна | привязка к текущему подтверждённому входу | `{ok:true}` |
| chatUnbind | нет | удалить binding, viewState и его ожидания | `{ok:true}` |
| chatList | нет | GET `/api/chats` | `ChatList` |
| chatDetail | chatId | GET `/api/chats/:id` | `ChatDetail` |
| chatMessages | chatId; необязателен ровно один before/after/around | GET `/api/chats/:id/messages` с выбранным курсором | `ChatMessagePage` |
| chatSend | chatId, text | POST `/api/chats/:id/messages`, `{text}` | `ChatMessage` |
| chatRead | chatId, upTo | POST `/api/chats/:id/read`, `{upTo}` | `{ok:true}` |
| chatViewState | chatId:number\|null, visible, focused | локальное состояние service-handler, API не нужен | `{ok:true}` |
| chatOpenWeb | chatId, messageId?:number | проверка доступа через chatDetail; fixed `/chat/:id?m=:mid` | `{link:string}` |
| chatCancel | targetRequestId | AbortController только соответствующего чтения/binding | `{ok:true}` |

chatOpenWeb возвращает только построенный внутренний путь: системный браузер или web-окно выбирает Desktop;
не принимать произвольную ссылку/протокол/путь. Сообщение открывается native через around=messageId;
нет доступа/сообщение исчезло — честная ошибка или доступный разговор, без выдачи чужих данных.
История: CHAT_PAGE=50, items старые сверху; использовать hasMore/hasNewer, не считать номер ID смещением.
Отправка: trim и max4000 по текущей shared-схеме, не HTML; в этой итерации без replyTo/fileIds/cards/stickerId.
Read отправляется только для действительно показанного активного разговора до просмотренного сообщения,
не по получению push и не при hidden/minimized; серверное ограничение upTo последним сообщением остаётся.

## 7. Повторы, ошибки и ресурсные пределы

chatSend передаёт requestId заголовком Idempotency-Key; UI хранит неизменный payload и ключ до результата.
При неопределённом исходе показывается «Не подтверждено», а не «Не отправлено». Явный повтор той же
отправки использует тот же ключ; новый текст/разговор/новая отправка — новый UUID. Автоочереди нет.
Текущий API помнит ключ сутки и при том же ключе в том же чате возвращает исходное сообщение даже
для изменённого текста: нельзя обещать серверный payload-conflict. После суток автоматический retry запрещён.
Ответ POST и socket push объединяются по ChatMessage.id; повтор события не удваивает строку.
Запросы чтения имеют timeout15с и отмену; abort/timeout мутации не доказывает откат серверной записи.
Не больше8 pending на consumer, не больше1 send на чат; переполнение — `busy`, без бесконечной очереди.
Bind/unbind/cancel — отдельные служебные сообщения; заполненные8 слотов не должны мешать отмене/очистке.
Новые bridge-пределы: JSON envelope до2MiB UTF-8, страница до50 сообщений, список до1000 разговоров,
одиночный realtime-event до512KiB. Превышение — `payload_too_large` и fallback веба, не усечённый «успех».
Ошибки: `{ok:false,error:string,code:string,retryable:boolean}`; текст короткий и без секретов/stacktrace.
Коды: network_unavailable/timeout (retryable для чтения; send только явный повтор прежнего ключа),
unauthenticated/password_change_required/forbidden/not_found/read_only/validation/idempotency_conflict,
cancelled/stale_session/busy/payload_too_large/unsupported_capability (без автоматического повтора send).
API-код сохраняется, когда известен; transport/service ошибки нормализуются явно, не распознаются по тексту.

## 8. Realtime, reconnect и локальный видимый разговор

Service-page подписывается на CHAT_EVENTS до выдачи первого снимка. Для MVP отправляет typed chatChanged
с областью list/detail/messages, chatId при наличии и причиной message/update/read/list/reconnected.
Реакции/pin/poll могут инвалидировать соответствующий разговор, не обещая native-функции управления ими.
Событие адресуется каждому связанному consumer того же epoch; heartbeat/секреты/сырые socket-объекты не идут.
Изменение во время initial fetch помечает снимок требующим повторного чтения. Coalesce до250мс,
максимум один выполняющийся refresh на область/чат. После reconnect перечитывать список, detail и
активное окно истории; сервер не даёт durable replay cursor — не обещать восстановление только push-событиями.
chatViewState заменяет pathname-критерий подавления уведомлений только для service-page этого native:
подавлять popup данного чата, когда любой его consumer видим и focused; другие чаты и упоминания —
по прежним правилам Teams/Focus/DND. При hide/blur/logout/unbind состояние сбрасывается.
Не менять поведение обычного браузера и не глушить все уведомления только из-за скрытого service-window.

## 9. Приёмка и передача

- [ ] Старый Desktop1.1 сохраняет прежние команды; нет capability — native не вызывает chat-команды.
- [ ] В общем shared-файле согласованы Д5 и chatUi; source commit/blob SHA совпадает у сторон.
- [ ] Список,50 сообщений, before/after/around и удалённое целевое сообщение работают без потерь/дубликатов.
- [ ] Два ПК: новое, правка, удаление, unread/read обновляются; сокет+POST не дублируют сообщение.
- [ ] Потеря ответа send: прежний ключ даёт исходное сообщение; изменение текста создаёт новый ключ.
- [ ] Offline/reconnect перечитывает пропущенное; нет скрытой очереди/повтора send после суток.
- [ ] Logout, истёкшая сессия, смена прав, чужой чат: UI очищается/показывает ошибку, поздний epoch отвергается.
- [ ] Два consumer: ответы не перепутаны, закрытый target не получает данные; cancel не заявляет rollback.
- [ ] Native active chat не дублируется popup; другой чат уведомляет; hide/blur возвращает уведомления.
- [ ] Focus/DND и обычный web сохранены; rich-сообщения видны fallback-строкой с доступным переходом в веб.
- [ ] Cookie/CSRF/пароль не пересылаются в main/local renderer/логи; неизвестный origin/frame/command отклонён.
- [ ] Лимиты pending/payload и ошибки проверены; в журналах нет текстов сообщений и бинарных данных.

Ответ исполнителя: `tasks/replies/SERVER-CHAT-001.md` в ветке обмена после передачи утверждённого задания.
Приложить серверную ветку/commit/PR, окончательный единый shared-файл и его blob SHA, capabilities,
описание service-page/входа/совместимого выпуска, примеры запросов/ответов и unit/integration/E2E отчёт.
Desktop-интеграция, визуальный UI и ручная приёмка выполняются отдельно; готовность сервера не равна готовности чата.
