// Хранилище источника Hentasis (18+): три домена, автопоиск по названиям,
// сохранённые ссылки. Одно на всё приложение: бокс в списке и списки плеера
// читают его вместе. Файлы всех доменов сливаются в общий список:
// группа пометки получает суффикс домена, чтобы зеркала не склеивались.

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

/** Ровно три слота: первый — основной, поиск по нему заводится сам. */
const SLOT_COUNT = 3

interface SavedLink {
  /** Ссылка на страницу тайтла: по слоту, у каждого домена своя. */
  urls: (string | null)[]
  file?: number
}

export interface HentasisState {
  animeId: number
  /** Три домена поиска. */
  basesText: string[]
  /** Три ссылки на тайтлы (по слоту домена). */
  manualUrls: string[]
  busy: boolean
  /** Какой слот сейчас ищется/грузится: -1 — никто. */
  slotBusy: number
  trouble: string
  /** Нейтральное известие: не ошибка, но и не находка. */
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
  basesText: ['', '', ''],
  manualUrls: ['', '', ''],
  busy: false,
  slotBusy: -1,
  trouble: '',
  notice: '',
  matchedTitles: ['', '', ''],
  matchedUrls: ['', '', ''],
  infoTitle: '',
  files: [],
  picked: -1,
  open: false,
  resolving: false,
  subtitles: [],
  others: [],
})

function readLinks(): Record<string, SavedLink> {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, SavedLink>
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

/** HTML страницы: через Rust-сторону Tauri, чтобы CORS не мешал. POST нужен поиску DLE. */
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

/** Cue'и субтитра: файл тянем через plugin-http (CORS не мешает), ASS разбираем на пары. */
async function loadSubtitleCues(
  src: string,
): Promise<{ start: number; end: number; text: string }[]> {
  return assToCues(await fetchPage(src))
}

/** Названия, год и метка 18+ тем же путём, что и весь плеер: карточка AniList + русское имя. */
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
  state.matchedTitles = ['', '', '']
  state.matchedUrls = ['', '', '']
  state.infoTitle = ''
  state.files = []
  state.picked = -1
  state.others = []
  state.subtitles = []
  state.resolving = false
}

/** Метка «домен · …» для группы: зеркала нумеруют файлы каждый со своей единицы,
 * без суффикса группы разных доменов склеивались бы в один ряд. */
