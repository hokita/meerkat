import { expect, test, type Meerkat } from './fixtures.js'
import { fakeAgent, fakeSnapshot } from '../test-support/fake-herdr.js'

function column(page: import('@playwright/test').Page, title: string) {
  return page.getByRole('region', { name: title })
}

const agents = {
  done: fakeAgent({ pane_id: 'w1:p1', name: 'done-one', agent_status: 'done' }),
  blocked: fakeAgent({ pane_id: 'w2:p1', name: 'blocked-one', agent_status: 'blocked' }),
  working: fakeAgent({ pane_id: 'w3:p1', name: 'working-one', agent_status: 'working' }),
  idle: fakeAgent({ pane_id: 'w4:p1', name: 'idle-one', agent_status: 'idle' }),
  unnamed: fakeAgent({ pane_id: 'w5:p1', name: null, agent_status: 'idle' }),
}

const initialSnapshot = fakeSnapshot({ agents: Object.values(agents) })

function changeStatus(meerkat: Meerkat, paneId: string, status: string): void {
  const moved = Object.values(agents).map((agent) =>
    agent.pane_id === paneId ? { ...agent, agent_status: status } : agent
  )
  meerkat.fake.setSnapshot(fakeSnapshot({ agents: moved }))
  meerkat.fake.pushStatus(paneId, status)
}

test.use({ initialSnapshot })

test('shows sessions in columns', async ({ page, meerkat }) => {
  await page.goto(meerkat.baseURL)
  await expect(page.locator('section.column h2 > span:first-child')).toHaveText([
    'Waiting for you',
    'Done',
    'Working',
    'Idle',
  ])
  await expect(
    column(page, 'Waiting for you').getByRole('button', { name: /blocked-one/ })
  ).toBeVisible()
  await expect(column(page, 'Done').getByRole('button', { name: /done-one/ })).toBeVisible()
  await expect(column(page, 'Working').getByRole('button', { name: /working-one/ })).toBeVisible()
  const idle = column(page, 'Idle')
  await expect(idle.getByRole('button', { name: /idle-one/ })).toBeVisible()
  await expect(idle.getByText('(unnamed)')).toBeVisible()
})

test('moves a card when status changes', async ({ page, meerkat }) => {
  await page.goto(meerkat.baseURL)
  await expect(column(page, 'Working').getByRole('button', { name: /working-one/ })).toBeVisible()
  changeStatus(meerkat, agents.working.pane_id, 'blocked')
  await expect(
    column(page, 'Waiting for you').getByRole('button', { name: /working-one/ })
  ).toBeVisible({ timeout: 2000 })
  changeStatus(meerkat, agents.working.pane_id, 'done')
  await expect(column(page, 'Done').getByRole('button', { name: /working-one/ })).toBeVisible({
    timeout: 2000,
  })
  await expect(
    column(page, 'Waiting for you').getByRole('button', { name: /working-one/ })
  ).toHaveCount(0)
})

test('lays out four, two and one columns by width', async ({ page, meerkat }) => {
  await page.goto(meerkat.baseURL)
  await expect(page.getByRole('region')).toHaveCount(4)
  for (const [width, height, columns] of [
    [1280, 800, 4],
    [1024, 768, 2],
    [390, 844, 1],
  ] as const) {
    await page.setViewportSize({ width, height })
    const boxes = await Promise.all(
      (await page.getByRole('region').all()).map((region) => region.boundingBox())
    )
    const lefts = new Set(boxes.map((box) => Math.round(box?.x ?? -1)))
    expect(lefts.size, `columns at ${width}px`).toBe(columns)
    const fits: unknown = await page.evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth'
    )
    expect(fits, `no horizontal scroll at ${width}px`).toBe(true)
  }
})

test('drawer stays on a card that moves from Waiting for you to Done', async ({
  page,
  meerkat,
}) => {
  meerkat.fake.setRead(agents.blocked.pane_id, 'question')
  await page.goto(meerkat.baseURL)
  await column(page, 'Waiting for you')
    .getByRole('button', { name: /blocked-one/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Output for blocked-one' })
  await expect(dialog.locator('pre')).toHaveText('question')
  changeStatus(meerkat, agents.blocked.pane_id, 'done')
  await expect(column(page, 'Done').getByRole('button', { name: /blocked-one/ })).toBeAttached({
    timeout: 2000,
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Session closed')).toHaveCount(0)
})

test('opens output', async ({ page, meerkat }) => {
  meerkat.fake.setRead(agents.working.pane_id, 'hello \x1b[32mworld\x1b[0m <b>x</b>')
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name: /working-one/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('pre')).toHaveText('hello world <b>x</b>')
  await expect(dialog.locator('b')).toHaveCount(0)
})

test('session closes while output is open', async ({ page, meerkat }) => {
  const pane = agents.working.pane_id
  meerkat.fake.setRead(pane, 'output')
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name: /working-one/ }).click()
  await expect(page.getByRole('dialog').locator('pre')).toHaveText('output')
  const remaining = Object.values(agents).filter((agent) => agent.pane_id !== pane)
  meerkat.fake.setSnapshot(fakeSnapshot({ agents: remaining }))
  meerkat.fake.pushRaw('{"event":"pane.closed","data":{}}')
  meerkat.fake.setRead(pane, null)
  await expect(page.getByRole('dialog').getByText('Session closed')).toBeVisible({
    timeout: 10_000,
  })
})

test('survives a Herdr restart', async ({ page, meerkat }) => {
  await page.goto(meerkat.baseURL)
  await expect(page.getByRole('button', { name: /idle-one/ })).toBeVisible()
  const banner = page.getByText('Herdr is not reachable — showing last known state')
  await meerkat.fake.stop()
  await expect(banner).toBeVisible({ timeout: 10_000 })
  meerkat.fake.setSnapshot(
    fakeSnapshot({
      agents: [fakeAgent({ pane_id: 'w9:p1', name: 'reborn', agent_status: 'working' })],
    })
  )
  await meerkat.fake.restart()
  await expect(banner).toBeHidden({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: /reborn/ })).toBeVisible({ timeout: 10_000 })
})

