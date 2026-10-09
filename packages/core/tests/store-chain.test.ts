// Порядок записей в хранилище моста. Путь относительный: модуль чистый, без @/. Через
// store-chain пишут снимок и журнал, и ломка порядка тут — молчаливая потеря правок.

import { describe, expect, it } from 'vitest'

import { serial, serialWrite } from '../src/core/store-chain'

describe('порядок записей', () => {
  it('вторая задача ждёт завершения первой, а не идёт рядом', async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = serial(async () => {
      log.push('старт-1')
      await gate
      log.push('конец-1')
    })
    const second = serial(async () => {
      log.push('старт-2')
    })

    // Пока первая висит на gate, вторая не начиналась.
    await Promise.resolve()
    expect(log).toEqual(['старт-1'])

    release()
    await Promise.all([first, second])

    expect(log).toEqual(['старт-1', 'конец-1', 'старт-2'])
  })

  it('серия одновременных вызовов идёт по порядку, и все доходят', async () => {
    const order: number[] = []
    const tasks = Array.from({ length: 10 }, (_, i) =>
      serial(async () => {
        order.push(i)
        return i * 2
      }),
    )

    const results = await Promise.all(tasks)

    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('отказ не рвёт цепочку', () => {
  it('упавшая задача не блокирует следующую', async () => {
    const log: string[] = []

    const bad = serial(async () => {
      log.push('плохая')
      throw new Error('сломалось')
    })
    const good = serial(async () => {
      log.push('хорошая')
      return 42
    })

    // Вызов плохой задачи видит отказ, а следующая при этом отработала.
    await expect(bad).rejects.toThrow('сломалось')
    await expect(good).resolves.toBe(42)
    expect(log).toEqual(['плохая', 'хорошая'])
  })

  it('каждый вызов получает исход своей задачи', async () => {
    await expect(serial(async () => 'ок')).resolves.toBe('ок')
    await expect(
      serial(async () => {
        throw new Error('свой отказ')
      }),
    ).rejects.toThrow('свой отказ')
  })
})

describe('serialWrite', () => {
  it('пишет по порядку так же, как serial', async () => {
    const log: string[] = []
    await serialWrite(async () => {
      log.push('а')
      await Promise.resolve()
      log.push('б')
    })
    await serialWrite(async () => {
      log.push('в')
    })

    expect(log).toEqual(['а', 'б', 'в'])
  })
})
