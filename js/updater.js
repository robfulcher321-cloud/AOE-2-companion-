// In-app updates for the Android app. On launch, asks GitHub for the latest
// release; if its build number is higher than this APK's, shows a banner that
// downloads the new APK and opens Android's installer. Does nothing on the web
// version, which updates itself through the service worker.

const LATEST = 'https://api.github.com/repos/robfulcher321-cloud/AOE-2-companion-/releases/latest';

const native = () => Boolean(window.Capacitor?.isNativePlatform?.());
const plugin = () => window.Capacitor?.Plugins?.AppUpdater;

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) n.append(c);
  return n;
};

export async function checkForAppUpdate() {
  if (!native() || !plugin()) return;
  try {
    const [{ build: current }, res] = await Promise.all([
      plugin().currentBuild(),
      fetch(LATEST, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } }),
    ]);
    if (!res.ok) return;
    const release = await res.json();
    const latest = Number(/build-(\d+)/.exec(release.tag_name || '')?.[1]);
    const apk = (release.assets || []).find((a) => a.name.endsWith('.apk'));
    if (!latest || !apk || latest <= Number(current)) return;
    showBanner(latest, current, apk.browser_download_url, apk.size);
  } catch (err) {
    console.warn('Update check failed:', err); // offline or GitHub unavailable: try next launch
  }
}

function showBanner(latest, current, url, size) {
  const text = el('p', { textContent: `Update available: build ${latest} (you have build ${current}).` });
  const bar = el('progress', { max: 1, value: 0, hidden: true });
  const go = el('button', { type: 'button', className: 'update-go', textContent: 'Update' });
  const later = el('button', { type: 'button', className: 'update-later', textContent: 'Later' });
  const banner = el('div', { className: 'update-banner', role: 'status' }, text, bar, el('div', { className: 'update-actions' }, later, go));
  document.body.prepend(banner);
  later.addEventListener('click', () => banner.remove());

  go.addEventListener('click', async () => {
    const up = plugin();
    const { allowed } = await up.canInstall();
    if (!allowed) {
      text.textContent = 'Android needs your OK first: turn on "Allow from this source" for AoE2 Companion, then come back and tap Update again.';
      await up.openInstallSettings();
      return;
    }
    go.disabled = true;
    later.hidden = true;
    bar.hidden = false;
    text.textContent = `Downloading build ${latest}…`;
    const listener = await up.addListener('progress', ({ done, total }) => {
      const t = total > 0 ? total : size;
      bar.value = t ? done / t : 0;
      text.textContent = `Downloading build ${latest}… ${Math.round((done / (t || done)) * 100)}%`;
    });
    try {
      await up.downloadAndInstall({ url });
      text.textContent = 'Downloaded. Confirm the update in Android\'s installer.';
      go.disabled = false;
      go.textContent = 'Install again';
    } catch (err) {
      text.textContent = `Update failed: ${err.message || err}. Check your connection and try again.`;
      go.disabled = false;
      later.hidden = false;
    } finally {
      listener?.remove?.();
    }
  });
}
