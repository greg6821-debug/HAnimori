// Ограничитель темпа к внешним источникам. Проверяется здесь, а не в наборах экранов:
// те снимают ожидание заглушкой instant-pace, потому что ждать по две секунды между
// запросами ради проверки календаря незачем. Здесь ожидания — часть предмета.

import { describe, expect, it, vi } from 'vitest'

import { RateLimitError, createRateLimiter, once } from '@/api/rate-limit'

/** Потолок, от которого считается производный промежуток: окно делим на него. */
const WINDOW = 60000

describe('промежуток между запросами', () => {
  it('первый слот выдаётся сразу, без ожидания', async () => {
    // Часы здесь настоящие намеренно: проверка утверждает, что первый слот проходит
    // без ожидания на живом времени, а не на поддельных часах, где всякое проходит.
    const limiter = createRateLimiter({
      name: 'Первый',
      minIntervalMs: 50,
      windowMs: WINDOW,
      maxPerWindow: 30,
    })

    // Если бы первый запрос ждал, проверка упала бы по таймауту.
    await limiter.acquireSlot()
  })

  it('второй запрос ждёт промежуток, а не проходит сразу', async () => {
    vi.useFakeTimers()

    try {
      // Часы вперёд: счётчик залпа общий на модуль и помнит отметки прошлых случаев,
      // а назад он не почистился бы и ждал вечно.
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

      const limiter = createRateLimiter({
        name: 'Второй',
        minIntervalMs: 1000,
        windowMs: WINDOW,
        maxPerWindow: 30,
      })

      await limiter.acquireSlot()

      // Обещание не должно разрешиться, пока часы стоят: иначе темпа нет.
      let released = false
      const waiting = limiter.acquireSlot().then(() => {
        released = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)
      await waiting
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('интервал от потолка длиннее заданного минимума, а не короче', () => {
    // 60 000 / 30 = 2000 мс, и минимум в 100 мс тут не должен ужимать его.
    const limiter = createRateLimiter({
      name: 'От потолка',
      minIntervalMs: 100,
      windowMs: WINDOW,
      maxPerWindow: 30,
      deriveInterval: true,
    })

    expect(limiter.stats().intervalMs).toBe(2000)
  })

  it('без производного интервала берётся заданный минимум', () => {
    const limiter = createRateLimiter({
      name: 'Минимум',
      minIntervalMs: 300,
      windowMs: WINDOW,
      maxPerWindow: 30,
    })

    expect(limiter.stats().intervalMs).toBe(300)
  })
})

describe('потолок окна', () => {
  it('исчерпание потолка растягивает запросы до конца окна', async () => {
    vi.useFakeTimers()

    try {
      // Часы уводим вперёд, а не назад: счётчик залпа общий на модуль и хранит отметки
      // прошлых случаев по реальному времени. Назад он бы не почистился и ждал бы вечно.
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

      const limiter = createRateLimiter({
        name: 'Потолок',
        minIntervalMs: 0,
        windowMs: WINDOW,
        maxPerWindow: 2,
      })

      await limiter.acquireSlot()
      await limiter.acquireSlot()
      expect(limiter.stats().remaining).toBe(0)

      // Третий слот уже не помещается: он ждёт освобождения окна.
      let released = false
      const waiting = limiter.acquireSlot().then(() => {
        released = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(false)

      // С запасом сверх окна: освобождение считается от самой старой отметки плюс запас.
      await vi.advanceTimersByTimeAsync(WINDOW + 100)
      await waiting
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('потолок по заголовкам сервера учитывается, но не выше предохранителя', () => {
    const limiter = createRateLimiter({
      name: 'Заголовки',
      minIntervalMs: 100,
      windowMs: WINDOW,
      maxPerWindow: 30,
      maxCeiling: 90,
    })

    limiter.applyCeiling(10)
    expect(limiter.stats().ceiling).toBe(10)

    // Предохранитель 90 — это потолок РОСТА по словам сервера, а не заморозка на 10:
    // сервер вправе сообщить о запасе своём лимите, и AniList именно так и отвечает.
    limiter.applyCeiling(5000)
    expect(limiter.stats().ceiling).toBe(90)
  })

  it('рост потолка после урезания не проходит, пока не истёк срок восстановления', () => {
    const limiter = createRateLimiter({
      name: 'Восстановление',
      minIntervalMs: 100,
      windowMs: WINDOW,
      maxPerWindow: 30,
      maxCeiling: 90,
    })

    limiter.reduceCeiling()
    expect(limiter.stats().ceiling).toBe(15)

    // Тот же ответ сервера, что минуту назад урезал потолок, сейчас не поднимет его обратно.
    limiter.applyCeiling(90)
    expect(limiter.stats().ceiling).toBe(15)
  })

  it('мусорный потолок игнорируется, а нулевой не обнуляет окно', () => {
    const limiter = createRateLimiter({
      name: 'Мусор',
      minIntervalMs: 100,
      windowMs: WINDOW,
      maxPerWindow: 30,
    })

    limiter.applyCeiling(0)
    limiter.applyCeiling(-5)
    limiter.applyCeiling(Number.NaN)

    expect(limiter.stats().ceiling).toBe(30)
  })

  it('после 429 потолок урезается вдвое, а не обнуляется', () => {
    const limiter = createRateLimiter({
      name: 'Отказ',
      minIntervalMs: 100,
      windowMs: WINDOW,
      maxPerWindow: 30,
    })

    limiter.reduceCeiling()

    // Половина от 30 — это 15, а не ноль: работа не должна встать вовсе.
    expect(limiter.stats().ceiling).toBe(15)
  })
})

describe('пауза', () => {
  it('после паузы запрос ждёт её конца', async () => {
    vi.useFakeTimers()

    try {
      // Как и выше: вперёд, чтобы общий счётчик залпа почистился отметками прошлых случаев.
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

      const limiter = createRateLimiter({
        name: 'Пауза',
        minIntervalMs: 0,
        windowMs: WINDOW,
        maxPerWindow: 30,
      })

      await limiter.acquireSlot()
      limiter.pause(5000)
      expect(limiter.isPaused()).toBe(true)

      let released = false
      const waiting = limiter.acquireSlot().then(() => {
        released = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(false)

      await vi.advanceTimersByTimeAsync(5000)
      await waiting
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('новая пауза не короче прежней: паузы только продлеваются', () => {
    vi.useFakeTimers()

    try {
      const limiter = createRateLimiter({
        name: 'Продление',
        minIntervalMs: 0,
        windowMs: WINDOW,
        maxPerWindow: 30,
      })

      limiter.pause(10000)
      limiter.pause(1000)

      expect(limiter.pauseRemaining()).toBe(10000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('счёт', () => {
  it('выданные слоты считаются', async () => {
    vi.useFakeTimers()

    try {
      // Как и в прочих случаях с ожиданием: залп общий на модуль, и к этому моменту
      // предыдущие случаи уже израсходовали его — на живых часах счёт упёрся бы в ожидание.
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

      const limiter = createRateLimiter({
        name: 'Счёт',
        minIntervalMs: 0,
        windowMs: WINDOW,
        maxPerWindow: 30,
      })

      const before = limiter.stats().sentTotal

      await limiter.acquireSlot()
      await limiter.acquireSlot()

      expect(limiter.stats().sentTotal - before).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ошибка про лимит отличается от прочих отказов по имени', () => {
    // Перебор зеркал ловит отказ по своему catch: без отдельного класса он бы проглотился.
    const error = new RateLimitError('AniList', 'graphql')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RateLimitError')
    expect(error.message).toContain('AniList')
  })
})

describe('один поход на ключ', () => {
  it('второй такой же вопрос получает тот же промис, а не идёт в сеть снова', async () => {
    let calls = 0

    const task = async (): Promise<number> => {
      calls += 1
      await Promise.resolve()
      return 7
    }

    const [first, second] = await Promise.all([once('ключ', task), once('ключ', task)])

    expect(first).toBe(7)
    expect(second).toBe(7)
    // Один поход вместо двух: четыре одинаковых вопроса — это четыре запроса в закрытую дверь.
    expect(calls).toBe(1)
  })

  it('ключ освобождается в любом исходе, иначе следующий вопрос не пошёл бы', async () => {
    await once('успех', async () => 1)
    await once(
      'провал',
      async () => {
        throw new Error('отказ похода')
      },
    ).catch(() => undefined)

    // Оба ключа свободны: новый поход по каждому обязан состояться.
    await expect(once('успех', async () => 2)).resolves.toBe(2)
    await expect(once('провал', async () => 3)).resolves.toBe(3)
  })

  it('разные ключи не блокируют друг друга', async () => {
    const [a, b] = await Promise.all([once('первый', async () => 'a'), once('второй', async () => 'b')])

    expect(a).toBe('a')
    expect(b).toBe('b')
  })

  it('задача, упавшая до первого ожидания, ключ не запирает', async () => {
    // Синхронный throw, а не отклонённый промис: ключ обязан освободиться сразу.
    const boom = (): Promise<number> => {
      throw new Error('сразу')
    }

    await expect(once('сразу-отказ', boom)).rejects.toThrow('сразу')
    await expect(once('сразу-отказ', async () => 5)).resolves.toBe(5)
  })
})
