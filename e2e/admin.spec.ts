import { test, expect, type Page } from '@playwright/test'

// A 1×1 transparent PNG — a real PNG signature so the magic-byte sniff passes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

// Covers the core authoring loop end-to-end against a real browser:
// first-run setup → create a page → add a Hero section → save → it appears in
// the list → the live preview renders the section.

async function ensureSignedIn(page: Page) {
  await page.goto('/admin')
  // The setup screen offers "Create account"; the (logo-only) login screen offers
  // "Sign in". Detect by the submit button rather than a heading, since the login
  // screen is intentionally heading-less.
  if (await page.getByRole('button', { name: 'Create account' }).isVisible().catch(() => false)) {
    await page.getByRole('textbox', { name: 'Email' }).fill('admin@e2e.test')
    const pwds = page.locator('input[type="password"]')
    await pwds.nth(0).fill('supersecret123')
    await pwds.nth(1).fill('supersecret123')
    await page.getByRole('button', { name: 'Create account' }).click()
  } else if (await page.getByRole('button', { name: 'Sign in' }).isVisible().catch(() => false)) {
    await page.getByRole('textbox', { name: 'Email' }).fill('admin@e2e.test')
    await page.locator('input[type="password"]').fill('supersecret123')
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('link', { name: 'Pages', exact: true })).toBeVisible()
}

test('first-run setup creates the admin and lands in the panel', async ({ page }) => {
  await ensureSignedIn(page)
  await expect(page.locator('.sidebar .logo-word')).toHaveText('KernelCMS')
})

test('graphql endpoint creates and queries through the live server', async ({ request }) => {
  const headers = { Authorization: 'Bearer e2e-key' }
  const create = await request.post('/api/graphql', {
    headers,
    data: {
      query: 'mutation($d: JSON!){ createArticles(data: $d){ id title _status } }',
      variables: { d: { title: 'Via GraphQL' } },
    },
  })
  expect(create.ok()).toBeTruthy()
  const created = await create.json()
  expect(created.errors).toBeUndefined()
  expect(created.data.createArticles.title).toBe('Via GraphQL')

  // articles has drafts enabled → the new doc is a draft; query with draft:true.
  const list = await request.post('/api/graphql', {
    headers,
    data: { query: '{ articles(draft: true){ totalDocs docs { title } } }' },
  })
  expect((await list.json()).data.articles.totalDocs).toBeGreaterThanOrEqual(1)
})

test('command palette navigates to a collection', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('button', { name: 'Open command palette' }).click()
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog).toBeVisible()

  await dialog.getByRole('combobox').fill('Articles')
  await page.getByRole('option', { name: /Articles/ }).first().click()

  // It navigated to the Articles list.
  await expect(page.getByRole('heading', { name: 'Articles', exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
})

test('build a page with a Hero section and see it in the live preview', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Pages', exact: true }).click()
  await page.getByRole('link', { name: /Create new/i }).click()

  const heading = 'E2E Launch Day'
  await page.locator('.field', { hasText: 'Title' }).locator('input').first().fill('Launch page')
  await page.locator('.field', { hasText: 'Slug' }).locator('input').first().fill('launch')

  // Add a Hero from the section library.
  await page.getByRole('button', { name: /Add section/i }).click()
  await expect(page.getByRole('heading', { name: 'Add a section' })).toBeVisible()
  await page.locator('.lib-card', { hasText: 'Hero' }).click()

  // Fill the Hero's required heading inside the block card.
  await page.locator('.block-card .field', { hasText: 'Heading' }).locator('input').first().fill(heading)

  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // No validation banner; the save succeeded.
  await expect(page.locator('.alert')).toHaveCount(0)

  // The live preview iframe renders the Hero heading.
  const preview = page.frameLocator('iframe.preview-frame')
  await expect(preview.getByText(heading)).toBeVisible()

  // And it shows up in the list.
  await page.getByRole('link', { name: 'Pages', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'Launch page' })).toBeVisible()
})

test('draft → publish lifecycle with version history', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await page.getByRole('link', { name: /Create new/i }).click()

  await page.locator('.field', { hasText: 'Title' }).locator('input').first().fill('Draft story')

  // Save as a draft → the status pill reads Draft.
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.locator('.page-head .pill-draft')).toHaveText('Draft')
  await expect(page.locator('.alert')).toHaveCount(0)

  // A draft is hidden from the public list but visible to the admin (draft=true).
  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'Draft story' })).toBeVisible()
  await page.getByRole('cell', { name: 'Draft story' }).click()

  // Publish → the pill flips to Published.
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.locator('.page-head .pill-published')).toHaveText('Published')

  // Version history records both the draft create and the publish.
  await page.getByRole('button', { name: 'Versions' }).click()
  await expect(page.getByRole('dialog', { name: 'Version history' })).toBeVisible()
  await expect(page.locator('.version-row')).not.toHaveCount(0)
})

