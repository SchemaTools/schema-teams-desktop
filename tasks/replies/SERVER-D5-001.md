# Ответ на SERVER-D5-001 — безопасное управление таймером из Desktop

Статус: **сделано на сервере через API, без моста 1.2**; ждёт выпуска Teams 0.12.1, интеграции в Desktop и проверки
на стенде с двух компьютеров.
Дата: 30.10.2026. Исполнитель — ответственный за сервер Schema Teams. Код Desktop не менялся.

Основание: «Постановка 0.12.1 — сервер для настольного приложения», раздел 6 (в репозитории сервера
`docs/tz/postanovka-0.12.1.md`), которая по решению руководителя от 29.10 (К8) заменяет это задание как источник
требований к серверу. Задание переписано **без моста**: решение К7 от 29.10 — по ТЗ Desktop v4 главный процесс сам
вызывает API по cookie, как для чата; решение Д1 от 29.10 — окна «Выбор задачи» и «Закончить работу» рисует приложение.

## 1. Ветка, PR, версия

| | |
|---|---|
| Репозиторий | `SchemaTools/schema-teams` |
| Ветка этапа | `stage/e15` (от метки `0.12.0`), выпуск — метка `0.12.1` |
| PR-5 «Таймер из приложения через API» | #155, ветка `e15/timer`, слияние `b3e08baa38d9ed51064aaa495c492540895d90d7` |
| Сквозная проверка «клиент без браузера» | #156, ветка `e15/final` (PR-6) |
| Миграция | `20261030750500_timer_api` — таблицы `timer_request`, `timer_notice_ack` |
| Версия Teams | **0.12.1** — все пункты ниже; версия — поле `version` в `GET /api/health` |
| Признак готовности | `capabilities.timerControl: 2` в `GET /api/desktop/config` (объявлен после миграции и полного прогона) |

## 2. Что изменено против задания

| Задание | Сделано |
|---|---|
| Договор моста 1.2, `GET /api/desktop/capabilities`, capabilities в `hello` | **Не делается** (К7). Мост остаётся **1.1**, `packages/shared/src/desktop-bridge.ts` не менялся — blob `21bb1258ab9f82b05786e1ba11f58f7ec4fa56f6` (тот же, что проверен в задании). Возможности — `GET /api/desktop/config` → `capabilities` |
| `bureau: {timeZone, workday: {end: 1080}}`, `serverNow` в `hello` | `GET /api/desktop/config` → `bureau: {timeZone, workEnd: "18:00"}` (строка «ЧЧ:ММ», не минуты), `serverNow`. Отдельных `timerNoticeDelivery`, `bureauTime` нет: `bureau` и `serverNow` есть всегда, уведомления — в `timerControl: 2` |
| Команды `prepareFinish`, `timerNotice` моста; `code` / `retryable` в `DesktopCommandResult` | Не делаются: приложение вызывает API само. Код ошибки — `error.code` ответа API (формат ошибок сервера); сеть и повторы — забота клиента |
| `/desktop/finish?prepare=<requestId>` | Окно «Закончить работу» — в приложении по `prepare-finish` / `prepared` / `validate-rows`. Страницы `/desktop/pick` и `/desktop/finish` остаются для старых сборок 1.1 |
| — | Добавлены `POST /api/time/timer/validate-rows` и `GET /api/time/timer/pick-list` (для окон в приложении, Д1) |

## 3. API и общий тип

Общий файл — **`packages/shared/src/time-timer.ts`** (blob `1d41c38bc6e39d88e1ba9786cc25adcfaa473975` на `stage/e15`
`b3e08ba`): `TimerSnapshot`, `TimeTimerPush`, `TimerExpected` / `timerExpected`, `TimerPrepared`, `TimerRowsCheck`,
`TimerPickList`, `TimerNoticePending`, `timerNoticeAckInput`, `timerPushOf`, `timerExpectedOf`, `TIMER_ERROR_CODES`,
`TIMER_EVENT_SKEW_MS`. `packages/shared/src/notifications.ts` (blob `b1df7d25d46b1f89a9d84ba8a4348970319967a0`):
`NotificationPush.kind`, `NotificationPush.notificationId`. `packages/shared/src/desktop-config.ts`
(blob `6c7bbbfb8e874ee504f1c4a1230f394b2a635d77`): `DesktopConfig`.

Все изменяющие запросы: cookie `st_session`, `x-csrf-token`, **`Idempotency-Key`** (8–100 символов
`[A-Za-z0-9._:-]`, обязателен), `expected` в теле.

