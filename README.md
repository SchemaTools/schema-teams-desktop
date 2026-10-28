# Schema Teams Desktop

Настольное приложение для Windows 10/11 к системе управления проектами Schema Teams: значок в трее со счётчиком, уведомления Windows с быстрым ответом, открытие сетевых папок из чата, кнопки «Начать работу / Закончить работу» для учёта времени.

- ТЗ — [`docs/tz/README.md`](docs/tz/README.md)
- Интерактивный макет — `docs/mockups/` (открыть в браузере)
- Решения — [`docs/decisions.md`](docs/decisions.md)

Актуальное [ТЗ v4](https://github.com/SchemaTools/schema-teams-desktop/blob/cfff98f702a7b07027966f9e8032907ed3468751/docs/tz/2026-10-25%20%E2%80%94%20%D0%A2%D0%97%20Schema%20Teams%20Desktop%201.0_v4.md)
находится в `stage/d1`: собственный чат, клиент API и Socket.IO в главном процессе.
Руководитель готовит новый макет. Для дальнейшей разработки используется v4 и новый макет.

Эта ветка `codex/d5-timer` сохраняет пробную сборку **по прежнему ТЗ v2**:
напоминание, настройки времени и предупреждение после блокировки. Здесь ещё
используется веб-чат, поэтому готовность собственного интерфейса по v4 не заявляется.
Номер Д5 исторический: в v4 таймер относится к Д6, а Д5 — к плагинам Revit.
Автопауза и очередь ждут [SERVER-D5-001](https://github.com/SchemaTools/schema-teams-desktop/blob/codex/task-exchange/tasks/SERVER-D5-001.md).
Сверка версий — [`docs/v4-reconciliation.md`](docs/v4-reconciliation.md),
результаты этой сборки — [`docs/d5-status.md`](docs/d5-status.md).
