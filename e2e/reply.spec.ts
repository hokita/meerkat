import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import { expect, test, type Meerkat } from './fixtures.js'
import { fakeAgent, fakeSnapshot, type ReceivedRequest } from '../test-support/fake-herdr.js'

const agents = {
  blocked: fakeAgent({ pane_id: 'w1:p1', name: 'blocked-one', agent_status: 'blocked' }),
  asking: fakeAgent({ pane_id: 'w2:p1', name: 'asking-one', agent_status: 'blocked' }),
  idle: fakeAgent({ pane_id: 'w3:p1', name: 'idle-one', agent_status: 'idle' }),
  lost: fakeAgent({ pane_id: 'w4:p1', name: 'lost-one', agent_status: 'blocked' }),
}

const INPUT_METHODS = new Set(['agent.prompt', 'agent.send_keys', 'pane.send_text'])

function screen(name: string): string {
  return readFileSync(new URL(`../test-support/screens/${name}`, import.meta.url), 'utf8')
}

function inputs(meerkat: Meerkat): ReceivedRequest[] {
  return meerkat.fake.received.filter((entry) => INPUT_METHODS.has(entry.method))
}

function keys(target: string, pressed: string[]): ReceivedRequest {
  return { method: 'agent.send_keys', params: { target, keys: pressed } }
}

async function openReply(page: Page, meerkat: Meerkat, name: RegExp): Promise<Locator> {
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name }).click()
  return page.getByRole('dialog').getByRole('region', { name: 'Reply' })
}

test.use({ initialSnapshot: fakeSnapshot({ agents: Object.values(agents) }) })

test('answers a permission only after the in-page confirm and shows the last reply', async ({
  page,
  meerkat,
}) => {
  const pane = agents.blocked.pane_id
  meerkat.fake.setRead(pane, screen('permission-bash.txt'))
  meerkat.fake.onInput(() => meerkat.fake.setRead(pane, screen('idle-empty.txt')))
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name: /blocked-one/ }).click()
  const panel = page.getByRole('dialog').getByRole('region', { name: 'Reply' })
  await expect(panel.locator('pre')).toContainText('touch made-by-bash.txt')
  await panel.getByRole('button', { name: 'Yes', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect(inputs(meerkat)).toEqual([])
  await panel
    .getByRole('group', { name: 'Confirm reply' })
    .getByRole('button', { name: 'Send' })
    .click()
  await expect(panel.getByText('Sent')).toBeVisible()
  expect(inputs(meerkat)).toEqual([keys(pane, ['1'])])
  await expect(page.locator('button.card', { hasText: /blocked-one/ })).toContainText(
    /Answered "Yes" from Meerkat · /
  )
})

test('cancelling the confirm sends nothing', async ({ page, meerkat }) => {
  meerkat.fake.setRead(agents.blocked.pane_id, screen('permission-bash.txt'))
  await page.goto(meerkat.baseURL)
  await page.getByRole('button', { name: /blocked-one/ }).click()
  const panel = page.getByRole('dialog').getByRole('region', { name: 'Reply' })
  await panel.getByRole('button', { name: 'Yes', exact: true }).click()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel.getByRole('group', { name: 'Confirm reply' })).toBeHidden()
  expect(inputs(meerkat)).toEqual([])
})

test('picks a choice and the card leaves the reply state when the agent works again', async ({
  page,
  meerkat,
}) => {
  const pane = agents.asking.pane_id
  meerkat.fake.setRead(pane, screen('choice-single.txt'))
  meerkat.fake.onInput(() => {
    meerkat.fake.setRead(pane, screen('idle-empty.txt'))
    meerkat.fake.pushStatus(pane, 'working')
  })
  const panel = await openReply(page, meerkat, /asking-one/)
  await expect(panel.getByText('Which color should the note use?')).toBeVisible()
  await panel.getByRole('button', { name: /Red/ }).click()
  await expect.poll(() => inputs(meerkat)).toEqual([keys(pane, ['1'])])
  await expect(page.getByRole('region', { name: 'Working' }).getByRole('button')).toContainText(
    'asking-one'
  )
  await expect(panel).toBeHidden()
})

test('types into "Type something"', async ({ page, meerkat }) => {
  const pane = agents.asking.pane_id
  meerkat.fake.setRead(pane, screen('choice-single.txt'))
  const panel = await openReply(page, meerkat, /asking-one/)
  await panel.getByRole('button', { name: 'Type something.' }).click()
  await panel.getByRole('textbox', { name: 'Your answer' }).fill('Green please')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(panel.getByText('Sent')).toBeVisible()
  expect(inputs(meerkat)).toEqual([
    keys(pane, ['3']),
    { method: 'pane.send_text', params: { pane_id: pane, text: 'Green please' } },
    keys(pane, ['enter']),
  ])
})

