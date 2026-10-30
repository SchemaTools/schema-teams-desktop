const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export const U = {
  pickFiles: 'Прикрепить файл',
  attachments: 'Вложения к сообщению',
  limits: 'До 10 файлов в сообщении, каждый — не больше 50 МБ',
  uploading: 'Загрузка вложений…',
  uploadBusy: 'Дождитесь окончания загрузки вложения.',
  tooMany: 'В одном сообщении может быть не больше 10 файлов.',
  noClipboardImage: 'В буфере обмена нет доступной картинки. Скопируйте её ещё раз.',
  remove: (name: string) => `Убрать ${name}`,
  fileSize: (bytes: number) =>
    bytes < 1024
      ? `${number.format(bytes)} байт`
      : bytes < 1024 * 1024
        ? `${number.format(bytes / 1024)} КБ`
        : `${number.format(bytes / (1024 * 1024))} МБ`,
} as const;
