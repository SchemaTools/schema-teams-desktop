// Единственная операция utility process — stat одного проверенного UNC-пути.
// Parent убивает процесс через 3 с, включая зависший сетевой вызов libuv.
import { stat } from 'node:fs/promises';
import { validateUncPath } from './validate';

process.parentPort.once('message', async (event: { data: unknown }) => {
  const raw = event.data;
  const path = raw && typeof raw === 'object' && 'path' in raw ? validateUncPath(raw.path) : null;
  if (!path) {
    process.parentPort.postMessage(null);
    return;
  }
  try {
    const info = await stat(path);
    process.parentPort.postMessage(
      info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null,
    );
  } catch {
    // Ошибки доступа и сети не передаются странице и не раскрывают окружение.
    process.parentPort.postMessage(null);
  }
});
