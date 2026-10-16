#!/usr/bin/env bash
# Проверка, что в репозитории нет реальных данных бюро (ТЗ, раздел 13.7).
# Ищет: IP-адреса внутренних сетей, сетевые пути \\сервер\папка латиницей,
# адреса почты, закрытые ключи и токены. Запускается в CI и перед отправкой.
set -euo pipefail
# одинаковый результат на любом компьютере: без этого регистр кириллицы не сравнивается
export LC_ALL=C.UTF-8
cd "$(git rev-parse --show-toplevel)"

files=$(git -c core.quotepath=off ls-files | grep -vE '^scripts/check-private-data\.sh$' || true)
[ -z "$files" ] && exit 0

fail=0
check () {
  local name="$1" pattern="$2" allow="${3:-}"
  local hits
  hits=$(echo "$files" | xargs -d '\n' grep -nIP -e "$pattern" -- 2>/dev/null || true)
  if [ -n "$allow" ] && [ -n "$hits" ]; then hits=$(echo "$hits" | grep -vP -e "$allow" || true); fi
  if [ -n "$hits" ]; then
    echo "✕ $name:"; echo "$hits" | cut -c1-200; echo; fail=1
  fi
}

check "IP-адрес внутренней сети" '\b(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b'
check "сетевой путь" '\\\\[A-Za-z0-9_.-]+\\' '\\\\server\\'
# в package-lock.json — только открытые сведения реестра npm (адреса авторов пакетов)
check "адрес почты" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' '(^package-lock\.json:|noreply@|@example\.(com|org)|users\.noreply\.github\.com|fonts\.googleapis)'
check "закрытый ключ" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "токен" '\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b'
# токен доступа Schema Teams (решение от 13.10.2026): приставка stt_ и ровно 43 знака
check "токен доступа" '\bstt_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])'

# Список private/denylist.txt: строка — начало слова (основа фамилии, название, адрес),
# регистр не важен. «Иван» найдёт «Иванов» и «иванова», но не «диванов».
# Обычные слова с тем же началом («иван-чай») перечисляются началом слова
# в private/allowlist.txt. Оба файла в репозиторий не попадают.
if [ -f private/denylist.txt ]; then
  while IFS= read -r w; do
    w="${w%$'\r'}"
    [ -z "$w" ] && continue; case "$w" in \#*) continue;; esac
    hits=$(echo "$files" | xargs -d '\n' grep -onIiP -e "(?<!\\p{L})\\Q$w\\E[\\p{L}\\p{N}]*" -- 2>/dev/null || true)
    if [ -n "$hits" ] && [ -f private/allowlist.txt ]; then
      while IFS= read -r a; do
        a="${a%$'\r'}"
        [ -z "$a" ] && continue; case "$a" in \#*) continue;; esac
        hits=$(echo "$hits" | grep -viP -e ":\\Q$a\\E[^:]*\$" || true)
      done < private/allowlist.txt
    fi
    if [ -n "$hits" ]; then echo "✕ из списка private/denylist.txt («$w»):"; echo "$hits" | cut -c1-200; echo; fail=1; fi
  done < private/denylist.txt
fi

if [ "$fail" -ne 0 ]; then
  echo "Найдены реальные данные. Уберите их и замените заглушками (ТЗ, раздел 13.7)."; exit 1
fi
echo "✓ Реальных данных не найдено"
