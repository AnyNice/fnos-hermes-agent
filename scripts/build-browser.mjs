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
// fnos 壳适配（不碰 pinned 上游 hermes-src 源树，package-fpk 的 commit 校验照过）：
// 在 disposable staging 副本里把 gateway RPC 默认超时 30s 放宽到 60s，
// 避免 NAS 反代冷探测（首启可达性检查、网关刚重启、叠 CF 隧道抖动）下，
// 工作台入口先于宿主 60s 天花板被 30s 砍掉、弹「请求超时」。
{
  const _cp = path.join(desktop, 'src/api/client.ts');
  const _cs = await readFile(_cp, 'utf8').catch(() => null);
  if (_cs && _cs.includes('const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000')) {
    await writeFile(_cp, _cs.replace('const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000', 'const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 60_000'));
    console.log('patched staging client.ts: gateway RPC timeout 30s -> 60s (shell adaptation, upstream tree untouched)');
  } else {
    console.warn('WARN: staging client.ts missing or 30s anchor not found, work-ui keeps 30s');
  }
}
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
