import { icon } from './icons.js';

export const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (/^on[A-Z]/.test(key)) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role')
      node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of [children].flat(Infinity)) if (child != null) node.append(child);
  return node;
};

export function toast(message, tone = 'success') {
  const host = document.getElementById('notifications');
  if (!host) return;
  const node = el(
    'div',
    { className: `toast ${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    [
      icon(tone === 'error' ? 'alert' : 'check'),
      el('span', { textContent: message }),
      el(
        'button',
        {
          type: 'button',
          className: 'icon-button',
          'aria-label': 'Закрыть уведомление',
          onClick: () => node.remove(),
        },
        icon('close'),
      ),
    ],
  );
  host.append(node);
  while (host.childElementCount > 3) host.firstElementChild.remove();
  setTimeout(() => node.remove(), 6000);
}

export function button(label, glyph, action, variant = 'secondary') {
  const node = el('button', { type: 'button', className: `button ${variant}` }, [
    glyph ? icon(glyph) : null,
    el('span', { textContent: label }),
  ]);
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    node.setAttribute('aria-busy', 'true');
    try {
      await action(node);
    } catch (error) {
      toast(error.message || 'Не удалось выполнить действие.', 'error');
    } finally {
      node.disabled = false;
      node.removeAttribute('aria-busy');
    }
  });
  return node;
}

export function badge(text, tone = 'neutral') {
  return el('span', { className: `badge ${tone}` }, [
    el('i', { className: 'status-dot' }),
    el('span', { textContent: text }),
  ]);
}

export function panel(title, subtitle, content, action) {
  return el('section', { className: 'panel' }, [
    el('div', { className: 'panel-heading' }, [
      el('div', {}, [
        el('h2', { textContent: title }),
        subtitle ? el('p', { className: 'muted', textContent: subtitle }) : null,
      ]),
      action,
    ]),
    content,
  ]);
}

export function emptyState(glyph, title, description, action) {
  return el('div', { className: 'empty-state' }, [
    el('div', { className: 'empty-icon' }, icon(glyph)),
    el('h3', { textContent: title }),
    el('p', { textContent: description }),
    action,
  ]);
}

let fieldId = 0;
export function field(label, control, hint) {
  control.id ||= `field-${++fieldId}`;
  const help = hint
    ? el('p', { className: 'field-hint', id: `${control.id}-hint`, textContent: hint })
    : null;
  if (help) control.setAttribute('aria-describedby', help.id);
  return el('div', { className: 'field' }, [
    el('label', { htmlFor: control.id, textContent: label }),
    control,
    help,
  ]);
}

export function input(value = '', options = {}) {
  return el('input', { type: 'text', className: 'input', value, autocomplete: 'off', ...options });
}

export function select(value, options, onChange) {
  return el(
    'select',
    { className: 'input', onChange },
    options.map(([key, label]) =>
      el('option', { value: key, selected: key === value, textContent: label }),
    ),
  );
}

export function toggle(label, description, checked, onChange, disabled = false) {
  return el('label', { className: `toggle-row ${disabled ? 'unavailable' : ''}` }, [
    el('span', { className: 'toggle-copy' }, [
      el('strong', { textContent: label }),
      el('span', { className: 'muted', textContent: description }),
    ]),
    el('span', { className: 'switch' }, [
      el('input', { type: 'checkbox', checked, disabled, onChange, 'aria-label': label }),
      el('span', { className: 'switch-track' }),
    ]),
  ]);
}

export function formPanel(title, subtitle, build, save, label = 'Сохранить изменения') {
  const form = el('form', { className: 'settings-form', noValidate: true });
  const error = el('div', { className: 'inline-error', role: 'alert', hidden: true });
  const controls = build();
  const submit = el('button', { type: 'submit', className: 'button primary' }, [
    icon('check'),
    el('span', { textContent: label }),
  ]);
  const status = el('span', {
    className: 'form-status',
    role: 'status',
    textContent: 'Изменения сохраняются по кнопке',
  });
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    form.dataset.dirty = 'true';
    status.textContent = 'Есть несохранённые изменения';
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    const fields = [...form.querySelectorAll('input, textarea, select')].map((node) => [
      node,
      node.disabled,
    ]);
    for (const [node] of fields) node.disabled = true;
    error.hidden = true;
    try {
      await save(controls);
      dirty = false;
      form.dataset.dirty = 'false';
      status.textContent = 'Сохранено';
    } catch (failure) {
      error.textContent = failure.message || 'Не удалось сохранить настройки.';
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      for (const [node, disabled] of fields) node.disabled = disabled;
      if (dirty) status.textContent = 'Изменения ещё не сохранены';
    }
  });
  form.append(...controls.nodes, error, el('div', { className: 'form-footer' }, [status, submit]));
  return panel(title, subtitle, form);
}

export function modal({
  title,
  description,
  glyph = 'info',
  content,
  submitLabel,
  onSubmit,
  danger = false,
  secret = false,
}) {
  const previous = document.activeElement;
  const dialog = el('dialog', { className: 'dialog', 'aria-labelledby': `dialog-${++fieldId}` });
  const headingId = dialog.getAttribute('aria-labelledby');
  const form = el('form', { noValidate: true });
  const error = el('div', { className: 'inline-error', role: 'alert', hidden: true });
  let pending = false;
  const close = () => {
    if (pending) return;
    dialog.close();
    dialog.remove();
    if (previous?.isConnected) previous.focus();
  };
  const cancel = button(
    submitLabel ? 'Отмена' : 'Готово',
    null,
    close,
    submitLabel ? 'secondary' : 'primary',
  );
  const submit = submitLabel
    ? el(
        'button',
        { type: 'submit', className: `button ${danger ? 'danger-solid' : 'primary'}` },
        el('span', { textContent: submitLabel }),
      )
    : null;
  form.append(
    el('div', { className: 'dialog-heading' }, [
      el('div', { className: `dialog-icon ${danger ? 'danger-tone' : ''}` }, icon(glyph)),
      el('h2', { id: headingId, textContent: title }),
    ]),
  );
  if (description)
    form.append(el('p', { className: 'dialog-description', textContent: description }));
  if (content) form.append(content);
  form.append(error, el('div', { className: 'dialog-footer' }, [cancel, submit]));
  dialog.append(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !onSubmit) return;
    pending = true;
    submit.disabled = true;
    cancel.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      const afterClose = await onSubmit();
      pending = false;
      close();
      if (typeof afterClose === 'function') afterClose();
    } catch (failure) {
      error.textContent = failure.message || 'Не удалось выполнить действие.';
      error.hidden = false;
    } finally {
      pending = false;
      submit.disabled = false;
      cancel.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!secret) close();
  });
  document.body.append(dialog);
  dialog.showModal();
  const target = danger
    ? cancel
    : (dialog.querySelector('input:not([type="checkbox"]), textarea') ?? cancel);
  target.focus();
  return { dialog, close };
}

export async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error('Буфер обмена недоступен. Выделите адрес и нажмите Ctrl+C.');
  }
  toast('Скопировано в буфер обмена');
}

export function secretModal(title, value) {
  const secret = input(value, {
    readOnly: true,
    className: 'input mono secret-value',
    'aria-label': 'Новый токен',
  });
  const view = modal({
    title,
    glyph: 'key',
    secret: true,
    description: 'Скопируйте и сохраните токен. После закрытия его можно только заменить.',
    content: el('div', { className: 'copy-field' }, [
      secret,
      button('Копировать', 'copy', () => copy(value)),
    ]),
  });
  view.dialog.addEventListener('close', () => {
    secret.value = '';
    value = '';
  });
}

export const dateTime = (value) =>
  value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const relativeTime = (value) => {
  if (!value) return 'Ещё не использовался';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? 'Только что'
    : minutes < 60
      ? `${minutes} мин назад`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} ч назад`
        : dateTime(value);
};
