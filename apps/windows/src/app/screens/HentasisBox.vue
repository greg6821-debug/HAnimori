<script setup lang="ts">
// Панель источника Hentasis (18+): адрес страницы тайтла, кнопка сохранения,
// список «Файл 1..N» как на сайте и свой встроенный плеер.
// Основной поток kodik/aniliberty не трогает: играет своим кадром,
// а главный <video> ставит на паузу событием started.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import Hls from 'hls.js'

// Путь до core — такой же, каким player-view.ts импортирует kodik/aniliberty.
import { getHentasisInfo, type HentasisFile } from '@/api/hentasis'

const props = defineProps<{ animeId: number }>()

const emit = defineEmits<{ started: [] }>()

/** Адреса лежат в localStorage: у каждого тайтла своя ссылка и последний выбранный файл. */
interface SavedLink {
  url: string
  file?: number
}

const STORE_KEY = 'animori:hentasis-links'

const url = ref('')
const infoTitle = ref('')
const files = ref<HentasisFile[]>([])
const picked = ref(-1)
const busy = ref(false)
const trouble = ref('')

const frame = ref<'none' | 'video' | 'iframe'>('none')
const frameSrc = ref('')

const videoEl = ref<HTMLVideoElement | null>(null)

let hls: Hls | null = null

function readMap(): Record<string, SavedLink> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, SavedLink>
  } catch {
    return {}
  }
}

function persist(): void {
  const map = readMap()
  const value = url.value.trim()

  if (value === '') {
    delete map[String(props.animeId)]
  } else {
    const record: SavedLink = { url: value }
    const file = picked.value >= 0 ? picked.value : readMap()[String(props.animeId)]?.file
    if (file !== undefined && file >= 0) record.file = file
    map[String(props.animeId)] = record
  }

  localStorage.setItem(STORE_KEY, JSON.stringify(map))
}

function reset(): void {
  hls?.destroy()
  hls = null
  files.value = []
  picked.value = -1
  infoTitle.value = ''
  trouble.value = ''
  frame.value = 'none'
  frameSrc.value = ''
}

/** HTML страницы тайтла: через Rust-сторону Tauri, чтобы CORS не мешал. */
async function fetchPage(page: string): Promise<string> {
  const res = await tauriFetch(page, {
    headers: { Referer: 'https://hentasis1.top/', 'Accept-Language': 'ru,en;q=0.8' },
  })
  if (!res.ok) throw new Error(`Сайт ответил HTTP ${res.status} — попробуй ещё раз`)
  return res.text()
}

async function load(): Promise<void> {
  const page = url.value.trim()
  if (page === '' || busy.value) return

  busy.value = true
  trouble.value = ''
  files.value = []
  picked.value = -1
  frame.value = 'none'
  hls?.destroy()
  hls = null

  let remembered = 0
  try {
    const info = await getHentasisInfo(page, fetchPage)
    files.value = info.files
    infoTitle.value = info.title ?? ''
    remembered = readMap()[String(props.animeId)]?.file ?? 0
    persist()
  } catch (e: unknown) {
    trouble.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }

  if (files.value.length > 0) {
    void play(remembered < files.value.length ? remembered : 0)
  }
}

function saveAndLoad(): void {
  persist()
  void load()
}

async function play(index: number): Promise<void> {
  const file = files.value[index]
  if (file === undefined) return

  picked.value = index
  persist()

  hls?.destroy()
  hls = null

  if (file.kind === 'iframe') {
    frame.value = 'iframe'
    frameSrc.value = file.url
    emit('started')
    return
  }

  frame.value = 'video'
  frameSrc.value = ''
  await nextTick()

  const el = videoEl.value
  if (el === null) return

  if (file.kind === 'hls') {
    if (!Hls.isSupported()) {
      trouble.value = 'HLS-поток в этом WebView не запускается — открой файл на сайте.'
      return
    }
    hls = new Hls()
    hls.loadSource(file.url)
    hls.attachMedia(el)
  } else {
    el.src = file.url
  }

  void el.play().catch(() => {})
  emit('started')
}

// Новый тайтл — новая ссылка: сброс и автозагрузка сохранённого адреса.
watch(
  () => props.animeId,
  () => {
    reset()
    url.value = readMap()[String(props.animeId)]?.url ?? ''
    if (url.value !== '') void load()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  hls?.destroy()
  hls = null
})
</script>

