(() => {
  const $ = (id) => document.getElementById(id)
  const programRow = $('programRow')
  const previewRow = $('previewRow')
  const statusEl = $('status')
  const ipInput = $('ip')
  const tbar = $('tbar')
  const tbarFill = $('tbarFill')
  const tbarHandle = $('tbarHandle')

  let ws = null
  let state = null
  let builtFor = ''

  // T-bar: v = handle height (0 bottom .. 1 top). After each full stroke the
  // direction flips, like the hardware lever.
  let tbarFlipped = false
  let dragging = false
  let pendingPos = null

  // everything a stray tap could change; blocked while locked
  const BLOCKED = ['program', 'preview', 'cut', 'auto', 'tbar', 'camSet', 'camRec', 'camFocus',
    'style', 'rate', 'ftb', 'usk', 'pip', 'dsk', 'dskAuto', 'dskTie', 'audio', 'audioMaster', 'macro']
  function send(obj) {
    if (locked && BLOCKED.includes(obj.cmd) && !(obj.cmd === 'camFocus' && obj.speed === 0)) return
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }

  // ---- Lock: tap to lock, hold 1 second to unlock ----
  let locked = false
  let hintTimer = null
  function setLocked(on) {
    locked = on
    document.body.classList.toggle('locked', on)
    $('lock').setAttribute('aria-pressed', String(on))
    $('lockText').textContent = on ? 'Unlock' : 'Lock'
    $('lock').title = on ? 'Hold to unlock' : 'Lock buttons'
    if (!on) $('lockedHint').hidden = true
    try { localStorage.setItem('locked', on ? '1' : '0') } catch {}
  }
  function showLockedHint() {
    $('lockedHint').hidden = false
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => { $('lockedHint').hidden = true }, 2500)
  }
  try { if (localStorage.getItem('locked') === '1') setLocked(true) } catch {}
  {
    const btn = $('lock')
    let holdTimer = null
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; btn.classList.remove('holding') }
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      if (!locked) return setLocked(true)
      btn.classList.add('holding')
      holdTimer = setTimeout(() => { cancelHold(); setLocked(false) }, 1000)
    })
    btn.addEventListener('pointerup', () => { if (holdTimer) { cancelHold(); showLockedHint() } })
    btn.addEventListener('pointerleave', cancelHold)
    btn.addEventListener('pointercancel', cancelHold)
    btn.addEventListener('contextmenu', (e) => e.preventDefault())
    // a tap on the locked controls explains how to unlock
    document.querySelector('main').parentElement.addEventListener('pointerdown', (e) => {
      if (locked && e.target.closest && !e.target.closest('header')) showLockedHint()
    })
  }

  function connectSocket() {
    if (ws && ws.readyState <= 1) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sock = new WebSocket(`${proto}://${location.host}`)
    ws = sock
    sock.onopen = () => send({ cmd: 'hello', role: 'controller' })
    sock.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'state') render(msg)
      if (msg.type === 'cams') onCams(msg)
      if (msg.type === 'error') MORE.onError(msg)
    }
    sock.onclose = () => {
      if (ws !== sock) return
      setStatus('wait', 'Server offline, reconnecting…')
      setTimeout(connectSocket, 1500)
    }
  }

  function setStatus(cls, text) {
    statusEl.className = 'status ' + cls
    statusEl.textContent = text
  }

  function buildRows(sources) {
    const key = sources.map((s) => s.id + ':' + s.label).join('|')
    if (key === builtFor) return
    builtFor = key
    for (const [row, bus] of [[programRow, 'program'], [previewRow, 'preview']]) {
      row.innerHTML = ''
      row.classList.add(bus)
      row.style.gridTemplateColumns = `repeat(${sources.length}, 1fr)`
      for (const s of sources) {
        const b = document.createElement('button')
        b.className = 'src'
        b.innerHTML = '<b></b><small></small>'
        b.firstChild.textContent = s.id
        b.lastChild.textContent = s.label
        b.title = s.longName || s.label
        b.dataset.id = s.id
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          send({ cmd: bus, input: s.id })
        })
        row.appendChild(b)
      }
    }
  }

  // ---- SWITCHER / CCU view ----
  let view = 'switcher'
  try { view = localStorage.getItem('view') || 'switcher' } catch {}
  function showView(v) {
    if (v === 'ccu' && !(CCU.available || CCU.count)) v = 'switcher'
    $('switcher').hidden = v !== 'switcher'
    $('ccu').hidden = v !== 'ccu'
    $('more').hidden = v !== 'more'
    for (const b of $('viewSeg').children) b.classList.toggle('on', b.dataset.view === v)
    document.body.classList.toggle('ccu-view', v === 'ccu')
  }
  for (const b of $('viewSeg').children) {
    b.addEventListener('click', () => {
      view = b.dataset.view
      try { localStorage.setItem('view', view) } catch {}
      showView(view)
    })
  }
  function onCams(msg) {
    $('viewCcu').hidden = !(msg.available || (msg.cams && msg.cams.length))
    CCU.onCams(msg)
    showView(view)
  }
  CCU.init(send)
  MORE.init(send)
  $('viewSeg').hidden = false

  let pageVersion = null
  function render(msg) {
    // the PC app was updated: reload so the phone gets the new page too
    if (msg.version) {
      if (pageVersion && msg.version !== pageVersion) return location.reload()
      pageVersion = msg.version
    }
    state = msg
    if (msg.ip && document.activeElement !== ipInput && !ipInput.value) ipInput.value = msg.ip
    // the ATEM IP is managed from the PC app; only ask on the phone when none is set
    $('connectForm').hidden = !!msg.ip
    if (msg.model) $('model').textContent = msg.model.replace(/^ATEM\s*/i, '')

    if (!msg.ip) setStatus('off', 'Enter ATEM IP')
    else if (msg.connected) setStatus('on', 'Connected ' + msg.ip)
    else setStatus('wait', 'Connecting to ' + msg.ip + '…')
    document.body.classList.toggle('disabled', !msg.connected)

    CCU.onAtem(msg)
    MORE.onState(msg)
    buildRows(msg.sources)
    for (const b of programRow.children) b.classList.toggle('active', Number(b.dataset.id) === msg.program)
    for (const b of previewRow.children) {
      b.classList.toggle('active', Number(b.dataset.id) === msg.preview)
      b.classList.toggle('live', msg.inTransition && Number(b.dataset.id) === msg.preview)
    }
    $('auto').classList.toggle('running', msg.inTransition && !dragging)

    if (!dragging) {
      if (msg.inTransition) {
        const p = msg.position / 10000
        drawTbar(tbarFlipped ? 1 - p : p)
      } else {
        drawTbar(tbarFlipped ? 1 : 0)
      }
    }
  }

  function drawTbar(v) {
    const pct = (Math.max(0, Math.min(1, v)) * 100).toFixed(2) + '%'
    tbarHandle.style.bottom = pct
    tbarFill.style.height = tbarFlipped ? `calc(100% - ${pct})` : pct
    tbarFill.style.top = tbarFlipped ? '0' : 'auto'
    tbarFill.style.bottom = tbarFlipped ? 'auto' : '0'
  }

  function tbarValueFromEvent(e) {
    const r = tbar.getBoundingClientRect()
    return 1 - (e.clientY - r.top) / r.height
  }

  function onTbarMove(e) {
    if (!dragging) return
    const v = Math.max(0, Math.min(1, tbarValueFromEvent(e)))
    drawTbar(v)
    const p = tbarFlipped ? 1 - v : v
    pendingPos = Math.round(p * 10000)
    if (pendingPos >= 10000) {
      // stroke finished: send the final position and flip direction
      send({ cmd: 'tbar', position: 10000 })
      pendingPos = null
      tbarFlipped = !tbarFlipped
      dragging = false
      drawTbar(tbarFlipped ? 1 : 0)
    }
  }

  function flushTbar() {
    if (pendingPos !== null) {
      send({ cmd: 'tbar', position: pendingPos })
      pendingPos = null
    }
    requestAnimationFrame(flushTbar)
  }
  requestAnimationFrame(flushTbar)

  tbar.addEventListener('pointerdown', (e) => {
    dragging = true
    tbar.setPointerCapture(e.pointerId)
    onTbarMove(e)
  })
  tbar.addEventListener('pointermove', onTbarMove)
  const endDrag = () => { dragging = false }
  tbar.addEventListener('pointerup', endDrag)
  tbar.addEventListener('pointercancel', endDrag)

  function flash(id) {
    const el = $(id)
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 120)
  }

  $('cut').addEventListener('pointerdown', (e) => { e.preventDefault(); send({ cmd: 'cut' }) })
  $('auto').addEventListener('pointerdown', (e) => { e.preventDefault(); send({ cmd: 'auto' }) })

  $('connectForm').addEventListener('submit', (e) => {
    e.preventDefault()
    ipInput.blur()
    send({ cmd: 'connect', ip: ipInput.value.trim() })
  })

  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        await document.documentElement.requestFullscreen()
        if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {})
      }
    } catch {}
  })

  // Keyboard: 1-8 = preview, Shift+1-8 = program, Space = CUT, Enter = AUTO
  document.addEventListener('keydown', (e) => {
    if (e.target === ipInput || locked || view !== 'switcher') return
    const m = e.code.match(/^(?:Digit|Numpad)([1-8])$/)
    if (m) {
      send({ cmd: e.shiftKey ? 'program' : 'preview', input: Number(m[1]) })
    } else if (e.code === 'Space') {
      e.preventDefault(); flash('cut'); send({ cmd: 'cut' })
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault(); flash('auto'); send({ cmd: 'auto' })
    }
  })

  // iPhone/iPad: no fullscreen API in Safari, so offer Add to Home Screen instead
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
  if (isIOS || standalone || !document.documentElement.requestFullscreen) $('fullscreen').hidden = true
  let hintDismissed = false
  try { hintDismissed = localStorage.getItem('installHintDismissed') === '1' } catch {}
  if (isIOS && !standalone && !hintDismissed) $('installHint').hidden = false
  $('hintClose').addEventListener('click', () => {
    $('installHint').hidden = true
    try { localStorage.setItem('installHintDismissed', '1') } catch {}
  })

  // reconnect straight away when the phone wakes up or the app comes back to the front
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) connectSocket()
  })

  connectSocket()
})()