test('sends "continue" to an idle session', async ({ page, meerkat }) => {
  const pane = agents.idle.pane_id
  meerkat.fake.setRead(pane, screen('idle-empty.txt'))
  const panel = await openReply(page, meerkat, /idle-one/)
  await panel.getByRole('textbox', { name: 'Message' }).fill('continue')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(panel.getByText('Sent')).toBeVisible()
  expect(inputs(meerkat)).toEqual([
    { method: 'agent.prompt', params: { target: pane, text: 'continue' } },
  ])
})

test('presses a key on an unrecognized screen after the confirm', async ({ page, meerkat }) => {
  const pane = agents.lost.pane_id
  meerkat.fake.setRead(pane, screen('trust.txt'))
  const panel = await openReply(page, meerkat, /lost-one/)
  await expect(panel.getByText("Meerkat couldn't read this prompt")).toBeVisible()
  await panel.getByRole('group', { name: 'Keys' }).getByRole('button', { name: '2' }).click()
  expect(inputs(meerkat)).toEqual([])
  await panel
    .getByRole('group', { name: 'Confirm reply' })
    .getByRole('button', { name: 'Send' })
    .click()
  await expect(panel.getByText('Sent')).toBeVisible()
  expect(inputs(meerkat)).toEqual([keys(pane, ['2'])])
})

test('a double click sends once', async ({ page, meerkat }) => {
  const pane = agents.asking.pane_id
  meerkat.fake.setRead(pane, screen('choice-single.txt'))
  const panel = await openReply(page, meerkat, /asking-one/)
  await panel.getByRole('button', { name: /Red/ }).dblclick()
  await expect(panel.getByText('Sent')).toBeVisible()
  await page.request.get(`${meerkat.baseURL}/api/sessions/${encodeURIComponent(pane)}/output`)
  expect(inputs(meerkat)).toEqual([keys(pane, ['1'])])
})

test('a changed prompt is shown and nothing is sent', async ({ page, meerkat }) => {
  const pane = agents.blocked.pane_id
  meerkat.fake.setRead(pane, screen('permission-bash.txt'))
  const panel = await openReply(page, meerkat, /blocked-one/)
  await expect(panel.locator('pre')).toContainText('touch made-by-bash.txt')
  meerkat.fake.setRead(pane, screen('permission-edit.txt'))
  await panel.getByRole('button', { name: 'No', exact: true }).click()
  await expect(panel.getByText('The prompt changed')).toBeVisible()
  await expect(panel.locator('pre')).toContainText('notes.txt')
  expect(inputs(meerkat)).toEqual([])
})

