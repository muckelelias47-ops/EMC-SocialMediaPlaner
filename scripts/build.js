import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
const files = ['index.html', 'styles.css', 'app.js', 'channels.js', 'lib.js', 'sw.js', 'manifest.webmanifest', 'favicon.svg'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await copyFile(file, `dist/${file}`);
await cp('icons', 'dist/icons', { recursive: true });
await copyFile('.nojekyll', 'dist/.nojekyll');
console.log('Statische App in dist/ erstellt.');
