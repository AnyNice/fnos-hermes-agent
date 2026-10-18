import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.build/browser-core');
const source = path.join(root, 'app/hermes-src');
const desktop = path.join(stage, 'apps/desktop');

function run(args, cwd = stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build command exited ${code}`)));
  });
}

await mkdir(stage, { recursive: true });
const oldLock=existsSync(path.join(stage,'package-lock.json'))?await readFile(path.join(stage,'package-lock.json')):null;
// Remove stale source files after an upstream upgrade, retaining only dependency caches.
for(const app of ['apps/desktop','apps/shared']){
  const directory=path.resolve(stage,app);
  if(!directory.startsWith(stage+path.sep))throw new Error('Build path escaped staging root.');
  if(!existsSync(directory))continue;
  for(const entry of await readdir(directory)){
    if(entry==='node_modules')continue;
    const target=path.resolve(directory,entry);
    if(!target.startsWith(directory+path.sep)||!target.startsWith(path.join(root,'.build')+path.sep))throw new Error('Refusing to clean outside build workspace.');
    await rm(target,{recursive:true,force:true});
  }
}
// Never patch the pinned upstream tree. Only this disposable build copy receives the entry point.
for (const name of ['package.json', 'package-lock.json', 'apps/desktop', 'apps/shared']) {
  await cp(path.join(source, name), path.join(stage, name), {
    recursive: true,
    filter: p => !p.split(path.sep).some(part => ['node_modules', 'dist', '.git', '.cache'].includes(part)),
  });
}
await cp(path.join(root, 'app/browser'), path.join(desktop, 'fnos-browser'), { recursive: true });
await writeFile(path.join(desktop, 'vite.browser.config.ts'), `
import upstream from './vite.config.ts'
import { mergeConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export default async (env: any) => mergeConfig(await upstream(env), {
  plugins: [{ name: 'fnos-browser-entry', transformIndexHtml(html: string) {
    return { html: html.replaceAll('href="/apple-touch-icon.png"', 'href="./apple-touch-icon.png"'),
      tags: [{ tag: 'script', attrs: { src: './fnos-host.js' }, injectTo: 'head-prepend' }] }
  }, generateBundle() {
    const bridge = readFileSync(fileURLToPath(new URL('./fnos-browser/bridge.js', import.meta.url)), 'utf8')
    this.emitFile({ type: 'asset', fileName: 'fnos-host.js', source: bridge.replaceAll('export function', 'function') +
      '\\nwindow.hermesDesktop = createBrowserBridge({ hostRoot: new URL("../", new URL("./", window.location.href)) });\\n' })
  }}],
  build: { outDir: ${JSON.stringify(path.join(root, 'app/work-ui'))}, emptyOutDir: true, reportCompressedSize: false },
})
`);

const lockChanged=!oldLock||!oldLock.equals(await readFile(path.join(stage,'package-lock.json')));
if (lockChanged || !existsSync(path.join(stage, 'node_modules/vite/package.json')) || process.argv.includes('--install')) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Use the pinned Node distribution containing npm.');
  await run([npmCli, 'ci', '--workspace', 'apps/desktop', '--include-workspace-root', '--ignore-scripts', '--no-audit', '--no-fund']);
}
await run([path.join(stage, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.browser.config.ts'], desktop);
const release = JSON.parse(await readFile(path.join(root, 'config/bootstrap/hermes-source.json'), 'utf8'));
await writeFile(path.join(root, 'app/work-ui/fnos-build.json'), JSON.stringify({
  ...release, surface: 'official-desktop-browser', bridge: 1,
}, null, 2) + '\n');
console.log('Official Desktop browser build: app/work-ui');