| Метод и маршрут | Вход → результат |
|---|---|
| GET `/api/time/timer` | снимок |
| POST `/api/time/timer/start` | `{taskId, expected}` (`null` — «таймера нет») → снимок; таймер на другой задаче — 409 `timer_running` |
| POST `/api/time/timer/pause` | `{expected, at?, reason?}` (`reason` — `lock` / `manual`, по умолчанию `manual`) → снимок |
| POST `/api/time/timer/resume` | `{expected}` → снимок (новый интервал с «сейчас» сервера, не раньше конца прошлого) |
| POST `/api/time/timer/extend` | `{expected}` → снимок («+ 15 мин») |
| POST `/api/time/timer/prepare-finish` | `{expected, at?}` → `TimerPrepared`; ничего не пишет и не ставит на паузу |
| GET `/api/time/timer/prepared/:requestId` | сохранённая подготовка своего пользователя → `TimerPrepared` |
| POST `/api/time/timer/validate-rows` | `{preparedRequestId, rows}` → `TimerRowsCheck`, без записи |
| POST `/api/time/timer/finish` | `{expected, rows, note?, preparedRequestId?}` → снимок; запись одной транзакцией |
| DELETE `/api/time/timer` | `{expected}` → снимок (сброс без записи) |
| GET `/api/time/timer/pick-list?q=` | `TimerPickList` — те же задачи, что окно сайта |
| GET `/api/desktop/timer-notices/pending?deviceId=<uuid>` | `TimerNoticePending` `{item: NotificationItem \| null}` |
| POST `/api/desktop/timer-notices/ack` | `{deviceId, notificationId}` → `{ok: true}`; идемпотентно, колокольчик не трогает |

Событие сокета — **`time:timer`** (в задании названо `timer`), тело — `TimeTimerPush`, всем компьютерам пользователя
после каждого изменения, после фиксации транзакции.

### Примеры

```json
GET /api/time/timer
{"timer":{"version":7,"state":"run","pauseReason":null,"task":{"...":"…"},"segments":[{"from":"2026-10-27T10:30:00.000Z","to":null}],
          "startedAt":"2026-10-27T09:00:00.000Z","updatedAt":"…","serverNow":"2026-10-27T12:00:00.000Z"},
 "state":"run","task":{"id":41,"mark":"АР1","title":"Объект А"},"startedAt":"2026-10-27T09:00:00.000Z","elapsedSec":10800,
 "reason":null,"timerId":314,"revision":7,"currentSegment":{"from":"2026-10-27T10:30:00.000Z"},"pausedAt":null,
 "serverNow":"2026-10-27T12:00:00.000Z"}
```

Без таймера — `"timer": null, "state": "idle"`, `timerId`, `revision`, `currentSegment`, `pausedAt` — `null`, `serverNow` есть.
На паузе — `currentSegment: null`, `pausedAt` — конец последнего закрытого интервала. Время — UTC ISO с миллисекундами.

```json
POST /api/time/timer/pause        Idempotency-Key: 7ce8b8a3-55ed-42e7-9749-563b6c75284b
{"expected":{"timerId":314,"revision":7,"currentSegmentFrom":"2026-10-27T10:30:00.000Z"},
 "at":"2026-10-27T12:00:00.000Z","reason":"lock"}

POST /api/time/timer/prepare-finish   Idempotency-Key: 2b1c…
{"expected":{…},"at":"2026-10-27T12:00:00.000Z"}
→ {"requestId":"2b1c…","task":{…},"segments":[{"from":"…","to":"2026-10-27T12:00:00.000Z"}],"elapsedSec":10800,
   "rows":[{"taskId":41,"date":"2026-10-27","from":540,"to":720}],"today":"2026-10-27",
   "expected":{"timerId":314,"revision":7,"currentSegmentFrom":"2026-10-27T10:30:00.000Z"},
   "cutoffAt":"2026-10-27T12:00:00.000Z","problems":[],"expiresAt":"2026-10-28T12:00:00.000Z","serverNow":"…"}

POST /api/time/timer/validate-rows   {"preparedRequestId":"2b1c…","rows":[…]}
→ {"ok":false,"problems":[{"row":0,"field":"from","message":"На это время уже есть запись: 10:00–10:30, КР"}],"hours":3}

событие notification: {"item":{…,"event":"timer_stopped",…},"quiet":false,"kind":"timer_stopped","notificationId":812}
```

### Ошибки (`TIMER_ERROR_CODES`)

| Код | HTTP | Когда | Повторять автоматически |
|---|---|---|---|
| `stale_timer` | 409 | другой таймер, другая версия, таймера нет или он есть при `expected: null`; подготовка не совпадает с таймером | нет |
| `stale_timer_segment` | 409 | версия та же, а открытый интервал другой; `at` раньше начала открытого интервала | нет |
| `idempotency_conflict` | 409 | тот же ключ с другим действием или телом; ключ подготовки в `finish` | нет |
| `precondition_required` | 428 | нет `expected` или ключа (старая вкладка) — «Обновите страницу» | нет |
| `invalid_event_time` | 400 | `at` в будущем дальше 5 с или составлен неверно | нет |
| `prepared_expired` | 404 | подготовки нет, срок вышел или чужая — «Подготовка „Закончить работу“ устарела. Проверьте данные.» | нет |
| `forbidden` / 401 | 403 / 401 | права, вход, CSRF — как у остального API | нет |

```json
{"error":{"code":"stale_timer","message":"Таймер изменён на другом устройстве. Обновите данные."}}
```