<template>
  <div class="am-hx">
    <label class="am-hx__field">
      <span class="am-hx__cap">Домены для поиска (через запятую)</span>
      <input
        v-model="state.basesText"
        class="am-hx__url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="https://hentasis1.top"
        aria-label="Домены Hentasis"
        @keydown.stop
        @change="hentasis.setBases(state.basesText)"
      />
    </label>

    <div class="am-hx__row">
      <button class="am-hx__save" type="button" :disabled="state.busy" @click="hentasis.runSearch()">
        Искать по названию
      </button>
      <button
        v-if="state.manualUrl !== ''"
        class="am-hx__file"
        type="button"
        :disabled="state.busy"
        @click="hentasis.forget()"
      >
        Забыть
      </button>
    </div>

    <p v-if="state.busy && state.phase === 'search'" class="am-hx__note" role="status">
      Ищу тайтл по названиям с AniList…
    </p>
    <p v-else-if="state.busy" class="am-hx__note" role="status">Читаю страницу…</p>
    <p v-else-if="state.trouble !== ''" class="am-hx__note am-hx__note--err" role="alert">
      {{ state.trouble }}
    </p>
    <p v-else-if="state.matchedTitle !== ''" class="am-hx__note" role="status">
      Нашёл: {{ state.matchedTitle }}
      <template v-if="state.matchedScore > 0"> (совпадение {{ state.matchedScore }}%)</template>
    </p>
    <p v-else class="am-hx__note">
      Найду страницу сам по названиям с AniList — или вставь ниже домен/ссылку.
    </p>

    <label class="am-hx__field">
      <span class="am-hx__cap">Домен или ссылка на тайтл</span>
      <span class="am-hx__row">
        <input
          v-model="state.manualUrl"
          class="am-hx__url"
          type="text"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://hentasis1.top или https://…/1094-….html"
          aria-label="Домен или ссылка на страницу Hentasis"
          @keydown.stop
        />
        <button
          class="am-hx__save"
          type="button"
          :disabled="state.busy || state.manualUrl.trim() === ''"
          @click="hentasis.useManual()"
        >
          Открыть
        </button>
      </span>
    </label>

    <div v-if="state.files.length > 0" class="am-hx__files">
      <button
        v-for="(file, index) in state.files"
        :key="file.url"
        class="am-hx__file"
        :class="{ 'am-hx__file--on': index === state.picked }"
        type="button"
        @click="hentasis.play(index)"
      >
        {{ file.label }}
      </button>
    </div>

    <div v-if="state.others.length > 1" class="am-hx__others">
      <span class="am-hx__cap">Другие совпадения</span>
      <button
        v-for="other in state.others"
        :key="other.url"
        class="am-hx__other"
        type="button"
        :disabled="state.busy"
        @click="hentasis.useCandidate(other.url)"
      >
        {{ other.title }}
      </button>
    </div>

    <a
      v-if="state.matchedUrl !== ''"
      class="am-hx__link"
      :href="state.matchedUrl"
      target="_blank"
      rel="noreferrer noopener"
    >
      Открыть страницу на сайте ↗
    </a>
  </div>
</template>
<style scoped>
/* Цвета взяты нейтральные — при желании подгони под палитру приложения. */
.am-hx {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: #e8e8ee;
}

.am-hx__row {
  display: flex;
  gap: 6px;
}

.am-hx__url {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid #2b2b3d;
  border-radius: 8px;
  background: #0f0f16;
  color: inherit;
  font: inherit;
}

.am-hx__url:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}

.am-hx__save {
  border: 0;
  border-radius: 8px;
  padding: 7px 12px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font: inherit;
}

.am-hx__save:disabled {
  opacity: 0.5;
  cursor: default;
}

.am-hx__note {
  margin: 0;
  line-height: 1.4;
  opacity: 0.85;
}

.am-hx__note--err {
  opacity: 1;
  color: #ff8080;
}

.am-hx__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.am-hx__file {
  border: 1px solid #2b2b3d;
  border-radius: 8px;
  padding: 5px 10px;
  background: #16161f;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.am-hx__file--on {
  border-color: #e5484d;
  background: #2a1215;
}

.am-hx__stage {
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}

.am-hx__frame {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 0;
}

.am-hx__open {
  margin: 0;
}

.am-hx__open a {
  color: #8ab4ff;
  font-size: 12px;
  text-decoration: none;
}
</style>
