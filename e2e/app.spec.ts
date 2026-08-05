import { test, expect } from '@playwright/test';

/** Full user journey: PKCE login -> memory -> docs (split editor) -> context. */
test('user journey: login, memory, docs, sessions, context, projects', async ({ page }) => {
  // --- login page ---
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Keycloak' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Keycloak' }).click();

  // Keycloak login (separate origin)
  await page.waitForURL(/localhost:8080/);
  await page.fill('#username', 'drew');
  await page.fill('#password', 'demo123');
  await page.press('#password', 'Enter');

  // back on the app, Memory view
  await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();

  // --- memory: create + appears in list ---
  const fact = `e2e memory ${Date.now()}`;
  await page.fill('input[placeholder="a durable fact… (keep it compact & high-signal)"]', fact);
  await page.locator('form button').click();
  await expect(page.locator('.mem li', { hasText: fact })).toBeVisible();

  // --- docs: create + split editor preview ---
  await page.getByRole('link', { name: 'Docs' }).click();
  await page.waitForURL(/#\/docs/);
  await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible();
  const slug = `e2e/${Date.now()}`;
  await page.fill('[placeholder="slug (guides/x)"]', slug);
  await page.getByRole('button', { name: 'new' }).click();
  await page.getByRole('button', { name: 'edit' }).click();
  await page.fill('textarea', '# Hello E2E\n\nSome **bold** text.');
  // live preview reflects source
  await expect(page.locator('.preview h1')).toHaveText('Hello E2E');
  await page.getByRole('button', { name: /save/ }).click();
  await expect(page.locator('.prose h1')).toHaveText('Hello E2E');

  // --- context: assemble shows stats ---
  await page.getByRole('link', { name: 'Context' }).click();
  await page.waitForURL(/#\/context/);
  await expect(page.getByRole('heading', { name: 'Context assembly' })).toBeVisible();
  await page.getByRole('button', { name: 'assemble' }).click();
  await expect(page.locator('.meta')).toContainText('chars:');

  // --- sessions: start a session, open it, append a message ---
  await page.getByRole('link', { name: 'Sessions' }).click();
  await page.waitForURL(/#\/sessions/);
  await expect(page.getByRole('heading', { name: /Sessions/ })).toBeVisible();
  const sTitle = `e2e session ${Date.now()}`;
  await page.fill('[placeholder="new session title…"]', sTitle);
  await page.getByRole('button', { name: /start session/ }).click();
  await expect(page.locator('.list li', { hasText: sTitle })).toBeVisible();
  await page.locator('.list li', { hasText: sTitle }).click();
  await page.fill('[placeholder="append a message…"]', 'hello from e2e');
  await page.getByRole('button', { name: 'send' }).click();
  await expect(page.locator('.msgs .msg', { hasText: 'hello from e2e' })).toBeVisible();

  // --- projects: provision a project, receive a scoped token (shown once) ---
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.waitForURL(/#\/projects/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  const pslug = `e2e-${Date.now()}`;
  await page.fill('[placeholder="Ashlands"]', 'E2E Project');
  await page.fill('[placeholder="ashlands"]', pslug);
  await page.getByRole('button', { name: /create/ }).click();
  // drew lacks a grant on the new scope -> the server mints a project PAT shown once
  await expect(page.locator('.token > code')).toBeVisible();
  // and it appears in the project list
  await expect(page.locator('.projs li', { hasText: pslug })).toBeVisible();
});