function domainTag(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Номер слота по адресу страницы тайтла. */
function slotOf(url: string): number {
  for (let i = 0; i < state.basesText.length; i += 1) {
    const base = state.basesText[i]
    if (base === undefined || base === '') continue
    if (url.startsWith(base)) return i
  }
  return 0
}

async function loadSlot(slot: number, url: string, remember: boolean): Promise<boolean> {
  state.slotBusy = slot
  state.trouble = ''

  try {
    const info = await getHentasisInfo(url, fetchPage)
    state.matchedTitles[slot] = info.title ?? url
    state.matchedUrls[slot] = url

    if (remember) {
      const map = readLinks()
      const record = map[String(state.animeId)] ?? { urls: [null, null, null] }
      record.urls[slot] = url
      writeLinks(map)
    }

    // Слияние: файлы нового домена дописываются к общему списку.
    const tag = domainTag(url)
    const offset = state.files.length
    for (let i = 0; i < info.files.length; i += 1) {
      const file = info.files[i]
      if (file === undefined) continue
      state.files.push({
        ...file,
        label: file.label,
        note: file.note !== undefined ? `${file.note} · ${tag}` : tag,
      })
      // Первый файл нового домена — кандидат на автозапуск, если ещё ничего не выбрано.
      if (state.picked < 0 && i === 0) state.picked = offset
    }

    return true
  } catch (e: unknown) {
    // Слот мог не ответить — это не ошибка всего поиска: остальные едут дальше.
    Logger('WARN', `Hentasis: слот ${slot + 1} не открылся (${url})`, e)
    state.matchedTitles[slot] = ''
    state.matchedUrls[slot] = ''
    if (state.trouble === '') {
      state.trouble = `Домен ${slot + 1}: ${say(e)}`
    }
    return false
  } finally {
    state.slotBusy = -1
  }
}

/** Автопоиск: только первый слот. */
async function runSearch(): Promise<void> {
  if (state.animeId === 0 || state.busy) return

  state.busy = true
  state.trouble = ''
  resetResult()

  try {
    const { titles, year, adult } = await fetchTitles(state.animeId)
    if (titles.length === 0) {
      state.trouble = 'Не достал названия тайтла — поиск невозможен. Вставь ссылку на тайтл сам.'
      return
    }

    if (!adult) {
      state.notice =
        'Метка 18+ на карточке не стоит — автопоиск не запускался. ' +
        'Считаешь нужным — впиши ссылку в первый слот и нажми «Открыть».'
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
    state.others = found.candidates.filter((c) => c.score > 0).map(({ url, title }) => ({ url, title }))

    if (found.best === null) {
      state.trouble =
        `Похожего не нашлось (страниц поиска обошли: ${found.pages}). ` +
        'Если страниц 0 — поиск сайта не отвечает: проверь первый домен или вставь ссылки руками.'
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

/** Ручной запуск слота: ссылка на тайтл открывается, домен — ищет. */
async function openSlot(slot: number): Promise<void> {
  const raw = (state.manualUrls[slot] ?? '').trim()
  if (raw === '' || state.busy || state.slotBusy >= 0) return

  if (isTitlePageUrl(raw)) {
    resetResult()
    const ok = await loadSlot(slot, raw, true)
    if (ok && slot === 0) state.infoTitle = state.matchedTitles[0] ?? ''
    return
  }

  // Домен: ищем на нём.
  let origin = raw
  try {
    origin = new URL(raw).origin
  } catch {
    try {
      origin = new URL(`https://${raw}`).origin
    } catch {
      state.trouble = 'Не похоже на адрес: нужен домен или ссылка на тайтл.'
      return
    }
  }

  const base = state.basesText[slot]
  const emptySlots = state.basesText.filter((b) => b === undefined || b === '').length
  if (base === undefined || base === '') {
    // Свободный слот: домен занимает его место.
    state.basesText[slot] = origin.replace(/\/+$/, '')
    localStorage.setItem('animori:hentasis-bases', JSON.stringify(state.basesText))
  } else if (emptySlots === 0 && !state.basesText.includes(origin.replace(/\/+$/, ''))) {
    state.trouble = 'Все три слота заняты другими доменами.'
    return
  }

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

    const useBase = state.basesText[slot] ?? origin
    const found = await autoFindHentasis(
      [useBase],
      buildSearchQueries(titles),
      titles,
      fetchPage,
      { year: year > 0 ? year : undefined },
    )
    state.others.push(
      ...found.candidates.filter((c) => c.score > 0).map(({ url, title }) => ({ url, title })),
    )

    if (found.best === null) {
      state.trouble = `На ${useBase} похожего не нашлось (страниц: ${found.pages}).`
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

  // Домены — фикс: если в localStorage лежали старые, обновляем на дефолтные.
  const savedBases = JSON.parse(
    localStorage.getItem('animori:hentasis-bases') ?? '[]',
  ) as unknown
  const defaults = ['https://v6.hentasis.me', 'https://hentasis1.top', '']
  state.basesText =
    Array.isArray(savedBases) && savedBases.length === SLOT_COUNT
      ? savedBases.map((b) => (typeof b === 'string' ? b : ''))
      : [...defaults]
  localStorage.setItem('animori:hentasis-bases', JSON.stringify(state.basesText))

  const record = readLinks()[String(id)]
  if (record === undefined || record.urls.every((u) => u === null || u === '')) {
    void runSearch()
    return
  }

  // Восстановление: грузим все сохранённые ссылки параллельно.
  state.manualUrls = [...record.urls]
  const jobs = record.urls
    .map((url, slot) => ({ url, slot }))
    .filter((job): job is { url: string; slot: number } => typeof job.url === 'string' && job.url !== '')
    .map((job) => loadSlot(job.slot, job.url, false))

  void Promise.allSettled(jobs).then(() => {
    if (state.trouble !== '') {
      state.trouble = `Часть доменов не открылась (${state.trouble}). Попробуй «Найти» заново.`
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

function forgetSlot(slot: number): void {
  const map = readLinks()
  const record = map[String(state.animeId)]
  if (record !== undefined) {
    record.urls[slot] = null
    writeLinks(map)
  }
  state.manualUrls[slot] = ''
  state.matchedTitles[slot] = ''
  state.matchedUrls[slot] = ''
}

function forget(): void {
  const map = readLinks()
  delete map[String(state.animeId)]
  writeLinks(map)
  state.manualUrls = ['', '', '']
  state.matchedTitles = ['', '', '']
  state.matchedUrls = ['', '', '']
  void runSearch()
}

export const hentasis = {
  state,
  groups,
  bindAnime,
  runSearch,
  openSlot,
  useCandidate,
  play,
  close,
  forget,
  forgetSlot,
  loadSubtitleCues,
}


