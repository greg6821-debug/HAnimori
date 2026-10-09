// Хранилище источника Hentasis (18+): домены, автопоиск по названиям, сохранённые ссылки.
// Одно на всё приложение: бокс в списке и кадр на сцене читают его вместе.
// Автопоиск при открытии тайтла заводится только когда на карточке стоит метка 18+:
// сайт взрослый, остальным — кнопка «Искать по названию».

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
  type HentasisSubtitle, // ← добавить
  type PageRequestInit,
} from '@/api/hentasis'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'

import { computed, reactive } from 'vue'

/** Группа файлов с одинаковой пометкой: по ней Hentasis выглядит как озвучка. */
export interface HentasisGroup {
  key: string
  label: string
  items: { index: number; file: HentasisFile }[]
}

const groups = computed<HentasisGroup[]>(() => {
  const byNote = new Map<string, HentasisGroup>()

  state.files.forEach((file, index) => {
    const note = file.note ?? ''
    // Файл без пометки — группа из одного; пустая строка не склеивает их в ряд.
    const key = note === '' ? `\u0000${index}` : note
    const found = byNote.get(key)
    if (found !== undefined) found.items.push({ index, file })
    else byNote.set(key, { key, label: note === '' ? 'Hentasis' : note, items: [{ index, file }] })
  })

  return [...byNote.values()]
})

const LINKS_KEY = 'animori:hentasis-links'
const BASES_KEY = 'animori:hentasis-bases'
const DEFAULT_BASES = ['https://v6.hentasis.me', 'https://hentasis1.top']

const HEADERS_KEY = 'animori:hentasis-headers'

/** Заголовки по умолчанию: то, что раньше было захардкожено в fetchPage. */
const DEFAULT_HEADERS_TEXT = [
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language: ru,en;q=0.8',
].join('\n')

interface SavedLink {
  url: string
  file?: number
}

export interface HentasisState {
  animeId: number
  basesText: string
  busy: boolean
  phase: '' | 'search' | 'page'
  trouble: string
  /** Нейтральное известие: не ошибка, но и не находка (например, поиск не заводился). */
  notice: string
  matchedTitle: string
  matchedUrl: string
  matchedScore: number
  manualUrl: string
  infoTitle: string
  files: HentasisFile[]
  picked: number
  open: boolean
  resolving: boolean
  headersText: string
  subtitles: HentasisSubtitle[]
  others: { url: string; title: string }[]
}

