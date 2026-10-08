<script setup lang="ts">
// Слой Hentasis: только для iframe-файлов — их нельзя положить в <video>.
// Видео-файлы играют в общем теге основного плеера. Слой стоит внутри сцены
// плеера и занимает ровно её площадь: ошибки и пустые iframe не выносятся
// на всё окно, а остаются в кадре, как заслонка.
import { computed } from 'vue'

import { hentasis } from './hentasis-store'

const state = hentasis.state

const frame = computed(() => {
  const file = state.files[state.picked]
  return state.open && file !== undefined && file.kind === 'iframe' ? file : null
})
</script>

<template>
  <div v-if="frame !== null" class="am-hxs" role="region" aria-label="Просмотр Hentasis">
    <iframe
      class="am-hxs__media"
      :src="frame.url"
      title="Плеер Hentasis"
      allow="autoplay; fullscreen; encrypted-media"
      allowfullscreen
      referrerpolicy="no-referrer"
    ></iframe>

    <div class="am-hxs__bar">
      <span class="am-hxs__label">
        {{ state.infoTitle !== '' ? state.infoTitle : 'Hentasis' }} · iframe
      </span>
      <button class="am-hxs__back" type="button" @click="hentasis.close()">Вернуться</button>
    </div>
  </div>
</template>

<style scoped>
/* Внутри .am-play__stage: тот же кадр, что у видео. Поверх панели плеера:
   из-под слоя её кнопки вели бы скрытым кадром. Если какой-то элемент
   плеера окажется поверх слоя — подними число. */
.am-hxs {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: #000;
}

.am-hxs__media {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
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
  padding: 10px 12px;
  background: linear-gradient(rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
  color: #fff;
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
