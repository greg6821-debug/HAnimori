// Хранилище источника Hentasis (18+): домены, автопоиск по названиям с AniList,
// сохранённые ссылки. Одно на всё приложение: бокс в списке и кадр на сцене читают его вместе.
import { reactive } from 'vue'

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import {
  autoFindHentasis,
  buildSearchQueries,
  getHentasisInfo,
  type HentasisFile,
} from '@animori/core/api/hentasis' // ← путь до core такой же, как в player-view.ts

const LINKS_KEY = 'animori:hentasis-links'
const BASES_KEY = 'animori:hentasis-bases'
const DEFAULT_BASES = ['https://hentasis1.top']

const ANILIST_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    title { romaji english native }
    synonyms
  }
}`

interface SavedLink {
  url: string
  file?: number
}

interface AniListMedia {
  data?: {
    Media?: {
      title?: { romaji?: string; english?: string; native?: string }
      synonyms?: string[]
    }
  }
}

export interface HentasisState {
  animeId: number
  basesText: string
  busy: boolean
  phase: '' | 'search' | 'page'
  trouble: string
  matchedTitle: string
  matchedUrl: string
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
  manualUrl: '',
  infoTitle: '',
  files: [],
  picked: -1,
  open: false,
  others: [],
})

const titleCache = new Map<number, string[]>()

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

function parseBases(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/\/+$/, ''))
    .filter((part) => /^https?:\/\//i.test(part))
}

function say(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** HTML страницы: через Rust-сторону Tauri, чтобы CORS не мешал. Referer — от самого домена. */
async function fetchPage(page: string): Promise<string> {
  let referer = 'https://hentasis1.top/'
  try {
    referer = new URL(page).origin + '/'
  } catch {
    // оставить запасной
  }
  const res = await tauriFetch(page, {
    headers: { Referer: referer, 'Accept-Language': 'ru,en;q=0.8' },
  })
  if (!res.ok) throw new Error(`Сайт ответил HTTP ${res.status}`)
  return res.text()
}

/** Все названия тайтла с AniList: английское, ромадзи, японское и синонимы
 * (русское название обычно живёт среди синонимов). */
async function fetchTitles(mediaId: number): Promise<string[]> {
  const cached = titleCache.get(mediaId)
  if (cached !== undefined) return cached

  const res = await tauriFetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: mediaId } }),
  })
  if (!res.ok) throw new Error(`AniList ответил HTTP ${res.status}`)

  const data = (await res.json()) as AniListMedia
  const media = data.data?.Media
  const titles = [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms ?? []),
  ].filter((item): item is string => typeof item === 'string' && item.trim() !== '')

  titleCache.set(mediaId, titles)
  return titles
}

function resetResult(): void {
  state.trouble = ''
  state.matchedTitle = ''
  state.matchedUrl = ''
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
      throw new Error('AniList не дал названий для поиска — вставь ссылку сам.')
    }

    const found = await autoFindHentasis(readBases(), buildSearchQueries(titles), titles, fetchPage)

    state.others = found.candidates.slice(0, 8).map(({ url, title }) => ({ url, title }))

    if (found.best === null) {
      state.trouble = 'Похожего не нашлось. Попробуй другой домен или вставь ссылку сам.'
      return
    }

    state.manualUrl = found.best.url
    await loadPage(found.best.url, true)
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
  localStorage.setItem(BASES_KEY, JSON.stringify(parseBases(text)))
}

async function useManual(): Promise<void> {
  const url = state.manualUrl.trim()
  if (url === '' || state.busy) return
  resetResult()
  await loadPage(url, true)
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
