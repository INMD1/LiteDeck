// The browser half of testdata/e2e/run.sh.
//
// Every check ends at the server, not at the screen. The app saying a file was
// renamed is exactly what it said while renaming files into the wrong directory,
// so each step reads the result back through a channel this app is not part of
// and compares. What the UI claims is never the evidence.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const URL = process.env.LITEDECK_E2E_URL ?? 'http://127.0.0.1:18765'
const CONTAINER = process.env.LITEDECK_E2E_CONTAINER ?? 'litedeck-e2e'
const ARTIFACTS = process.env.LITEDECK_E2E_ARTIFACTS ?? '.'
const DIR = '/srv/api'

let failures = 0
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail && !ok ? `\n        ${detail}` : ''}`)
}

// onServer runs a command in the demo container as the login user.
//
// Through docker rather than over SSH, so it cannot be satisfied by the same
// connection the app is using. A hung channel would otherwise make both halves
// of the test hang together and agree with each other.
function onServer(cmd) {
  return execFileSync('docker', ['exec', '-u', 'deploy', CONTAINER, 'bash', '-lc', cmd], {
    encoding: 'utf8',
  }).trim()
}

function exists(path) {
  try {
    return onServer(`test -e ${JSON.stringify(path)} && echo yes || echo no`) === 'yes'
  } catch {
    return false
  }
}

// The browser already on the machine, by default. Setting the variable to an
// empty string asks for whatever Playwright itself has downloaded, which is how
// this runs where Chrome is not installed.
const channel = process.env.LITEDECK_E2E_CHANNEL ?? 'chrome'
const browser = await chromium.launch(channel ? { channel } : {})
// A light desktop, pinned. The theme checks below move the picker back to
// "follow the OS" and assert the colours do not move, which needs the OS half
// of that to be a known quantity rather than whatever the machine running this
// happens to be set to.
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'light',
})
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

// Every wait is scaled, and the scale is generous by default.
//
// A timeout costs nothing on a run that passes — nobody waits it out — and it
// is the whole of the answer on a run that does not. This harness was written
// against a laptop with the demo image already built, and the first time it met
// a loaded runner it failed: the same checks that take fifty seconds there took
// two minutes eighteen and then gave up. The waits were sized for the fast
// machine, which is the one case that never needed them.
//
// The demo container is the reason a runner can be this slow. Its first boot
// pulls three images through Docker-in-Docker on the vfs storage driver, and
// that runs while these checks do.
const SCALE = Number(process.env.LITEDECK_E2E_TIMEOUT_SCALE ?? 3)
const ms = (base) => Math.round(base * SCALE)

const visible = (loc, timeout) =>
  loc.waitFor({ state: 'visible', timeout }).then(() => true, () => false)

// row addresses one line of the file tree by its exact name.
//
// By the name span rather than by text anywhere in the row, because a row also
// carries a size, a permission string and a date, and "26" is a plausible file
// name. Anchored, so package.json does not answer to json.
const row = (name) =>
  page.locator('.file-tree .trow').filter({
    has: page.locator('.tree-name > span.ellipsis', {
      hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  })

// open double-clicks nothing.
//
// The tree is virtualised: it recycles a fixed pool of row elements and moves
// them with transform. Between the two halves of a double-click the element
// under the pointer can be holding a different file, and it does — the first
// version of this opened package.json while asking for README.md. Select, then
// press Enter, which is the app's own shortcut and involves no second hit test.
async function open(name) {
  await row(name).first().click()
  await page.keyboard.press('Enter')
}

// What the file tree is showing, for a failure that has to explain itself.
//
// This check failed on a runner and passed on every machine here, including
// with every directory call delayed by eight seconds, so the next failure has
// to arrive with its own evidence rather than another guess.
async function treeState() {
  return page.evaluate(() => {
    const box = document.querySelector('.file-tree .view-toolbar input.search')
    const ph = document.querySelector('.file-tree .placeholder')
    const err = document.querySelector('.error, .warn-text, .error-banner')
    return {
      path: box ? box.value : '(no path box)',
      rows: document.querySelectorAll('.file-tree .trow').length,
      placeholder: ph ? ph.textContent.trim().slice(0, 80) : null,
      error: err ? err.textContent.trim().slice(0, 120) : null,
    }
  })
}

/**
 * Navigates the file tree, and keeps asking.
 *
 * Typing a path and pressing Enter is one shot at a server that might be busy,
 * and one shot is what failed in CI: the listing for the second connection
 * never arrived and the run ended there. Three tries cost nothing on a machine
 * where the first works.
 *
 * The wait before the first attempt is not decoration either. The path box is
 * empty until the home directory lands, and typing into a control the app is
 * about to fill in is a race that only shows up on a slow box.
 */
async function goTo(dir, marker) {
  const box = page.locator('.file-tree .view-toolbar input.search').first()
  await box.waitFor({ state: 'visible', timeout: ms(15000) })
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.file-tree .view-toolbar input.search')
        return el && el.value.length > 0
      },
      null,
      { timeout: ms(30000) },
    )
    .catch(() => {})

  for (let attempt = 1; attempt <= 3; attempt++) {
    await box.fill(dir)
    await box.press('Enter')
    if (await visible(row(marker).first(), ms(20000))) return true
    console.log(`        (${dir} did not list on attempt ${attempt}: ${JSON.stringify(await treeState())})`)
  }
  return false
}

try {
  // -- connect -----------------------------------------------------------
  await page.goto(URL, { waitUntil: 'networkidle' })

  const connect = page.getByRole('button', { name: 'Connect', exact: true })
  if ((await connect.count()) > 0) {
    await connect.click()
    // First contact with this host key. Answering it is part of the path under
    // test: the prompt travels over the web transport like everything else.
    const trust = page.getByRole('button', { name: 'Always trust' })
    const asked = await visible(trust, ms(15000))
    if (asked) await trust.click()
    check('the host key prompt is offered and answered', asked)
  }

  const files = page.getByRole('button', { name: 'Files', exact: true })
  check('the tabs appear once the host is connected', await visible(files, ms(30000)))
  await files.click()

  // -- navigate ----------------------------------------------------------
  const listed = await goTo(DIR, 'README.md')
  check(`${DIR} lists its contents`, listed, JSON.stringify(await treeState()))
  if (!listed) throw new Error('the listing never arrived; nothing after this could mean anything')

  // -- the editor writes to the server -----------------------------------
  const marker = `e2e-${Date.now()}`
  await open('README.md')
  const editor = page.locator('.cm-content')
  await editor.waitFor({ state: 'visible', timeout: ms(20000) })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(`\n${marker}\n`)
  // The button rather than the shortcut. A shortcut tests the key handler; the
  // button is what the person clicks, and both end in the same save.
  //
  // Matched by prefix: the label carries a bullet while there is something
  // unsaved, so an exact "Save" finds nothing at the one moment it matters.
  await page.locator('button').filter({ hasText: /^Save/ }).first().click()

  // Saving shows the diff against the server's copy first. Confirming it is
  // part of the path, and the dialog appearing at all is worth asserting: it is
  // the last thing between a stale editor buffer and somebody's file.
  const diff = page.locator('.diff-dialog')
  const shownDiff = await visible(diff, ms(15000))
  check('saving shows the diff against the server copy first', shownDiff)
  if (shownDiff) await diff.locator('button').filter({ hasText: /^Save/ }).first().click()

  let saved = false
  for (let i = 0; i < 40 * SCALE && !saved; i++) {
    await page.waitForTimeout(500)
    try {
      saved = onServer(`grep -c ${JSON.stringify(marker)} ${DIR}/README.md || true`) !== '0'
    } catch {
      saved = false
    }
  }
  check(
    'the editor writes through to the file on the server',
    saved,
    `${DIR}/README.md does not contain ${marker}`,
  )

  // -- new folder --------------------------------------------------------
  const sub = `e2e-sub-${Date.now()}`
  await page.getByRole('button', { name: 'New folder' }).click()
  const nameBox = page.locator('form.dialog input').first()
  const asked = await visible(nameBox, ms(10000))
  if (asked) {
    await nameBox.fill(sub)
    await nameBox.press('Enter')
  }
  let made = false
  for (let i = 0; i < 20 * SCALE && asked && !made; i++) {
    await page.waitForTimeout(500)
    made = exists(`${DIR}/${sub}`)
  }
  check('New folder creates the directory on the server', made, `${DIR}/${sub} is not there`)

  // -- delete ------------------------------------------------------------
  if (made) {
    await row(sub).first().click()
    await page.locator('.view-toolbar').getByRole('button', { name: 'Delete', exact: true }).click()
    const confirm = page.locator('form.dialog, .dialog').getByRole('button', { name: /Delete|OK/ }).last()
    if (await visible(confirm, ms(8000))) await confirm.click()
    let gone = false
    for (let i = 0; i < 20 * SCALE && !gone; i++) {
      await page.waitForTimeout(500)
      gone = !exists(`${DIR}/${sub}`)
    }
    check('deleting removes the directory from the server', gone, `${DIR}/${sub} is still there`)
    if (!gone) onServer(`rm -rf ${JSON.stringify(`${DIR}/${sub}`)}`)
  }

  // -- terminal splits ---------------------------------------------------
  //
  // Each pane is a shell channel on the connection that is already open. What
  // can go wrong is the bookkeeping: a pane closed in the UI whose channel
  // stays open on the server, which nothing on screen would show until the
  // host ran out of slots. So the server is asked directly — through docker,
  // not the app's own connection — how many terminals the login user has.
  const ptys = () => {
    try {
      return Number(onServer(`ps -u deploy -o tty= | grep -c pts || true`))
    } catch {
      return -1
    }
  }
  const settlePtys = async (want) => {
    let got = -1
    for (let i = 0; i < 30 * SCALE; i++) {
      got = ptys()
      if (got === want) return got
      await page.waitForTimeout(200)
    }
    return got
  }
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const cells = page.locator('.term-slot[data-active] .term-cell')
  const firstPane = await visible(cells.first(), ms(20000))
  check('the terminal opens', firstPane)
  if (firstPane) {
    const before = await settlePtys(1)
    check('one pane is one terminal on the server', before === 1, `the server has ${before}`)

    await page.getByRole('button', { name: 'Split side by side', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.term-slot[data-active] .term-cell').length === 2,
      null,
      { timeout: ms(15000) },
    )
    await page.getByRole('button', { name: 'Split top and bottom', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.term-slot[data-active] .term-cell').length === 3,
      null,
      { timeout: ms(15000) },
    )
    const three = await settlePtys(3)
    check('splitting twice gives three panes and three terminals', three === 3, `the server has ${three}`)

    // Twelve more opened and closed, one at a time. A leak of one channel per
    // round would leave fifteen; the budget would have refused long before.
    for (let i = 0; i < 12; i++) {
      await page.getByRole('button', { name: 'Split side by side', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.term-slot[data-active] .term-cell').length === 4,
        null,
        { timeout: ms(15000) },
      )
      const focused = page.locator('.term-slot[data-active] .term-cell[data-focus]')
      await focused.hover()
      await focused.getByRole('button', { name: 'Close this pane', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.term-slot[data-active] .term-cell').length === 3,
        null,
        { timeout: ms(15000) },
      )
    }
    const after = await settlePtys(3)
    check('twelve panes opened and closed leave no channel behind', after === 3, `the server has ${after}`)

    // Past the budget the server is not asked at all, and the reason is on the
    // screen in words — not a pane that never appears.
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Split side by side', exact: true }).click()
      await page.waitForTimeout(ms(400))
    }
    await page.getByRole('button', { name: 'Split side by side', exact: true }).click()
    const told = await visible(page.locator('.error', { hasText: 'MaxSessions' }), ms(10000))
    check('a split past the channel budget says why', told)
    const capped = await settlePtys(5)
    check('the budget holds on the server', capped === 5, `the server has ${capped}`)
    const dismiss = page.locator('.error').getByRole('button', { name: 'Close', exact: true })
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click()

    // The arrangement survives a reload: Go still holds the shells, and the
    // page puts them back where they were rather than one tab each.
    await page.reload()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click().catch(() => {})
    let restored = 0
    for (let i = 0; i < 30 * SCALE; i++) {
      restored = await page.locator('.term-slot[data-active] .term-cell').count()
      if (restored === 5) break
      await page.waitForTimeout(200)
    }
    check('a reload puts the panes back in one tab', restored === 5, `${restored} panes in the tab`)

    // Back to one pane, so the reconnect below starts from where it used to.
    for (let i = 0; i < 4; i++) {
      const focused = page.locator('.term-slot[data-active] .term-cell[data-focus]')
      await focused.hover()
      await focused.getByRole('button', { name: 'Close this pane', exact: true }).click()
      await page.waitForTimeout(ms(200))
    }
    const one = await settlePtys(1)
    check('closing panes closes their terminals', one === 1, `the server has ${one}`)
    await page.getByRole('button', { name: 'Files', exact: true }).click()
  }

  // -- reconnect ---------------------------------------------------------
  //
  // Not a formality. The reconnect path is where a pending prompt used to be
  // dropped, leaving a connection waiting for an answer nobody would be asked.
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  const reconnect = page.getByRole('button', { name: 'Connect', exact: true })
  await reconnect.waitFor({ state: 'visible', timeout: ms(20000) })
  await page.waitForTimeout(500)
  await reconnect.click()
  const backAgain = await visible(page.getByRole('button', { name: 'Files', exact: true }), ms(30000))
  check('the host reconnects after a disconnect', backAgain)

  if (backAgain) {
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const relisted = await goTo(DIR, 'README.md')
    check(
      'the file listing works on the second connection',
      relisted,
      JSON.stringify(await treeState()),
    )
  }

  // -- the theme picker --------------------------------------------------
  //
  // Two positions, and both have to stick. The picker is a controlled <select>
  // over a module variable, so React restores it to its last rendered value
  // unless the change produces a re-render — the colours moved and the control
  // snapped back, which showed or did not depending on whether something else
  // re-rendered the rail in the same tick.
  //
  // The browser is told to report a light desktop, so the position the picker
  // opens on is known: nothing is stored on a fresh config, and an unstored
  // theme resolves against the OS.
  const picker = page.locator('select[aria-label="테마"], select[aria-label="Theme"]').first()
  if (await visible(picker, ms(10000))) {
    const at = () => page.evaluate(() => document.documentElement.dataset.theme)
    const opened = await picker.inputValue()
    check('the picker opens on what the desktop is set to', opened === 'light', `it reads ${opened}`)

    let ok = true
    // Back to light at the end so the run leaves the config as it found it.
    for (const want of ['dark', 'light', 'dark', 'light']) {
      await picker.selectOption(want)
      // Polled rather than slept through. A fixed pause is a guess about the
      // slowest machine that will ever run this, and the guess was wrong once
      // already; waiting for the state itself is right on every machine and
      // faster on most.
      let shown = ''
      let stamped = ''
      for (let i = 0; i < 20 * SCALE; i++) {
        shown = await picker.inputValue()
        stamped = await at()
        if (shown === want && stamped === want) break
        await page.waitForTimeout(100)
      }
      if (shown !== want || stamped !== want) {
        ok = false
        check(
          `the theme picker settles on ${want}`,
          false,
          `the control reads ${JSON.stringify(shown)} and the page is ${stamped}`,
        )
      }
    }
    if (ok) check('the theme picker sticks where it is put', true)
  } else {
    check('the theme picker is on screen', false)
  }

  // -- the AI work graph -------------------------------------------------
  //
  // An agent on the real MCP endpoint, through the real tools, against the real
  // server — and the graph drawn from what it did. The three things that can
  // only be checked end to end: nodes arrive while the agent works, a file
  // change is linked to the restart of the service it belongs to, and a session
  // revert walks a chain of writes back to where it started.
  //
  // Passwordless sudo in this throwaway container is what lets the restart
  // succeed without a person opening the lock; detection caches it per
  // connection, hence the reconnect.
  execFileSync('docker', ['exec', CONTAINER, 'sh', '-c',
    'chown deploy /etc/nginx/conf.d && printf "server_tokens off;\\n" > /etc/nginx/conf.d/e2e.conf && ' +
    'chown deploy /etc/nginx/conf.d/e2e.conf && ' +
    'echo "deploy ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/zz-e2e && chmod 440 /etc/sudoers.d/zz-e2e'])
  const rpc = (m, ...a) => page.evaluate(([m, a]) => window.go.app.App[m](...a), [m, a])
  await rpc('DisconnectHost', 'e2e')
  await rpc('ConnectHost', 'e2e')
  await rpc('DetectHost', 'e2e')
  await rpc('SetMCPEnabled', true)
  await rpc('SetMCPHost', 'e2e', true)
  await rpc('SetMCPHostExec', 'e2e', true)
  await rpc('SetMCPWritePolicy', 'e2e', 'bypass', 60)
  const mcpState = await rpc('AddMCPClient', 'e2e agent')
  const agent = mcpState.clients.find((c) => c.label === 'e2e agent')
  check('a named MCP client gets a token of its own', !!agent?.token && agent.token !== mcpState.token)

  await page.getByRole('button', { name: 'AI work', exact: true }).first().click()
  await visible(page.getByText('No AI work recorded yet'), ms(10000))

  let rpcID = 1
  const mcp = async (token, method, params, session) => {
    const res = await fetch(mcpState.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcID++, method, params }),
    })
    return { session: res.headers.get('mcp-session-id'), body: await res.json() }
  }
  const { session } = await mcp(agent.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  check('initialize starts a session', !!session)
  const conf = '/etc/nginx/conf.d/e2e.conf'
  const tool = async (name, args) => {
    await mcp(agent.token, 'tools/call', { name, arguments: { hostId: 'e2e', ...args } }, session)
    // Paced under the endpoint's rate limit, and slowly enough to watch.
    await page.waitForTimeout(400)
  }
  await tool('fs_read', { path: '/etc/nginx/nginx.conf' })
  await tool('fs_read', { path: conf })
  await tool('fs_write', { path: conf, content: 'server_tokens off;\nclient_max_body_size 20m;\n' })
  await tool('fs_write', { path: conf, content: 'server_tokens off;\nclient_max_body_size 32m;\n' })
  await tool('svc_control', { unit: 'nginx.service', action: 'restart' })
  await tool('run_command', { command: 'false' })

  const drawn = await page
    .waitForFunction(() => document.querySelectorAll('.ai-node').length >= 5, null, { timeout: ms(10000) })
    .then(() => true, () => false)
  check('the graph fills in while the agent works, without a reload', drawn)
  check('reads in a row fold into one node', (await page.locator('.ai-node[data-kind="reads"]').count()) === 1)
  check('two writes to one file are linked', (await page.locator('.ai-edge[data-kind="same"]').count()) >= 1)
  check(
    'the nginx config change is linked to the nginx restart',
    (await page.locator('.ai-edge[data-kind="affects"]').count()) === 1,
    `restart: ${await page.locator('.ai-node[data-kind="service"]').getAttribute('data-result').catch(() => 'missing')}`,
  )
  check(
    'a failed command says so in words',
    (await page.locator('.ai-node[data-kind="command"][data-result="failed"] .ai-res').count()) === 1,
  )

  const writesOnGraph = page.locator('.ai-node[data-kind="file_write"]')
  const stateOf = async (i, want) => {
    await writesOnGraph.nth(i).click()
    await page
      .locator('.ai-state .badge')
      .filter({ hasText: want })
      .waitFor({ timeout: ms(10000) })
      .catch(() => {})
    return page.locator('.ai-state .badge').innerText().catch(() => '')
  }
  let got = await stateOf(1, 'Can be undone')
  check('the latest write can be undone', got === 'Can be undone', got)
  got = await stateOf(0, 'Changed again since')
  check('the earlier write reads as changed since', got === 'Changed again since', got)

  await page.getByRole('button', { name: 'Undo every file change in this session' }).click()
  await page.locator('.ai-confirm').getByRole('button', { name: 'Restore', exact: true }).click()
  await visible(page.locator('.ai-report'), ms(20000))
  check(
    'a session revert walks the chain back to where it started',
    onServer(`cat ${conf}`) === 'server_tokens off;',
    await page.locator('.ai-report').innerText().catch(() => ''),
  )

  const legacy = await mcp(mcpState.token, 'tools/call', { name: 'hosts_list', arguments: {} })
  check('the original token works as it did', !!legacy.body?.result && !legacy.body.result.isError)

  // -- the console -------------------------------------------------------
  //
  // A React error boundary or an unhandled rejection leaves the screen looking
  // fine and the next interaction broken. Nothing above would notice.
  check(
    'nothing threw in the browser',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join('\n        '),
  )
} catch (err) {
  check('the run finished', false, String(err).split('\n')[0])
} finally {
  await page.screenshot({ path: `${ARTIFACTS}/e2e-final.png`, fullPage: true }).catch(() => {})
  await browser.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
