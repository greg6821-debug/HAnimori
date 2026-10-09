// Хранилище источника Hentasis (18+): три слота «домен или ссылка», автопоиск
// по названиям с AniList (только первый слот), слияние файлов всех слотов.
// Суффикс домена в пометке не даёт группам разных зеркал склеиваться.

import { computed, reactive } from 'vue'

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { Logger } from '@/utils/logger'

import { fetchMediaCard } from '@/api/anilist-media'
import {
  autoFindHentasis,
  buildSearchQueries,
  getHentasisInfo,
  isTitlePageUrl,
  resolveHentasisDirect,
  assToCues,
  type HentasisFile,
  type HentasisSubtitle,
  type PageRequestInit,
} from '@/api/hentasis'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'

const LINKS_KEY = 'animori:hentasis-links'
const BASES_KEY = 'animori:hentasis-bases'

/** Домены по умолчанию: слот 1 — основной (автопоиск), слот 3 — пустой. */
const DEFAULT_BASES = ['https://v6.hentasis.me', 'https://hentasis1.top', '']

interface SavedLink {
  urls: (string | null)[]
  file?: number
}

export interface HentasisState {
  animeId: number
  /** Три домена поиска. */
  basesText: string[]
  /** Три ссылки на тайтлы. */
  manualUrls: string[]
  busy: boolean
  /** Слот, который сейчас работает: -1 — никто. */
  slotBusy: number
  trouble: string
  /** Нейтральное известие. */
  notice: string
  matchedTitles: string[]
  matchedUrls: string[]
  infoTitle: string
  files: HentasisFile[]
  picked: number
  open: boolean
  resolving: boolean
  subtitles: HentasisSubtitle[]
  others: { url: string; title: string }[]
}

const state = reactive<HentasisState>({
  animeId: 0,
  busy: false,
  slotBusy: -1,
  trouble: '',
  notice: '',
  matchedTitles: ['', '', ''],
  matchedUrls: ['', '', ''],
  manualUrls: ['', '', ''],
  basesText: ['', '', ''],
  infoTitle: '',
  files: [],
  picked: -1,
  open: false,
  resolving: false,
  subtitles: [],
  others: [],
})

/** Записи в localStorage двух поколений: { url, file } и { urls: […], file }.
 * Приводим к одному виду — массив из трёх слотов. */
function normalizeRecord(raw: unknown): SavedLink {
  const record = (raw ?? {}) as Partial<SavedLink> & { url?: string | null }

  const urls: (string | null)[] = [null, null, null]
  if (Array.isArray(record.urls)) {
    for (let i = 0; i < 3; i += 1) {
      const value = record.urls[i]
      urls[i] = typeof value === 'string' && value !== '' ? value : null
    }
  } else if (typeof record.url === 'string' && record.url !== '') {
    urls[0] = record.url
  }

  return { urls, file: typeof record.file === 'number' ? record.file : undefined }
}

function readLinks(): Record<string, SavedLink> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as unknown
    if (parsed === null || typeof parsed !== 'object') return {}

    const out: Record<string, SavedLink> = {}
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = normalizeRecord(value)
    }
    return out
  } catch {
    return {}
  }
}

function writeLinks(map: Record<string, SavedLink>): void {
  localStorage.setItem(LINKS_KEY, JSON.stringify(map))
}

