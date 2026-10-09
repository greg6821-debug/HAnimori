<script setup lang="ts">
// Стена найденных тайтлов Hentasis под плеером: карточки фиксированной ширины,
// заполнение колонками справа налево — первая колонка продолжает сайдбар,
// остальные занимают площадь под плеером.
import { computed } from 'vue'

import { hentasis } from './hentasis-store'

const state = hentasis.state

const list = computed(() => state.others)
const showWall = computed(
  () => list.value.length > 1 || (list.value.length > 0 && state.matchedUrls[0] === ''),
)
</script>

<template>
  <div v-if="showWall" class="am-hxo">
    <h3 class="am-hxo__h">Hentasis · найденные тайтлы</h3>
    <div class="am-hxo__wall">
      <button
        v-for="other in list"
        :key="other.url"
        class="am-hxo__card"
        :class="{ 'am-hxo__card--on': other.url === state.matchedUrl }"
        type="button"
        :disabled="state.busy"
        @click="hentasis.useCandidate(other.url)"
      >
        {{ other.title }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Лежит в сетке .am-play: занимает обе колонки (грид) или всю строку (флекс). */
.am-hxo {
  grid-column: 1 / -1;
  flex-basis: 100%;
  width: 100%;
  margin-top: 6px;
}

.am-hxo__h {
  margin: 0 0 8px;
  font-size: 13px;
  opacity: 0.7;
}

/* Колонки фиксированной ширины = ширине карточки в сайдбаре; направо — чтобы
   первый столбец встал под сайдбар. Если сайдбар слева — убери direction: rtl. */
.am-hxo__wall {
  columns: var(--hx-card-w, 260px);
  column-gap: 10px;
  direction: rtl;
}

.am-hxo__card {
  direction: ltr;
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid #2b2b3d;
  border-radius: 10px;
  background: #16161f;
  color: #e8e8ee;
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  break-inside: avoid;
}

.am-hxo__card:hover {
  border-color: #3b82f6;
}

.am-hxo__card--on {
  border-color: #e5484d;
  background: #2a1215;
}

.am-hxo__card:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
