// Хранилище источника Hentasis (18+): домены, автопоиск по названиям с AniList,
// сохранённые ссылки. Одно на всё приложение: бокс в списке и кадр на сцене читают его вместе.
import { reactive } from 'vue'

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import {
  autoFindHentasis,
  buildSearchQueries,
  getHentasisInfo,
  isTitlePageUrl,
  type HentasisFile,
  type PageRequestInit,
} from '@/api/hentasis'

const LINKS_KEY = 'animori:hentasis-links'
const BASES_KEY = 'animori:hentasis-bases'
const DEFAULT_BASES = ['https://hentasis1.top']

import { fetchMediaCard } from '@/api/anilist-media'
// Если у тебя импорт hentasis по другому пути (например, относительный на packages/core) —
// сохрани свой путь, меняется только набор имён.
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'


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
  matchedTitle: string
  matchedUrl: string
  matchedScore: number
  manualUrl: string
  infoTitle: string
  files: HentasisFile[]
  picked: number
  open: boolean
  others: { url: string; title: string }[]
}

const state = reactive<HentasisState>({
  animeId: 0,
  basesText: '',
  busy: false,
  phase: '',
  trouble: '',
  matchedTitle: '',
  matchedUrl: '',
  matchedScore: 0,
  manualUrl: '',
  infoTitle: '',
  files: [],
  picked: -1,
  open: false,
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
  }
  if (init?.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'

  const res = await tauriFetch(page, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
  })
  if (!res.ok) throw new Error(`Сайт ответил HTTP ${res.status}`)
  return res.text()
}

/** Все названия тайтла тем же путём, что и весь плеер: карточка AniList + русское имя. */
async function fetchTitles(mediaId: number): Promise<string[]> {
  const card = await fetchMediaCard(mediaId)
  await prefetchRussianNames([mediaId]).catch(() => {})

  return [card?.english, card?.romaji, card?.native, peekRussianName(mediaId)].filter(
    (t): t is string => typeof t === 'string' && t.trim() !== '',
  )
}

function resetResult(): void {
  state.trouble = ''
  state.matchedTitle = ''
  state.matchedUrl = ''
  state.matchedScore = 0
  state.infoTitle = ''
  state.files = []
  state.picked = -1
  state.others = []
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

async function runSearch(): Promise<void> {
  if (state.animeId === 0 || state.busy) return

  state.busy = true
  state.phase = 'search'
  state.trouble = ''
  resetResult()

  try {
    const titles = await fetchTitles(state.animeId)
    if (titles.length === 0) {
      state.trouble = 'Не достал названия тайтла — поиск невозможен. Вставь ссылку на тайтл сам.'
      return
    }

    const found = await autoFindHentasis(readBases(), buildSearchQueries(titles), titles, fetchPage)
    state.others = found.candidates.slice(0, 8).map(({ url, title }) => ({ url, title }))

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
  state.manualUrl = ''
  resetResult()
  if (id === 0) return

  const saved = readLinks()[String(id)]
  if (saved !== undefined && saved.url !== '') {
    state.manualUrl = saved.url
    void loadPage(saved.url, false)
  } else {
    void runSearch()
  }
}

function setBases(text: string): void {
  state.basesText = text
  const bases = text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/\/+$/, ''))
    .filter((part) => /^https?:\/\//i.test(part))
  localStorage.setItem(BASES_KEY, JSON.stringify(bases.length > 0 ? bases : [...DEFAULT_BASES]))
}

/** Одно поле на оба случая: ссылка на тайтл открывается как есть,
 * домен (или что угодно иное) становится доменом поиска и запускает автопоиск. */
async function useManual(): Promise<void> {
  const raw = state.manualUrl.trim()
  if (raw === '' || state.busy) return

  if (isTitlePageUrl(raw)) {
    resetResult()
    await loadPage(raw, true)
    state.matchedScore = 100
    return
  }

  let origin = raw
  try {
    origin = new URL(raw).origin
  } catch {
    origin = ''
  }
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

function play(index: number): void {
  if (state.files[index] === undefined) return
  state.picked = index

  const map = readLinks()
  const record = map[String(state.animeId)]
  if (record !== undefined) {
    record.file = index
    writeLinks(map)
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
  void runSearch()
}

export const hentasis = {
  state,
  bindAnime,
  setBases,
  runSearch,
  useManual,
  useCandidate,
  play,
  close,
  forget,
}
