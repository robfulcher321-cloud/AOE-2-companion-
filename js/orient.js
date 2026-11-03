// Screen orientation for Wonder Wars: sideways, upright, or follow the phone.
// In the Android app this goes through the Orientation plugin (OrientationPlugin.java);
// in a browser it tries the Screen Orientation API, which most only allow in full screen.
const plugin = () => window.Capacitor?.Plugins?.Orientation;

/** mode: 'auto' | 'landscape' | 'portrait'. Resolves true if the screen was told to turn. */
export async function setOrientation(mode) {
  const p = plugin();
  if (p) {
    try { await p.set({ mode }); return true; } catch { return false; }
  }
  try {
    if (mode === 'auto') screen.orientation?.unlock?.();
    else await screen.orientation.lock(mode);
    return true;
  } catch {
    return false;
  }
}

/** Hide (or show again) the phone's status and navigation bars. App only. */
export async function setImmersive(on) {
  try { await plugin()?.immersive({ on }); } catch { /* not in the app, or not supported */ }
}

export const canTurn = () => Boolean(plugin()) || typeof screen.orientation?.lock === 'function';
