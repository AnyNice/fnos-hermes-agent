# 重写 admin style.css 的移动端方案：旧 760px 顶栏横滚 → 桌面侧栏 + 移动端底部 Tabbar + 「更多」sheet
import io, sys

path = r'E:\项目\hermes_fnos\fnos-dual-entry\frontend\admin\src\style.css'
lines = io.open(path, encoding='utf-8').read().splitlines()

NEW_760 = '@media(max-width:760px){.sidebar{display:none}main{margin-left:0;padding:18px 14px 88px}.page-header{margin-bottom:18px;gap:10px;flex-wrap:wrap}h1{font-size:20px}.page-header p{font-size:11px}.hero-head{align-items:stretch;flex-direction:column;gap:16px}.hero-brand{gap:12px}.hero-title{font-size:18px}.app-mark{height:52px;width:52px;font-size:32px}.hero-brand p{font-size:11px}.metrics{grid-template-columns:repeat(2,1fr);gap:9px}.metrics>div:last-child{grid-column:span 2}.control-grid,.quick-grid{grid-template-columns:1fr}.control-grid .n-card__content{display:grid;grid-template-columns:42px 1fr auto;gap:0 12px;align-items:center}.control-icon{grid-row:span 2;margin:0}.control-grid h3{font-size:14px;margin:0}.control-grid p{grid-column:2;font-size:11px;margin:4px 0 0;min-height:auto}.control-grid .n-button{grid-column:3;grid-row:1 / span 2}.section-title span{display:none}.workspace-grid,.settings-fields{grid-template-columns:1fr}.split{align-items:flex-start;flex-direction:column}.resource-description{max-width:100%}.toolbar{flex-wrap:wrap}.about-grid{grid-template-columns:80px 1fr}.hero-card>.n-card__content{padding:20px}.mobile-tabbar{display:flex}.mobile-sheet-backdrop{display:block}.mobile-sheet{display:block;transform:translateY(0)}.log-filter-grid{grid-template-columns:1fr}.log-search{grid-column:auto}.profile-row>div{align-items:flex-start;flex-direction:column;gap:4px}}'

MOBILE_BASE = """
/* 移动端底部 Tabbar + 「更多」sheet（≤760px 显示；参考 deepseek harness 移动端侧栏适配方案）*/
.mobile-tabbar{display:none;position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);border-top:1px solid var(--line);box-shadow:0 -4px 16px #132a4a0d;padding:6px 8px calc(6px + env(safe-area-inset-bottom))}
.mobile-tabbar button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;border:0;background:transparent;color:var(--muted);font-size:10.5px;line-height:1.1;padding:7px 2px;cursor:pointer;border-radius:10px;transition:transform .15s}
.mobile-tabbar button:active{transform:scale(.92)}
.mobile-tabbar button.active{color:#1669ff;font-weight:600}
.dark .mobile-tabbar button.active{color:#7facff}
.mobile-sheet{display:none;position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--surface);border-top:1px solid var(--line);border-top-left-radius:18px;border-top-right-radius:18px;box-shadow:0 -8px 30px #132a4a24;padding:14px 16px calc(18px + env(safe-area-inset-bottom));transform:translateY(100%);transition:transform .22s ease}
.mobile-sheet-backdrop{display:none;position:fixed;inset:0;z-index:55;background:#10131a66}
.mobile-sheet-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;color:var(--muted);margin:0 4px 10px}
.mobile-sheet a{display:flex;align-items:center;gap:11px;height:46px;padding:0 12px;border-radius:11px;color:var(--text);font-size:14px;margin:2px 0}
.mobile-sheet a.active{background:#eaf2ff;color:#1669ff;font-weight:600}
.dark .mobile-sheet a.active{background:#193356;color:#7facff}
.mobile-sheet-foot{display:flex;justify-content:flex-end;padding:10px 12px 0;font-size:11px;color:var(--muted)}
.mobile-sheet-foot i{display:inline-block;width:6px;height:6px;background:#a4adba;border-radius:50%;margin-right:6px}
.mobile-sheet-foot i.online{background:#27b47e}
"""

out = []
replaced = False
for line in lines:
    if not replaced and line.startswith('@media(max-width:760px){.sidebar{inset'):
        out.append(NEW_760)
        replaced = True
        continue
    out.append(line)

if not replaced:
    print('FATAL: old 760px block not found'); sys.exit(1)

text = '\n'.join(out) + '\n' + MOBILE_BASE
io.open(path, 'w', encoding='utf-8', newline='\n').write(text)
print(f'OK: 760px block replaced, mobile base styles appended. total {len(text.splitlines())} lines')
