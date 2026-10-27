/**
 * Whisper model catalog shared by the top bar, the model panel and the store.
 * Sizes shown in the UI come from the engine (real HTTP Content-Length / on-disk
 * size); the strings here are only labels.
 */

export const MODEL_ORDER = ["tiny", "base", "small", "medium", "large-v3"] as const;

export type ModelName = (typeof MODEL_ORDER)[number];

export const MODEL_LABELS: Record<string, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  "large-v3": "large-v3",
};

export const MODEL_HINTS: Record<string, string> = {
  tiny: "极速 · 准确率一般",
  base: "轻量 · 日常够用",
  small: "推荐 · 速度与精度平衡",
  medium: "高精度 · 速度较慢",
  "large-v3": "最高精度 · 资源占用大",
};

export function modelLabel(name: string): string {
  return MODEL_LABELS[name] ?? name;
}
