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

export function consentPage(
  id: string,
  clientName: string,
  redirectUri: string,
  nonce: string,
): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить PC MCP</title><style nonce="${nonce}">
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111318;color:#e9edf5}
body{max-width:520px;margin:8vh auto;padding:24px}h1{font-size:28px}p{line-height:1.6;color:#bfc8d8}
form{margin-top:24px}label{display:block;margin:18px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #525d70;border-radius:8px;background:#1b202a;color:inherit}
button{padding:12px 20px;margin:20px 8px 0 0;border:0;border-radius:8px;cursor:pointer;background:#89b4ff;color:#101826;font-weight:600}button[name=deny]{background:#303848;color:#e9edf5}code{overflow-wrap:anywhere}
</style></head><body><h1>Подключить PC MCP</h1>
<p>Приложение <strong>${escapeHtml(clientName)}</strong> запрашивает доступ к инструментам вашего компьютера: файлам, командам и снимкам экрана, включённым в настройках сервера.</p>
<p>Адрес возврата: <code>${escapeHtml(redirectUri)}</code></p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="request_id" value="${id}">
<label for="key">Ключ владельца — MCP_ADMIN_TOKEN из локального .env</label>
<input type="password" id="key" name="admin_token" autocomplete="current-password" required maxlength="512">
<button type="submit" name="approve" value="yes">Разрешить доступ</button>
<button type="submit" name="deny" value="yes" formnovalidate>Отменить</button>
</form><p>Ключ вводится только на этой странице. Приложение получит отдельный OAuth-токен.</p></body></html>`;
}
