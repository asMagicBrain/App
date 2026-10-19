export function scheduleArtifactFrame(callback: () => void, options?: {
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (id: number) => void;
  delay?: number;
}): () => void;