test('rich text editor formats content and persists the model', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await page.getByRole('link', { name: /Create new/i }).click()
  await page.locator('.field', { hasText: 'Title' }).locator('input').first().fill('RT article')

  // Type into the contentEditable surface, select all, and bold it.
  const surface = page.locator('.rte-surface')
  await surface.click()
  await page.keyboard.type('Hello bold world')
  await page.keyboard.press('Control+A')
  // Selecting text also reveals the floating bubble toolbar (its own Bold button),
  // so scope to the main formatting toolbar to stay unambiguous.
  await page.getByRole('toolbar', { name: 'Formatting', exact: true }).getByRole('button', { name: 'Bold' }).click()

  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.locator('.alert')).toHaveCount(0)

  // Reopen the article — the editor rebuilds from the stored KernelRichText, so a
  // <strong> here proves the full DOM → sanitize → store → toHTML round trip.
  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await page.getByRole('cell', { name: 'RT article' }).click()
  await expect(page.locator('.rte-surface strong')).toContainText('Hello bold world')
})

test('rich text slash menu inserts a block and the bubble toolbar appears on selection', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await page.getByRole('link', { name: /Create new/i }).click()
  await page.locator('.field', { hasText: 'Title' }).locator('input').first().fill('Slash article')

  const surface = page.locator('.rte-surface')
  await surface.click()
  await page.keyboard.type('A wise quote ')

  // "/" opens the command palette; typing filters it.
  await page.keyboard.type('/')
  await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible()
  await page.keyboard.type('quote')
  await page.getByRole('option', { name: /Quote/ }).click()

  // The "/quote" trigger is removed and the block becomes a blockquote.
  await expect(surface.locator('blockquote')).toContainText('A wise quote')

  // Selecting text reveals the animated floating toolbar.
  await page.keyboard.press('Control+A')
  await expect(page.locator('.rte-bubble')).toBeVisible()
})

test('delete shows an animated confirm dialog and a success toast', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await page.getByRole('link', { name: /Create new/i }).click()
  await page.locator('.field', { hasText: 'Title' }).locator('input').first().fill('Delete me')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.locator('.toast-success')).toBeVisible() // "Saved"

  await page.getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete' }).click()

  // Toast confirms, and we're back on the list without the deleted row.
  await expect(page.getByRole('heading', { name: 'Articles', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Delete me' })).toHaveCount(0)
})

test('media library: drag-drop upload shows a thumbnail served from storage', async ({ page }) => {
  await ensureSignedIn(page)

  await page.getByRole('link', { name: 'Media', exact: true }).click()
  // The media library renders a dropzone + grid (not the generic table).
  await expect(page.locator('.media-dropzone')).toBeVisible()

  // Drag-drop maps to the hidden file input; required `alt` is auto-filled from
  // the filename, so the upload completes without a form.
  await page.locator('.media-dropzone input[type="file"]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  })

  // The uploaded image appears as a card thumbnail served from /files/media/.
  const thumb = page.locator('.media-card img')
  await expect(thumb.first()).toBeVisible()
  await expect(thumb.first()).toHaveAttribute('src', /^\/files\/media\//)
  await expect(page.locator('.media-card', { hasText: 'pixel.png' }).first()).toBeVisible()
})

test('list: search filters rows, columns toggle, and bulk delete removes selected', async ({ page, request }) => {
  await ensureSignedIn(page)

  // Seed two articles via the API (service key overrides access).
  const headers = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }
  await request.post('/api/articles', { headers, data: { title: 'Alpha report', _status: 'published' } })
  await request.post('/api/articles', { headers, data: { title: 'Beta report', _status: 'published' } })

  await page.getByRole('link', { name: 'Articles', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'Alpha report' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Beta report' })).toBeVisible()

  // Search narrows the list to a single match. (Driven via the native value setter +
  // input event — the React-controlled way — which is reliable across browsers.)
  const search = page.locator('.list-search')
  const setSearch = (value: string) =>
    search.evaluate((el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
  await setSearch('Alpha')
  await expect(page.getByRole('cell', { name: 'Alpha report' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Beta report' })).toHaveCount(0)
  await setSearch('')
  await expect(page.getByRole('cell', { name: 'Beta report' })).toBeVisible()

  // Column visibility: hiding "UpdatedAt" removes its header.
  await expect(page.getByRole('columnheader', { name: 'UpdatedAt' })).toBeVisible()
  await page.getByRole('button', { name: 'Columns' }).click()
  await page.getByRole('checkbox', { name: 'UpdatedAt' }).uncheck()
  await expect(page.getByRole('columnheader', { name: 'UpdatedAt' })).toHaveCount(0)

  // Bulk delete: select all on the page, confirm, and both rows are gone.
  await page.getByRole('checkbox', { name: 'Select all on this page' }).check()
  await page.locator('.bulk-bar').getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('cell', { name: 'Alpha report' })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: 'Beta report' })).toHaveCount(0)
})