test('a page from another local port is refused by Meerkat and cannot send input', async ({
  page,
  meerkat,
}) => {
  const pane = agents.asking.pane_id
  meerkat.fake.setRead(pane, screen('choice-single.txt'))
  await page.goto(meerkat.baseURL)
  const token = await page.locator('meta[name="meerkat-token"]').getAttribute('content')
  const output = await page.request.get(
    `${meerkat.baseURL}/api/sessions/${encodeURIComponent(pane)}/output`
  )
  const { prompt } = (await output.json()) as { prompt: { fingerprint: string } }
  const replyUrl = `${meerkat.baseURL}/api/sessions/${encodeURIComponent(pane)}/reply`
  const attack = (replyId: string) => ({
    replyId,
    fingerprint: prompt.fingerprint,
    action: { type: 'option', n: 1 },
  })
  const evilHtml = `<!doctype html><title>other</title><body><p id="out"></p><script>
const params = new URLSearchParams(location.search)
const target = params.get('target')
const token = params.get('token')
const json = fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Meerkat-Token': token },
  body: params.get('jsonBody'),
}).then(() => 'json-answered', () => 'json-blocked')
const simple = fetch(target, {
  method: 'POST',
  mode: 'no-cors',
  headers: { 'Content-Type': 'text/plain' },
  body: params.get('simpleBody'),
}).then(() => 'simple-answered', () => 'simple-blocked')
Promise.all([json, simple]).then((results) => {
  document.getElementById('out').textContent = 'settled ' + results.join(' ')
})
</script>`
  const other: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(evilHtml)
  })
  try {
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    const { port } = other.address() as AddressInfo
    const evil = await page.context().newPage()
    const failed: string[] = []
    const answers: { method: string; status: number }[] = []
    evil.on('requestfailed', (request) => {
      if (request.url() === replyUrl) failed.push(request.method())
    })
    evil.on('response', (response) => {
      if (response.url() === replyUrl) {
        answers.push({ method: response.request().method(), status: response.status() })
      }
    })
    const cdp = await page.context().newCDPSession(evil)
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', (event) => {
      if (event.type === 'Preflight' && event.response.url === replyUrl) {
        answers.push({ method: 'OPTIONS', status: event.response.status })
      }
    })
    const query = new URLSearchParams({
      target: replyUrl,
      token: token ?? '',
      jsonBody: JSON.stringify(attack('evil-json')),
      simpleBody: JSON.stringify(attack('evil-simple')),
    })
    await evil.goto(`http://127.0.0.1:${port}/?${query.toString()}`)
    await expect(evil.locator('#out')).toContainText('settled')
    await expect.poll(() => answers).toContainEqual({ method: 'POST', status: 403 })
    await expect.poll(() => answers).toContainEqual({ method: 'OPTIONS', status: 405 })
    await expect.poll(() => failed).toEqual(['POST'])
    expect(answers.filter((entry) => entry.method === 'POST')).toEqual([
      { method: 'POST', status: 403 },
    ])
    expect(inputs(meerkat)).toEqual([])
    await evil.close()

    const control = await page.evaluate(
      async ({ url, headerToken, body }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Meerkat-Token': headerToken },
          body: JSON.stringify(body),
        })
        return response.status
      },
      { url: replyUrl, headerToken: token ?? '', body: attack(crypto.randomUUID()) }
    )
    expect(control).toBe(200)
    expect(inputs(meerkat)).toEqual([keys(pane, ['1'])])
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }
})

test('every reply kind sends exactly the Herdr methods it needs', async ({ page, meerkat }) => {
  const { fake } = meerkat
  await page.goto(meerkat.baseURL)
  const flows: {
    pane: RegExp
    id: string
    read: string
    run: (panel: Locator) => Promise<void>
  }[] = [
    {
      pane: /asking-one/,
      id: agents.asking.pane_id,
      read: 'choice-single.txt',
      run: async (panel) => {
        await panel.getByRole('button', { name: /Blue/ }).click()
      },
    },
    {
      pane: /asking-one/,
      id: agents.asking.pane_id,
      read: 'choice-single.txt',
      run: async (panel) => {
        await panel.getByRole('button', { name: 'Type something.' }).click()
        await panel.getByRole('textbox', { name: 'Your answer' }).fill('Teal')
        await panel.getByRole('button', { name: 'Send', exact: true }).click()
      },
    },
    {
      pane: /idle-one/,
      id: agents.idle.pane_id,
      read: 'idle-empty.txt',
      run: async (panel) => {
        await panel.getByRole('textbox', { name: 'Message' }).fill('go on')
        await panel.getByRole('button', { name: 'Send', exact: true }).click()
      },
    },
    {
      pane: /lost-one/,
      id: agents.lost.pane_id,
      read: 'trust.txt',
      run: async (panel) => {
        await panel.getByRole('button', { name: 'Esc' }).click()
      },
    },
    {
      pane: /lost-one/,
      id: agents.lost.pane_id,
      read: 'trust.txt',
      run: async (panel) => {
        await panel.getByRole('textbox', { name: 'Text to type' }).fill('hello')
        await panel.getByRole('button', { name: 'Send', exact: true }).click()
      },
    },
  ]
  const expected = [
    ['agent.send_keys'],
    ['agent.send_keys', 'pane.send_text', 'agent.send_keys'],
    ['agent.prompt'],
    ['agent.send_keys'],
    ['pane.send_text'],
  ]
  for (const [index, flow] of flows.entries()) {
    fake.setRead(flow.id, screen(flow.read))
    const before = inputs(meerkat).length
    await page.getByRole('button', { name: flow.pane }).click()
    const panel = page.getByRole('dialog').getByRole('region', { name: 'Reply' })
    await flow.run(panel)
    await expect(panel.getByText('Sent')).toBeVisible()
    expect(
      inputs(meerkat)
        .slice(before)
        .map((entry) => entry.method)
    ).toEqual(expected[index])
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  }
  const methods = new Set(inputs(meerkat).map((entry) => entry.method))
  expect(methods).toEqual(INPUT_METHODS)
})
