// 檢查擴充功能能不能被 Edge／Chrome 載入（照它們載入時會擋的幾條規則）：node tools/check-manifest.js [資料夾]
// 打包（tools/build-package.py）前會自動跑，失敗就不打包。
// 由來：v1.0.66 用了 __MSG_name__ 卻漏了 default_locale，Edge「無法加載擴展」，兩版安裝包都裝不起來
const fs = require('fs'), path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const errs = [];
const exists = (p) => fs.existsSync(path.join(dir, p));
let m;
try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { console.error('manifest.json 讀不了：' + e.message); process.exit(1); }

if (m.manifest_version !== 3) errs.push('manifest_version 不是 3');
if (!/^\d+(\.\d+){0,3}$/.test(m.version || '')) errs.push('version 格式不對：' + m.version);
// 多語系：manifest 用了 __MSG_x__ 就一定要有 default_locale，而且那個語言的 messages.json 要有每個 x
const used = [...JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)].map((x) => x[1]);
if (used.length || exists('_locales')) {
  if (!m.default_locale) errs.push('用了多語系（__MSG_ 或 _locales），但沒有 default_locale');
  else if (!exists(`_locales/${m.default_locale}/messages.json`)) errs.push(`default_locale 是 ${m.default_locale}，但沒有 _locales/${m.default_locale}/messages.json`);
  if (exists('_locales')) {
    for (const loc of fs.readdirSync(path.join(dir, '_locales'))) {
      let msgs;
      try { msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8')); } catch (e) { errs.push(`_locales/${loc}/messages.json 讀不了：${e.message}`); continue; }
      for (const k of used) if (!msgs[k] || !msgs[k].message) errs.push(`_locales/${loc}/messages.json 少了 ${k}`);
      const name = msgs.name && msgs.name.message;
      if (name && name.length > 75) errs.push(`_locales/${loc} 的 name 超過 75 字`);
      const desc = msgs.description && msgs.description.message;
      if (desc && desc.length > 132) errs.push(`_locales/${loc} 的 description 超過 132 字`);
    }
  }
} else if (m.default_locale) errs.push('有 default_locale 但沒有 _locales 資料夾');
// 檔案都要在
const files = [];
if (m.background && m.background.service_worker) files.push(m.background.service_worker);
for (const cs of m.content_scripts || []) files.push(...(cs.js || []), ...(cs.css || []));
if (m.action && m.action.default_popup) files.push(m.action.default_popup);
for (const ic of [m.icons || {}, (m.action && m.action.default_icon) || {}]) files.push(...Object.values(ic));
for (const w of m.web_accessible_resources || []) files.push(...(w.resources || []));
for (const f of files) if (!exists(f)) errs.push('找不到檔案：' + f);

if (errs.length) { console.error('✗ ' + dir + '\n  ' + errs.join('\n  ')); process.exit(1); }
console.log(`✓ manifest 可以載入（v${m.version}，${files.length} 個檔案都在${m.default_locale ? '，預設語言 ' + m.default_locale : ''}）`);
