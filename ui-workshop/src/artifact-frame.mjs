/** Layout work must settle even when a native child/Space transition withholds RAF. */
export function scheduleArtifactFrame(callback, {
  requestFrame = fn => globalThis.requestAnimationFrame(fn),
  cancelFrame = id => globalThis.cancelAnimationFrame(id),
  setTimer = (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimer = id => globalThis.clearTimeout(id),
  delay = 120,
} = {}) {
  let frame, timer, done = false;
  const cancel = () => {done = true; if (frame !== undefined) cancelFrame(frame); if (timer !== undefined) clearTimer(timer);};
  const finish = () => {if (done) return; cancel(); callback();};
  frame = requestFrame(finish);
  if (!done) timer = setTimer(finish, delay);
  return cancel;
}
