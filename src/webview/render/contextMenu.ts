// Custom right-click context menu: webviews can't use VSCode's native menu
// API, so this is a small absolutely-positioned HTML/CSS menu built and
// torn down on demand. Populated per node by attachContextMenu in main.ts
// (checkout, create branch/tag, copy hash/ref name(s)/commit info,
// compare, delete/rename ref, ...).

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

let openMenuEl: HTMLElement | null = null;
// Whatever had focus right before the menu opened (the right-clicked node,
// typically) -- restored on close so a keyboard user ends up back where
// they started instead of losing their place in the document.
let previouslyFocusedEl: HTMLElement | null = null;

function onOutsidePointerDown(event: PointerEvent): void {
  if (openMenuEl && !openMenuEl.contains(event.target as Node)) closeContextMenu();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeContextMenu();
}

export function closeContextMenu(): void {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  previouslyFocusedEl?.focus();
  previouslyFocusedEl = null;
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  Object.assign(menu.style, {
    position: 'fixed',
    left: `${x}px`,
    top: `${y}px`,
    background: 'var(--vscode-menu-background, #252526)',
    color: 'var(--vscode-menu-foreground, #cccccc)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border, #454545))',
    borderRadius: '4px',
    padding: '4px 0',
    minWidth: '160px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
    font: 'inherit',
    zIndex: '1000',
  });

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    Object.assign(button.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '4px 12px',
      background: 'transparent',
      color: 'inherit',
      border: 'none',
      font: 'inherit',
      cursor: 'pointer',
    });
    button.addEventListener('mouseenter', () => {
      button.style.background = 'var(--vscode-menu-selectionBackground, #094771)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent';
    });
    // Mirrors the hover styling above so a keyboard-focused item (Tab, or
    // the initial auto-focus below) is visible without a mouse.
    button.addEventListener('focus', () => {
      button.style.background = 'var(--vscode-menu-selectionBackground, #094771)';
    });
    button.addEventListener('blur', () => {
      button.style.background = 'transparent';
    });
    button.addEventListener('click', () => {
      closeContextMenu();
      item.onClick();
    });
    menu.appendChild(button);
  }

  previouslyFocusedEl = document.activeElement as HTMLElement | null;
  document.body.appendChild(menu);
  openMenuEl = menu;
  // Without this, focus stays on whatever was right-clicked and a keyboard
  // user has to tab through the rest of the document before reaching the
  // menu at all.
  menu.querySelector('button')?.focus();

  // Keep the menu on-screen if it would overflow the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height)}px`;
  }

  // Deferred so the contextmenu event's own pointerdown doesn't immediately
  // close the menu it just opened.
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
  }, 0);
}
