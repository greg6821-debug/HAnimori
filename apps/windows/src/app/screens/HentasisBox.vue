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
    <div class="am-hx__row">
      <input
        v-model="url"
        class="am-hx__url"
        type="url"
        inputmode="url"
        spellcheck="false"
        autocomplete="off"
        placeholder="https://hentasis1.top/985-….html"
        aria-label="Адрес страницы Hentasis"
        @keydown.stop
      />
      <button
        class="am-hx__save"
        type="button"
        :disabled="busy || url.trim() === ''"
        @click="saveAndLoad"
      >
        Сохранить
      </button>
    </div>

    <p v-if="busy" class="am-hx__note" role="status">Читаю страницу Hentasis…</p>
    <p v-else-if="trouble !== ''" class="am-hx__note am-hx__note--err" role="alert">
      {{ trouble }}
    </p>
    <p v-else-if="files.length > 0" class="am-hx__note" role="status">
      {{ infoTitle }} · файлов: {{ files.length }} · порядок как на сайте
    </p>
    <p v-else class="am-hx__note">
      Ссылка на страницу тайтла с Hentasis — и «Сохранить»: файлы появятся здесь же.
    </p>

    <div v-if="files.length > 0" class="am-hx__files">
      <button
        v-for="(file, index) in files"
        :key="file.url"
        class="am-hx__file"
        :class="{ 'am-hx__file--on': index === picked }"
        type="button"
        @click="play(index)"
      >
        {{ file.label }}
      </button>
    </div>

    <div v-if="frame === 'video'" class="am-hx__stage">
      <video
        ref="videoEl"
        class="am-hx__frame"
        controls
        playsinline
        preload="metadata"
        referrerpolicy="no-referrer"
      ></video>
    </div>
    <div v-else-if="frame === 'iframe'" class="am-hx__stage">
      <iframe
        class="am-hx__frame"
        :src="frameSrc"
        title="Плеер Hentasis"
        allow="autoplay; fullscreen; encrypted-media"
        allowfullscreen
        referrerpolicy="no-referrer"
      ></iframe>
    </div>

    <p v-if="url.trim() !== ''" class="am-hx__open">
      <a :href="url" target="_blank" rel="noreferrer noopener">Открыть на сайте ↗</a>
    </p>
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
