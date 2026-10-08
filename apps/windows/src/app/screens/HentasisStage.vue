<script setup lang="ts">
// Кадр Hentasis на сцене: растянут поверх основного плеера (absolute на .am-play__stage).
// Источник переключает hentasis-store: бокс в списке ставит picked, здесь играем.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import Hls from 'hls.js'

import { hentasis } from './hentasis-store'

const state = hentasis.state

const active = computed(() => state.files[state.picked])
const videoKind = computed(() => active.value !== undefined && active.value.kind !== 'iframe')

const videoEl = ref<HTMLVideoElement | null>(null)

let hls: Hls | null = null

function destroyHls(): void {
  hls?.destroy()
  hls = null
}

async function attach(): Promise<void> {
  destroyHls()
  const file = active.value
  if (!state.open || file === undefined || file.kind === 'iframe') return

  await nextTick()
  const el = videoEl.value
  if (el === null) return

  if (file.kind === 'hls') {
    if (!Hls.isSupported()) {
      state.trouble = 'HLS-поток в этом WebView не запускается — открой файл на сайте.'
      return
    }
    hls = new Hls()
    hls.loadSource(file.url)
    hls.attachMedia(el)
  } else {
    el.src = file.url
  }

  void el.play().catch(() => {})
}

watch(
  () => state.picked,
  () => {
    void attach()
  },
)

watch(
  () => state.open,
  (open) => {
    if (open) void attach()
    else destroyHls()
  },
)

onBeforeUnmount(destroyHls)
</script>

<template>
  <div class="am-hxs" role="region" aria-label="Просмотр Hentasis">
    <video
      v-if="videoKind"
      ref="videoEl"
      class="am-hxs__media"
      controls
      autoplay
      playsinline
    ></video>
    <iframe
      v-else-if="active"
      class="am-hxs__media"
      :src="active.url"
      title="Плеер Hentasis"
      allow="autoplay; fullscreen; encrypted-media"
      allowfullscreen
      referrerpolicy="no-referrer"
    ></iframe>

    <div class="am-hxs__bar">
      <span class="am-hxs__label">
        {{ state.infoTitle !== '' ? state.infoTitle : 'Hentasis' }} · {{ active?.label ?? '—' }}
      </span>
      <button class="am-hxs__back" type="button" @click="hentasis.close()">Вернуться</button>
    </div>
  </div>
</template>

<style scoped>
.am-hxs {
  position: absolute;
  inset: 0;
  /* Поверх всего в кадре, включая панель управления основным плеером. */
  z-index: 60;
  background: #000;
}

.am-hxs__media {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
  object-fit: contain;
}

.am-hxs__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: linear-gradient(rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
  color: #fff;
  /* Прохождение щелчков сквозь градиент, но не мимо кнопки. */
  pointer-events: none;
}

.am-hxs__bar > * {
  pointer-events: auto;
}

.am-hxs__label {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-hxs__back {
  border: 0;
  border-radius: 8px;
  padding: 6px 12px;
  background: rgba(22, 22, 31, 0.85);
  color: #fff;
  cursor: pointer;
  font: inherit;
}
</style>
