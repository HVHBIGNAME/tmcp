function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

const style = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111318;color:#e9edf5}
body{max-width:520px;margin:8vh auto;padding:24px}h1{font-size:26px}p{line-height:1.6;color:#bfc8d8}
form{margin-top:24px}label{display:block;margin:18px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #525d70;border-radius:8px;background:#1b202a;color:inherit}
button{padding:12px 20px;margin:20px 8px 0 0;border:0;border-radius:6px;cursor:pointer;background:#f2b14b;color:#241503;font-weight:600}button[name=deny]{background:#303848;color:#e9edf5}code{overflow-wrap:anywhere}
[role=alert]{border-left:3px solid #f2b14b;padding:12px 16px;background:#25211b}form[aria-busy=true]{pointer-events:none;opacity:.7}form[aria-busy=true] button:first-of-type:before{content:'';display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;margin-right:8px;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}`;

export function consentPage(
  id: string,
  clientName: string,
  redirectUri: string,
  nonce: string,
  error?: string,
): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить PC MCP</title><style nonce="${nonce}">
${style}
</style></head><body><h1>Подключить PC MCP</h1>
<p>Приложение <strong>${escapeHtml(clientName)}</strong> запрашивает доступ к инструментам вашего компьютера: файлам, командам и снимкам экрана, включённым в настройках сервера.</p>
<p>Адрес возврата: <code>${escapeHtml(redirectUri)}</code></p>
${error ? `<p role="alert"><strong>Токен не подошёл.</strong> ${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/approve">
<input type="hidden" name="request_id" value="${id}">
<label for="key">Токен доступа — ключ из раздела «Доступ», как Bearer в Notion</label>
<input type="password" id="key" name="access_token" autocomplete="off" required maxlength="512">
<button type="submit" name="approve" value="yes">Разрешить доступ</button>
<button type="submit" name="deny" value="yes" formnovalidate>Отменить</button>
</form><p>Приложение получит OAuth-токен с теми же правами, что и этот ключ. Если ключ отключить или заменить — доступ приложения тоже прекратится.</p>
<script nonce="${nonce}">document.querySelector('form').addEventListener('submit',function(event){if(this.getAttribute('aria-busy')==='true'){event.preventDefault();return;}this.setAttribute('aria-busy','true');if(event.submitter)event.submitter.textContent=event.submitter.name==='deny'?'Отменяем…':'Подключаем…';});</script></body></html>`;
}

/** Shown instead of a JSON body when the visitor cannot finish this particular attempt. */
export function consentErrorPage(title: string, detail: string, nonce: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style nonce="${nonce}">
${style}
</style></head><body><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p>Вернитесь в приложение, из которого подключаетесь, и начните подключение заново: эта страница уже не действует.</p>
</body></html>`;
}