const state = reactive<HentasisState>({
  animeId: 0,
  basesText: '',
  busy: false,
  phase: '',
  trouble: '',
  notice: '',
  matchedTitle: '',
  matchedUrl: '',
  matchedScore: 0,
  manualUrl: '',
  infoTitle: '',
  files: [],
  picked: -1,
  open: false,
  others: [],
  headersText: '',
  subtitles: [],
  resolving: false,
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

function readBases(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BASES_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return [...DEFAULT_BASES]
    const bases = raw.filter(
      (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
    )
    return bases.length > 0 ? bases : [...DEFAULT_BASES]
  } catch {
    return [...DEFAULT_BASES]
  }
}

function say(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** HTML страницы: через Rust-сторону Tauri, чтобы CORS не мешал. POST нужен поиску DLE. */
async function fetchPage(page: string, init?: PageRequestInit): Promise<string> {
  let referer = 'https://hentasis1.top/'
  try {
    referer = new URL(page).origin + '/'
  } catch {
    // оставить запасной
  }

  const headers: Record<string, string> = {
    Referer: referer,
    'Accept-Language': 'ru,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Свои заголовки поверх дефолтных: можно переопределить всё, включая Referer,
    // и добавить Cookie (например, после закрытия шторки на зеркале).
    ...parseHeaders(state.headersText),
  }
  if (init?.body !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  const res = await tauriFetch(page, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
    // Страница может молча держать соединение: без таймаута «Открываю файл…» висит вечно.
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
  state.matchedTitle = ''
  state.matchedUrl = ''
  state.matchedScore = 0
  state.infoTitle = ''
  state.files = []
  state.picked = -1
  state.others = []
  state.resolving = false
  state.subtitles = []
}

async function loadPage(url: string, remember: boolean): Promise<void> {
  state.busy = true
  state.phase = 'page'
  state.trouble = ''

  try {
    const info = await getHentasisInfo(url, fetchPage)
    state.files = info.files
    state.infoTitle = info.title ?? ''
    state.matchedTitle = info.title ?? url
    state.matchedUrl = url

    if (remember) {
      const map = readLinks()
      const previous = map[String(state.animeId)]
      map[String(state.animeId)] = { url, file: previous?.file }
      writeLinks(map)
    }

    const saved = readLinks()[String(state.animeId)]
    state.picked = saved?.file !== undefined && saved.file < info.files.length ? saved.file : -1
  } catch (e: unknown) {
    state.trouble = say(e)
  } finally {
    state.busy = false
    state.phase = ''
  }
}

/** Поиск по названиям. `auto` — запуск при открытии тайтла: без метки 18+ на карточке
 * он молчит и оставляет известие; вручную (кнопка, ручная ссылка) ищем безусловно. */
async function runSearch(auto = false): Promise<void> {
  if (state.animeId === 0 || state.busy) return

  state.busy = true
  state.phase = 'search'
  state.trouble = ''
  resetResult()

  try {
    const { titles, year, adult } = await fetchTitles(state.animeId)
    if (titles.length === 0) {
      state.trouble = 'Не достал названия тайтла — поиск невозможен. Вставь ссылку на тайтл сам.'
      return
    }

    if (auto && !adult) {
      state.notice =
        'Метка 18+ на карточке не стоит — автопоиск не запускался. ' +
        'Считаешь нужным — «Искать по названию» или вставь ссылку.'
      return
    }

    const found = await autoFindHentasis(
      readBases(),
      buildSearchQueries(titles),
      titles,
      fetchPage,
      {
        year: year > 0 ? year : undefined,
      },
    )
    state.others = found.candidates
      .filter((c) => c.score > 0)
      .map(({ url, title }) => ({ url, title }))

    if (found.best === null) {
      state.trouble =
        `Похожего не нашлось (страниц поиска обошли: ${found.pages}). ` +
        'Если страниц 0 — поиск сайта не отвечает: проверь домены или вставь ссылку на тайтл.'
      return
    }

    state.manualUrl = found.best.url
    await loadPage(found.best.url, true)
    state.matchedScore = found.best.score
  } catch (e: unknown) {
    state.trouble = say(e)
  } finally {
    state.busy = false
    state.phase = ''
  }
}

function bindAnime(id: number): void {
  state.open = false
  if (state.animeId === id) return

  state.animeId = id
  state.basesText = readBases().join(', ')
  state.headersText = readHeadersText()
  state.manualUrl = ''
  resetResult()
  if (id === 0) return

  const saved = readLinks()[String(id)]
  if (saved === undefined || saved.url === '') {
    void runSearch(true)
    return
  }

  // Ссылка найдена раньше: никакого поиска — один запрос на страницу.
  // Это восстановление выбора, который человек уже сделал сам, метка 18+ тут не проверяется.
  state.manualUrl = saved.url
  void loadPage(saved.url, false).then(() => {
    if (state.trouble !== '') {
      state.trouble =
        `Сохранённая ссылка не открылась (${state.trouble}). ` +
        'Если тайтл переехал — «Искать по названию» или вставь новую ссылку.'
    }
  })
}

function setBases(text: string): void {
  state.basesText = text
  const bases = text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/\/+$/, ''))
    .filter((part) => /^https?:\/\//i.test(part))
  localStorage.setItem(BASES_KEY, JSON.stringify(bases.length > 0 ? bases : [...DEFAULT_BASES]))
}

function readHeadersText(): string {
  const raw = localStorage.getItem(HEADERS_KEY)
  return raw === null || raw.trim() === '' ? DEFAULT_HEADERS_TEXT : raw
}

/** «Имя: значение» построчно → словарь. Мусорные строки пропускаются. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (!/^[A-Za-z0-9-]+$/.test(name) || value === '') continue
    out[name] = value
  }
  return out
}

function setHeaders(text: string): void {
  state.headersText = text
  localStorage.setItem(HEADERS_KEY, text)
}

/** Обе настройки — к заводским: домены и заголовки. */
function resetSettings(): void {
  state.basesText = [...DEFAULT_BASES].join(', ')
  localStorage.setItem(BASES_KEY, JSON.stringify([...DEFAULT_BASES]))

  state.headersText = DEFAULT_HEADERS_TEXT
  localStorage.setItem(HEADERS_KEY, DEFAULT_HEADERS_TEXT)
}

/** Домен из сырой строки; без схемы пробуем https:// сами. Пусто — не адрес вовсе. */
function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    try {
      return new URL(`https://${raw}`).origin
    } catch {
      return ''
    }
  }
}

/** Одно поле на оба случая: ссылка на тайтл открывается как есть,
 * домен становится доменом поиска и запускает автопоиск. */
async function useManual(): Promise<void> {
  const raw = state.manualUrl.trim()
  if (raw === '' || state.busy) return

  if (isTitlePageUrl(raw)) {
    resetResult()
    await loadPage(raw, true)
    state.matchedScore = 100
    return
  }

  const origin = originOf(raw)
  if (origin === '') {
    state.trouble = 'Не похоже на адрес: нужен домен (https://hentasis1.top) или ссылка на тайтл.'
    return
  }

  const bases = readBases()
  if (!bases.includes(origin)) {
    bases.unshift(origin)
    localStorage.setItem(BASES_KEY, JSON.stringify(bases.slice(0, 6)))
  }
  state.basesText = readBases().join(', ')
  await runSearch()
}

function useCandidate(url: string): void {
  if (state.busy) return
  state.manualUrl = url
  resetResult()
  void loadPage(url, true)
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

  // Любой iframe-файл разыменовываем в прямую ссылку: iframe-слои у зеркал
  // закрыты проверками (Referer/скрипты), а прямые файлы играются родным тегом.
  // Результат кешируется в files — повторный клик уже mp4/hls и мимо резолва.
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
  state.manualUrl = ''
  // Нажатие «Забыть» — явное действие человека: ищем как ручной запуск.
  void runSearch()
}

export const hentasis = {
  state,
  groups,
  bindAnime,
  setBases,
  setHeaders,
  resetSettings,
  runSearch,
  useManual,
  useCandidate,
  play,
  close,
  forget,
  loadSubtitleCues,
}
