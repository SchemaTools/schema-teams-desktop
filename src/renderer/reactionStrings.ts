export const ReactionText = {
  label: 'Реакции',
  quick: 'Быстрые реакции',
  pending: 'Сохранение реакции…',
  names: {
    like: 'Нравится',
    done: 'Готово',
    look: 'Смотрю',
    heart: 'Сердце',
    laugh: 'Смешно',
    question: 'Вопрос',
    fire: 'Огонь',
    party: 'Поздравляю',
  },
  add: (name: string) => `Поставить реакцию «${name}»`,
  remove: (name: string) => `Снять реакцию «${name}»`,
  count: (name: string, count: number) => `${name}: ${count}`,
  bytes: (size: number) => `${new Intl.NumberFormat('ru-RU').format(size)} Б`,
} as const;
