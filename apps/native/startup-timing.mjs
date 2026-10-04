/** Opt-in diagnostics: fixed labels and monotonic times, never workspace data. */
export function createStartupTiming({enabled = false, elapsed = () => process.uptime() * 1000, emit = line => console.error(line)} = {}) {
  const labels = new Set();
  return label => {
    if (!enabled || labels.has(label)) return;
    if (!/^[a-z][a-z-]{0,48}$/.test(label)) throw Error('Invalid startup timing label.');
    labels.add(label);
    emit('ASMB_STARTUP ' + JSON.stringify({stage: label, elapsedMs: Math.round(elapsed() * 100) / 100}));
  };
}