function say(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function fetchPage(page: string, init?: PageRequestInit): Promise<string> {
  let referer = 'https://v6.hentasis.me/'
  try {
    referer = new URL(page).origin + '/'
  } catch {
    // оставить запасной
  }

  const res = await tauriFetch(page, {
    method: init?.method ?? 'GET',
    headers: {
      Referer: referer,
      'Accept-Language': 'ru,en;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: init?.body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Сайт ответил HTTP ${res.status} (${page})`)
  return res.text()
}

async function loadSubtitleCues(
  src: string,
): Promise<{ start: number; end: number; text: string }[]> {
  return assToCues(await fetchPage(src))
}

async function fetchTitles(
  mediaId: number,
): Promise<{ titles: string[]; year: number; adult: boolean }> {
  const card = await fetchMediaCard(mediaId)
  await prefetchRussianNames([mediaId]).catch(() => {})

  const titles = [card?.english, card?.romaji, card?.native, peekRussianName(mediaId)].filter(
    (t): t is string => typeof t === 'string' && t.trim() !== '',
  )
  return { titles, year: card?.seasonYear ?? 0, adult: card?.isAdult === true }
}

function resetResult(): void {
  state.trouble = ''
  state.notice = ''
  state.matchedTitles.splice(0, state.matchedTitles.length, '', '', '')
  state.matchedUrls.splice(0, state.matchedUrls.length, '', '', '')
  state.infoTitle = ''
  state.files = []
  state.picked = -1
  state.others = []
  state.subtitles = []
  state.resolving = false
}

/** Слот по адресу: какому домену принадлежит ссылка. */
function slotOf(url: string): number {
  for (let i = 0; i < state.basesText.length; i += 1) {
    const base = state.basesText[i]
    if (base === undefined || base === '') continue
    if (url.startsWith(base)) return i
  }
  return 0
}

/** Открывает страницу тайтла и ДОБАВЛЯЕТ её файлы к общему списку. */
async function loadSlot(slot: number, url: string, remember: boolean): Promise<boolean> {
  state.slotBusy = slot
  state.trouble = ''

  try {
    const info = await getHentasisInfo(url, fetchPage)
    state.matchedTitles.splice(slot, 1, info.title ?? url)
    state.matchedUrls.splice(slot, 1, url)

    if (remember) {
      const map = readLinks()
      const record = map[String(state.animeId)] ?? { urls: [null, null, null] }
      record.urls[slot] = url
      writeLinks(map)
    }

    const offset = state.files.length
    info.files.forEach((file, i) => {
      state.files.push({ ...file })
      if (state.picked < 0 && i === 0) state.picked = offset
    })

    return true
  } catch (e: unknown) {
    Logger('WARN', `Hentasis: слот ${slot + 1} не открылся (${url})`, e)
    state.matchedTitles.splice(slot, 1, '')
    state.matchedUrls.splice(slot, 1, '')
    if (state.trouble === '') state.trouble = `Домен ${slot + 1}: ${say(e)}`
    return false
  } finally {
    state.slotBusy = -1
  }
}

/** Автопоиск: только первый слот, только при метке 18+. */
async function runSearch(): Promise<void> {
  if (state.animeId === 0 || state.busy) return

  state.busy = true
  state.trouble = ''
  resetResult()

  try {
    const { titles, year, adult } = await fetchTitles(state.animeId)
    if (titles.length === 0) {
      state.trouble = 'Не достал названия тайтла — поиск невозможен. Вставь ссылку в слот 1.'
      return
    }

    if (!adult) {
      state.notice =
        'Метка 18+ на карточке не стоит — автопоиск не запускался. ' +
        'Считаешь нужным — вставь ссылку и нажми «Открыть».'
      return
    }

    const base = state.basesText[0]
    if (base === undefined || base === '') {
      state.trouble = 'Первый домен пуст — автопоиск не по чему вести.'
      return
    }

    const found = await autoFindHentasis([base], buildSearchQueries(titles), titles, fetchPage, {
      year: year > 0 ? year : undefined,
    })
    state.others = found.candidates
      .filter((c) => c.score > 0)
      .map(({ url, title }) => ({ url, title }))

    if (found.best === null) {
      state.trouble =
        `Похожего не нашлось (страниц поиска обошли: ${found.pages}). ` +
        'Вставь ссылку в слот 1 и нажми «Открыть».'
      return
    }

    state.manualUrls[0] = found.best.url
    const ok = await loadSlot(0, found.best.url, true)
    if (ok) state.infoTitle = state.matchedTitles[0] ?? ''
  } catch (e: unknown) {
    state.trouble = say(e)
  } finally {
    state.busy = false
  }
}

/** Слот: ссылка на тайтл — открываем, домен — ищем по нему. */
/** Слот: ссылка на тайтл — открываем, домен — ставим в слот и ищем по нему. */
async function openSlot(slot: number): Promise<void> {
  const raw = (state.manualUrls[slot] ?? '').trim()
  if (raw === '' || state.busy || state.slotBusy >= 0) return

  if (isTitlePageUrl(raw)) {
    state.trouble = ''
    await loadSlot(slot, raw, true)
    if (slot === 0) state.infoTitle = state.matchedTitles[0] ?? ''
    return
  }

  // Домен: без схемы пробуем https сами; не адрес вовсе — жалуемся.
  let origin: string
  try {
    origin = new URL(raw).origin.replace(/\/+$/, '')
  } catch {
    try {
      origin = new URL(`https://${raw}`).origin.replace(/\/+$/, '')
    } catch {
      state.trouble = 'Не похоже на адрес: нужен домен или ссылка на тайтл.'
      return
    }
  }

  state.basesText[slot] = origin
  localStorage.setItem(BASES_KEY, JSON.stringify(state.basesText))

  await searchDomain(slot)
}

/** Поиск по домену слота (кнопка «Найти»): файлы добавляются к общему списку. */
async function searchDomain(slot: number): Promise<void> {
  const base = (state.basesText[slot] ?? '').trim()
  if (base === '' || state.busy || state.slotBusy >= 0) return

  state.busy = true
  state.trouble = ''
  try {
    const { titles, year, adult } = await fetchTitles(state.animeId)
    if (titles.length === 0) {
      state.trouble = 'Не достал названия тайтла — поиск невозможен.'
      return
    }
    if (!adult) {
      state.notice = 'Метка 18+ на карточке не стоит — поиск не запускался.'
      return
    }

    const found = await autoFindHentasis([base], buildSearchQueries(titles), titles, fetchPage, {
      year: year > 0 ? year : undefined,
    })
    state.others.push(
      ...found.candidates.filter((c) => c.score > 0).map(({ url, title }) => ({ url, title })),
    )

    if (found.best === null) {
      state.trouble = `На ${base} похожего не нашлось (страниц: ${found.pages}).`
      return
    }

    state.manualUrls[slot] = found.best.url
    await loadSlot(slot, found.best.url, true)
  } catch (e: unknown) {
    state.trouble = say(e)
  } finally {
    state.busy = false
  }
}

function bindAnime(id: number): void {
  state.open = false
  if (state.animeId === id) return

  state.animeId = id
  state.manualUrls = ['', '', '']
  resetResult()
  if (id === 0) return

  // Домены: сохранённые три или дефолт (v6 первым).
  let saved: unknown
  try {
    saved = JSON.parse(localStorage.getItem(BASES_KEY) ?? 'null')
  } catch {
    saved = null
  }
  if (Array.isArray(saved) && saved.length === 3 && saved.every((b) => typeof b === 'string')) {
    state.basesText = saved as string[]
  } else {
    state.basesText = [...DEFAULT_BASES]
    localStorage.setItem(BASES_KEY, JSON.stringify(state.basesText))
  }

  const record = readLinks()[String(id)]
  if (record === undefined || record.urls.every((u) => u === null || u === '')) {
    void runSearch()
    return
  }

  // Восстановление: все сохранённые ссылки грузим параллельно.
  state.manualUrls = record.urls.map((u) => u ?? '')
  const jobs = record.urls
    .map((url, slot) => ({ url, slot }))
    .filter((job): job is { url: string; slot: number } => job.url !== null && job.url !== '')
    .map((job) => loadSlot(job.slot, job.url, false))

  void Promise.allSettled(jobs).then(() => {
    if (state.trouble !== '') {
      state.trouble = `Часть доменов не открылась (${state.trouble}). Нажми «Открыть» заново.`
    }

    // Выбранный ранее файл: помечаем и открываем сразу — автозапуск с последнего места.
    const fresh = readLinks()[String(id)]
    const savedFile = fresh?.file
    if (savedFile !== undefined && savedFile >= 0 && savedFile < state.files.length) {
      void play(savedFile)
    }
  })
}

function useCandidate(url: string): void {
  if (state.busy || state.slotBusy >= 0) return

  const slot = slotOf(url)
  state.manualUrls[slot] = url
  resetResult()
  void loadSlot(slot, url, true).then(() => {
    if (slot === 0) state.infoTitle = state.matchedTitles[0] ?? ''
  })
}

async function play(index: number): Promise<void> {
  const file = state.files[index]
  if (file === undefined) return

  state.picked = index

  const map = readLinks()
  const record = map[String(state.animeId)]
  if (record !== undefined) {
    record.file = index
    writeLinks(map)
  }

  if (file.kind === 'iframe') {
    state.resolving = true
    state.trouble = ''
    try {
      const direct = await resolveHentasisDirect(file.url, fetchPage)
      Logger('INFO', `Hentasis: файл разыменован (${direct.kind}) → ${direct.url}`)
      state.files[index] = { ...file, url: direct.url, kind: direct.kind }
      state.subtitles = direct.subtitles
    } catch (e) {
      state.trouble = say(e)
      Logger('WARN', 'Hentasis: разыменование не удалось', e)
      return
    } finally {
      state.resolving = false
    }
  } else {
    state.subtitles = []
  }

  state.open = true
}

function close(): void {
  state.open = false
}

function forget(): void {
  const map = readLinks()
  delete map[String(state.animeId)]
  writeLinks(map)
  state.manualUrls = ['', '', '']
  void runSearch()
}

/** Группы файлов по пометке; домен файла — в ключ, но не в подпись:
 * одинаковые озвучки разных зеркал не склеиваются, а видит человек чистую метку. */
const groups = computed(() => {
  const byNote = new Map<
    string,
    { key: string; label: string; items: { index: number; file: HentasisFile }[] }
  >()

  state.files.forEach((file, index) => {
    const note = file.note ?? ''
    const domain = (() => {
      try {
        return new URL(file.url).hostname
      } catch {
        return file.url
      }
    })()
    // Домен — в ключ (одинаковые озвучки разных зеркал не склеиваются),
    // но не в подпись: человеку всё равно, откуда файл.
    const key = note === '' ? `\u0000${index}` : `${note}@@${domain}`
    const found = byNote.get(key)
    if (found !== undefined) found.items.push({ index, file })
    else byNote.set(key, { key, label: note === '' ? 'Hentasis' : note, items: [{ index, file }] })
  })

  return [...byNote.values()]
})

export const hentasis = {
  state,
  groups,
  bindAnime,
  runSearch,
  openSlot,
  searchDomain, // ← добавить
  useCandidate,
  play,
  close,
  forget,
  loadSubtitleCues,
}
