// Copies the web app into www/ for the Android build.
import { cp, rm, mkdir } from 'node:fs/promises';

const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'assets', 'img', 'fonts'];
await rm('www', { recursive: true, force: true });
await mkdir('www');
for (const f of FILES) await cp(f, `www/${f}`, { recursive: true });
console.log('Web app copied to www/');
