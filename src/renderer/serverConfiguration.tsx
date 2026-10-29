import { useEffect, useRef, useState } from 'react';
import type { ServerCheck, ServerConfiguration } from '../shared/serverConfiguration';
import { configuredServer } from '../shared/serverConfiguration';
import { request } from './bridge';
import './serverConfiguration.css';
export function ServerConfigurationPanel({
  onChecked,
}: { onChecked?: (current: boolean) => void } = {}) {
  const [config, setConfig] = useState<ServerConfiguration | null>(null),
    [url, setUrl] = useState(''),
    [proof, setProof] = useState<ServerCheck | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true),
    generation = useRef(0),
    flight = useRef(false);
  useEffect(() => {
    alive.current = true;
    void request({ kind: 'server.read' }).then((result) => {
      if (!alive.current) return;
      if (result.ok) {
        setConfig(result.data);
        setUrl(result.data.url);
      } else setError(result.error);
    });
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function check() {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setProof(null);
    onChecked?.(false);
    setConfirmed(false);
    setError('');
    const ticket = ++generation.current;
    const result = await request({ kind: 'server.check', url });
    flight.current = false;
    if (!alive.current) return;
    setPending(false);
    if (ticket !== generation.current) return;
    if (result.ok) {
      setProof(result.data);
      onChecked?.(result.data.url === config?.url);
    } else setError(result.error);
  }
  async function apply() {
    if (flight.current || !proof || !confirmed) return;
    flight.current = true;
    setPending(true);
    setError('');
    const result = await request({ kind: 'server.apply', url, token: proof.token });
    flight.current = false;
    if (!alive.current) return;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      setProof(null);
      setConfirmed(false);
    }
  }
  const changed = proof && configuredServer(url)?.origin !== config?.url;
  return (
    <section className="server-config" aria-label="Подключение к Schema Teams">
      <h4>Подключение к Schema Teams</h4>
      <p>Меняйте адрес только по просьбе администратора.</p>
      {config?.notice && (
        <p role="alert" className="preferences-error">
          {config.notice}
        </p>
      )}
      <label>
        Адрес сервера
        <input
          type="url"
          aria-label="Адрес сервера"
          value={url}
          maxLength={2048}
          placeholder="https://teams.example.test"
          disabled={!config || config.locked}
          onChange={(event) => {
            setUrl(event.target.value);
            generation.current++;
            setProof(null);
            onChecked?.(false);
            setConfirmed(false);
            setError('');
          }}
        />
      </label>
      {config?.locked && (
        <p className="preferences-hint">
          Адрес задан окружением запуска и доступен только для чтения.
        </p>
      )}
      <button disabled={pending || !config || !url.trim()} onClick={() => void check()}>
        {pending ? 'Подождите…' : 'Проверить связь'}
      </button>
      {proof && (
        <p role="status" className="preferences-feedback">
          ✓ Сервер отвечает, версия {proof.version}.{!changed ? ' Используется этот адрес.' : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="preferences-error">
          {error}
        </p>
      )}
      {changed && !config?.locked && (
        <div className="server-apply">
          <p>
            После применения окно откроется заново, потребуется вход в Teams. Черновики и
            незаписанные интервалы будут закрыты. Серверный таймер продолжит работу; завершите и
            запишите его заранее при необходимости.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Подтверждаю смену адреса и закрытие несохранённых данных
          </label>
          <button disabled={pending || !confirmed} onClick={() => void apply()}>
            Применить адрес и выйти из Teams
          </button>
        </div>
      )}
    </section>
  );
}
