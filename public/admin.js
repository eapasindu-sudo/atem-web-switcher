(() => {
  const $ = (id) => document.getElementById(id)
  let ws = null
  let stopping = false
  let lastAdmin = null

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }

  function connect() {
    ws = new WebSocket(`ws://${location.host}`)
    ws.onopen = () => {
      setPill('on', 'Server running')
      send({ cmd: 'hello', role: 'admin' })
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'state') renderState(msg)
      if (msg.type === 'admin') renderAdmin(msg)
    }
    ws.onclose = () => {
      if (stopping) return
      setPill('off', 'Server not running')
      setTimeout(connect, 1500)
    }
  }

  function setPill(cls, text) {
    $('serverPill').className = 'pill ' + cls
    $('serverPill').textContent = text
  }

  function renderState(s) {
    const ipInput = $('ipInput')
    if (s.ip && document.activeElement !== ipInput && !ipInput.dataset.touched) ipInput.value = s.ip
    let dot = 'off', status = 'Not connected', model = "Enter the ATEM's IP address below"
    if (s.ip && s.connected) {
      dot = 'on'; status = 'Connected'; model = (s.model || 'ATEM') + ' at ' + s.ip
    } else if (s.ip) {
      dot = 'wait'; status = 'Connecting…'; model = 'Looking for the ATEM at ' + s.ip + '. Check the IP and the network cable.'
    }
    $('atemDot').className = 'dot ' + dot
    $('atemStatus').textContent = status
    $('atemModel').textContent = model
    $('pgm').textContent = s.connected && s.program != null ? s.program : '–'
    $('pvw').textContent = s.connected && s.preview != null ? s.preview : '–'
  }

  function since(ts) {
    const m = Math.floor((Date.now() - ts) / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return m + ' min'
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min'
  }

  function renderAdmin(a) {
    lastAdmin = a
    const urls = $('urls')
    urls.innerHTML = ''
    if (!a.urls.length) {
      urls.innerHTML = '<p class="error">This PC is not on a network. Connect it to the same Wi-Fi or router as the ATEM.</p>'
    }
    for (const u of a.urls) {
      const row = document.createElement('div')
      row.className = 'url'
      row.innerHTML = '<img alt="QR code"><div><a target="_blank"></a><small></small></div>'
      row.querySelector('img').src = u.qr
      row.querySelector('a').href = u.url
      row.querySelector('a').textContent = u.url
      row.querySelector('small').textContent = 'Network: ' + u.network
      urls.appendChild(row)
    }
    const list = $('phones')
    list.innerHTML = ''
    for (const c of a.controllers) {
      const li = document.createElement('li')
      li.innerHTML = '<span class="dot on"></span><b></b><span class="muted"></span><span></span>'
      li.children[1].textContent = c.device
      li.children[2].textContent = c.ip
      li.children[3].textContent = 'connected ' + since(c.since)
      list.appendChild(li)
    }
    $('noPhones').hidden = a.controllers.length > 0
    $('phoneCount').textContent = a.controllers.length
    $('phoneCount').classList.toggle('has', a.controllers.length > 0)
    $('dataDir').textContent = 'Settings and log: ' + a.dataDir
  }

  setInterval(() => lastAdmin && renderAdmin(lastAdmin), 30000)

  $('ipInput').addEventListener('input', (e) => { e.target.dataset.touched = '1'; $('ipError').hidden = true })
  $('ipForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const ip = $('ipInput').value.trim()
    const ok = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split('.').every((n) => Number(n) <= 255)
    $('ipError').hidden = ok
    if (!ok) return
    delete $('ipInput').dataset.touched
    send({ cmd: 'connect', ip })
  })

  $('openLocal').addEventListener('click', () => window.open('/', '_blank'))

  let confirmTimer = null
  $('stop').addEventListener('click', () => {
    const btn = $('stop')
    if (!confirmTimer) {
      btn.textContent = 'Click again to stop'
      confirmTimer = setTimeout(() => { btn.textContent = 'Stop server'; confirmTimer = null }, 3000)
      return
    }
    stopping = true
    send({ cmd: 'shutdown' })
    $('stopped').hidden = false
  })

  connect()
})()
