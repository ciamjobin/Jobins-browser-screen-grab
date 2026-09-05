import { readFile } from 'node:fs/promises';

const CHROMIUM_ONLY_PERMS = new Set(['offscreen', 'downloads.ui', 'debugger']);
let failed = false;

const check = (label, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
};

const chromium = JSON.parse(await readFile('dist/chrome-edge/manifest.json', 'utf8'));
const firefox = JSON.parse(await readFile('dist/firefox/manifest.json', 'utf8'));

console.log('--- Chrome / Edge ---');
check('service_worker background', !!chromium.background?.service_worker);
check('offscreen permission present', chromium.permissions.includes('offscreen'));
check('module type', chromium.background?.type === 'module');
check('extension renamed', chromium.name === 'JShotz');

console.log('\n--- Firefox ---');
check('event-page background (no service_worker)', !firefox.background?.service_worker);
check('background.scripts declared', Array.isArray(firefox.background?.scripts));
check('gecko id present', !!firefox.browser_specific_settings?.gecko?.id);
check('strict_min_version >= 128 for world:MAIN',
  parseFloat(firefox.browser_specific_settings?.gecko?.strict_min_version) >= 128);
const bad = firefox.permissions.filter((p) => CHROMIUM_ONLY_PERMS.has(p));
check('no Chromium-only permissions', bad.length === 0, bad.join(','));
check('versions match', chromium.version === firefox.version, `${chromium.version} vs ${firefox.version}`);
check('names match', chromium.name === firefox.name, `${chromium.name} vs ${firefox.name}`);

// Every file a manifest references must exist in that package.
for (const [name, manifest] of [['chrome-edge', chromium], ['firefox', firefox]]) {
  const refs = [
    ...(manifest.background?.scripts || []),
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    'pdf-import.html',
    'pdf-import.js',
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((c) => c.js)
  ].filter(Boolean);

  for (const ref of refs) {
    const ok = await readFile(`dist/${name}/${ref}`).then(() => true, () => false);
    check(`${name}: ${ref} exists`, ok);
  }
}

// The Firefox package must not ship or reference the offscreen document.
const fxBg = await readFile('dist/firefox/background.js', 'utf8');
check('firefox: offscreen.js absent',
  await readFile('dist/firefox/offscreen.js').then(() => false, () => true));
check('firefox: image-worker.js shipped',
  await readFile('dist/firefox/image-worker.js').then(() => true, () => false));
check('background guards chrome.offscreen', fxBg.includes("typeof chrome.offscreen !== 'undefined'"));

process.exit(failed ? 1 : 0);
