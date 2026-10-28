// Только для проверки принудительного завершения utility process, без файлов/сети.
globalThis.process.parentPort.on('message', () => {});
globalThis.setInterval(() => {}, 60000);