Сетевой сбой без ответа — повтор с **тем же** ключом безопасен: вернётся сохранённый ответ.

## 4. Принятые и изменённые предложения

| Предложение задания | Решение |
|---|---|
| CAS по `timerId` + `revision` (= `WorkTimer.version`) + `currentSegmentFrom` в той же транзакции | принято; блокировка пользователя `pg_advisory_xact_lock`, повторная проверка ключа под ней |
| `expected` у pause / prepare-finish / resume / finish / reset | принято; добавлено и у `extend` |
| `at` закрывает интервал именно этим временем; раньше — 409, будущее — 400 | принято; допуск будущего — 5 с (задержка сети при пересчёте по `serverNow`); прежняя подстановка «сейчас» удалена |
| Идемпотентность: бюро + пользователь + ключ, хеш, код и ответ, 24 часа | принято; хеш — sha-256 разобранного тела с ключами по алфавиту и действием; **хранятся только успешные ответы** (ошибка ничего не меняет и откатывается — повтор с тем же ключом проверяется заново); старые записи удаляются в транзакции следующего запроса пользователя и всех — в полночь |
| prepare-finish без записи, хранение по `requestId` | принято; срок — 24 часа и пока таймер той же версии; подготовок может быть несколько (два компьютера) — запишет первая, вторая получит 409 |
| Доставка `timer_stopped` на каждое устройство (`pending` / `ack`) | принято; только самое новое непрочитанное, более старые не показываются; подтверждения удаляются каскадом с уведомлением |
| Старый клиент 1.1 | свежая ручная команда без `at` — как раньше (страница передаёт свой снимок и `requestId` команды как `Idempotency-Key`); отложенная пауза со временем раньше текущего интервала — 409; старая вкладка без `expected` — 428 |
| Мост 1.2, capabilities в hello, `code`/`retryable` в результате команды | не делается (К7) — см. раздел 2 |

## 5. Порядок совместимого выпуска

1. Сервер 0.12.1 (миграция `timer_api` применяется при запуске). Существующие таймеры и записи не переписываются
   и не округляются заново.
2. Сайт и старые сборки Desktop 1.1 работают сразу: страница передаёт `expected` и ключ сама.
3. Новый Desktop включает Д5 только при `capabilities.timerControl >= 2`; без него — прежний интерфейс 1.1 (Д3/Д4).

## 6. Отчёт тестов

- PR-5 (`ba4d2425b2d61d3274a3ffa7b6d04eafd5c80930`, влиты PR-1…PR-4): `vitest` — 168 файлов, 8571 пройдено, 4 пропущено;
  e2e — 155 пройдено, 3 пропущено. Новые тесты — `apps/server/src/modules/time/timer-api.test.ts` (22): приёмка 10–15
  этого задания (блокировка → одна пауза с исходным временем; старая пауза после `resume` на втором компьютере → 409;
  снимок A не меняет B; повтор `finish` A после старта B; одинаковый ключ, параллельные запросы, потерянный ответ;
  ключ с другим телом → 409; подготовка сохраняет `cutoffAt` и ничего не пишет; `validate-rows`; `pick-list`;
  полночь и `pending` / `ack` с двух устройств; старая вкладка → 428), гонки разных ключей на одном снимке и
  параллельные «Записать»; обновлены `timer.test.ts`, веб `time-timer.test.tsx`, `desktop.test.tsx` (отложенная пауза
  моста 1.1 → 409), e2e `e9-timer`, `v012-header`.
- PR-6 (`apps/server/src/modules/desktop/headless-client.test.ts`): таймер из «клиента без браузера» — `start` с
  повтором ключа, `pause` с `reason`, устаревший `expected` → 409, `resume`, сброс, `pick-list`, `pending`; событие
  `time:timer` по Socket.IO с cookie; без `Origin` / `Referer`. Полный прогон на `5069884` (stage/e15 + PR-6): `vitest` — 169 файлов, 8577 пройдено, 4 пропущено; e2e — 155 пройдено, 3 пропущено; format, lint, typecheck, build, privacy — зелёные.

## 7. Оставшиеся ограничения

- **Проверки на стенде с двух компьютеров не было** — только автоматические тесты сервера (два сеанса одного
  пользователя). Нужна ручная приёмка Desktop на стенде.
- Окна «Выбор задачи» и «Закончить работу» в приложении — работа Desktop; вид — по макету Desktop (если в макете v4
  их нет — макет на согласование руководителю до кода).
- `deviceId` не авторизация: чужое устройство того же пользователя может подтвердить показ за другое — безвредно.
- Ошибочные ответы не сохраняются: повтор после 409 с тем же ключом даст новую проверку (тот же 409, если состояние не
  изменилось). Клиент не должен автоматически повторять детерминированные ошибки.
- Граница суток и часы клиента: строки считаются по поясу бюро (`GET /api/desktop/config` → `bureau.timeZone`);
  Desktop приводит время события к шкале сервера по `serverNow`.
- `GET /api/time/timer/proposal` оставлен для старых вкладок; новому клиенту — `prepare-finish`.