test.describe('with 60 sessions', () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    fakeAgent({ pane_id: `wm${index}:p1`, name: `many-${index}`, agent_status: 'working' })
  )
  test.use({ initialSnapshot: fakeSnapshot({ agents: many }) })

  test('renders 60 sessions', async ({ page, meerkat }) => {
    await page.goto(meerkat.baseURL)
    await expect(page.locator('button.card')).toHaveCount(60)
    const subscribes = meerkat.fake.received.filter((entry) => entry.method === 'events.subscribe')
    expect(subscribes).toHaveLength(1)
    const params = subscribes[0]?.params as { subscriptions: { type: string }[] }
    const statusSubscriptions = params.subscriptions.filter(
      (subscription) => subscription.type === 'pane.agent_status_changed'
    )
    expect(statusSubscriptions).toHaveLength(60)
  })

  test('opens output for one of 60 sessions', async ({ page, meerkat }) => {
    const last = many.at(-1)
    if (last === undefined) throw new Error('no sessions')
    meerkat.fake.setRead(last.pane_id, 'many output')
    await page.goto(meerkat.baseURL)
    await page.getByRole('button', { name: /many-59/ }).click()
    await expect(page.getByRole('dialog').locator('pre')).toHaveText('many output')
  })
})

test.describe('with progress reads', () => {
  test.use({
    initialReads: {
      [agents.working.pane_id]:
        '⏺ Bash(npm test)\n  ⎿  ok\n\n⏺ Tests are green; writing the docs next.\n\n❯ ',
    },
  })

  test('shows progress on the card and updates it on status change', async ({ page, meerkat }) => {
    await page.goto(meerkat.baseURL)
    const working = column(page, 'Working').getByRole('button', { name: /working-one/ })
    await expect(working).toContainText('Tests are green; writing the docs next.')
    await expect(working).toContainText(/updated ≥ \d+s ago/)

    meerkat.fake.setRead(agents.working.pane_id, '⏺ Docs written; all checks pass.')
    changeStatus(meerkat, agents.working.pane_id, 'done')
    const done = column(page, 'Done').getByRole('button', { name: /working-one/ })
    await expect(done).toContainText('Docs written; all checks pass.')
    await expect(done).toContainText(/updated \d+s ago/)
  })

  test('shows the newest sentence for a blocked session on a short pane', async ({
    page,
    meerkat,
  }) => {
    await page.goto(meerkat.baseURL)
    const working = column(page, 'Working').getByRole('button', { name: /working-one/ })
    await expect(working).toContainText('Tests are green; writing the docs next.')

    meerkat.fake.setBusyViewport(agents.working.pane_id, 28)
    meerkat.fake.setRead(
      agents.working.pane_id,
      '⏺ Need your OK to proceed.\n─────\n Do you want to proceed?\n ❯ 1. Yes\n   2. No'
    )
    changeStatus(meerkat, agents.working.pane_id, 'blocked')
    const waiting = column(page, 'Waiting for you').getByRole('button', { name: /working-one/ })
    await expect(waiting).toContainText('Need your OK to proceed.')
  })
})

test('only read methods reach Herdr', async ({ page, meerkat }) => {
  meerkat.fake.setRead(agents.working.pane_id, 'text')
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name: /working-one/ }).click()
  await expect(page.getByRole('dialog').locator('pre')).toHaveText('text')
  changeStatus(meerkat, agents.working.pane_id, 'done')
  await expect(column(page, 'Done').getByRole('button', { name: /working-one/ })).toBeVisible()
  await meerkat.fake.restart()
  await expect(page.getByRole('button', { name: /idle-one/ })).toBeVisible()
  expect(meerkat.fake.received.length).toBeGreaterThan(0)
})

test('rejects a foreign Host', async ({ request, meerkat }) => {
  const response = await request.get(meerkat.baseURL, {
    headers: { Host: 'evil.example:43219' },
  })
  expect(response.status()).toBe(421)
  const names = Object.keys(response.headers())
  expect(names.filter((name) => name.startsWith('access-control-'))).toEqual([])
})
