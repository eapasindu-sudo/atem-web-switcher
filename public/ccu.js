// CCU tab: Sony camera settings (iris, shutter, ISO, white balance, ND, focus, REC).
// Values arrive as raw Sony SDK numbers; the format* functions turn them into text.
window.CCU = (() => {
  const $ = (id) => document.getElementById(id)
  let send = () => {}
  let cams = []
  let available = false
  let selected = null
  let atem = null
  let followPreview = true
  try { followPreview = localStorage.getItem('ccuFollow') !== '0' } catch {}
  try { selected = localStorage.getItem('ccuCam') } catch {}

  // ---- value formatting ----
  const big = (v) => { try { return BigInt(v) } catch { return 0n } }
  function fmtIris(v) {
    if (!v || v === 0xfffe || v === 0xffff) return '--'
    if (v === 0xfffd) return 'CLOSE'
    const f = Math.round(v / 10) / 10
    return 'F' + (Number.isInteger(f) ? f.toFixed(0) : f.toFixed(1))
  }
  function fmtShutter(v) {
    if (v === 0) return 'BULB'
    if (v === 0xffffffff) return '--'
    const num = Math.floor(v / 65536), den = v % 65536
    if (!den) return '--'
    if (num === 1) return '1/' + den
    if (num % den === 0) return num / den + '"'
    return (num / den).toFixed(1) + '"'
  }
  const fmtAngle = (v) => (v ? (Math.round(v / 100) / 10).toString().replace(/\.0$/, '') + '°' : 'OFF')
  function fmtIso(v) {
    const value = v & 0xffffff
    const mode = (v >>> 24) & 0x0f
    let s = value === 0xffffff ? 'AUTO' : String(value)
    if (mode === 1) s += ' NR'
    if (mode === 2) s += ' NR+'
    return s
  }
  const WB = { 0: 'AWB', 1: 'Underwater', 0x11: 'Daylight', 0x12: 'Shade', 0x13: 'Cloudy', 0x14: 'Tungsten', 0x20: 'Fluor.', 0x21: 'Fluor. Warm', 0x22: 'Fluor. Cool', 0x23: 'Fluor. Day W', 0x24: 'Fluor. Daylt', 0x30: 'Flash', 0x100: 'Kelvin', 0x101: 'Custom 1', 0x102: 'Custom 2', 0x103: 'Custom 3', 0x104: 'Custom' }
  const fmtWb = (v) => WB[v] || 'WB ' + v
  const fmtKelvin = (v) => (v === 0 ? '<min' : v === 0xffff ? '>max' : v + 'K')
  function fmtNd(v) {
    const n = big(v)
    if (n === 0xffffffffffffffffn || n === 0n) return '--'
    const num = Number(n >> 32n), den = Number(n & 0xffffffffn)
    if (!den) return '--'
    if (num === den) return 'CLEAR'
    if (num === 1) return '1/' + den
    return '1/' + Math.round(den / num)
  }
  const FOCUS = { 1: 'MF', 2: 'AF-S', 3: 'AF-C', 4: 'AF-A', 5: 'AF-D', 6: 'DMF', 7: 'PF' }
  const fmtFocus = (v) => FOCUS[v] || '--'
  const AUTO_MANUAL = { 1: 'AUTO', 2: 'MAN' }
  const ND_MODE = { 1: 'AUTO', 2: 'PRESET', 3: 'CLEAR', 4: 'VARIABLE', 5: 'CLEAR', 6: 'STEP', 7: 'CLEAR' }

  // ---- the controls shown, in order; a card only appears when the camera has that setting ----
  const CONTROLS = [
    { key: 'iris', label: 'IRIS', fmt: fmtIris, mode: 'irisMode', reverse: false },
    { key: 'shutter', label: 'SHUTTER', fmt: fmtShutter, mode: 'shutterMode', alt: 'angle', altFmt: fmtAngle },
    { key: 'iso', label: 'ISO', fmt: fmtIso, alt: 'ei', altLabel: 'EI', altFmt: (v) => String(v), mode: 'gainMode' },
    { key: 'wb', label: 'WB', fmt: fmtWb },
    { key: 'kelvin', label: 'KELVIN', fmt: fmtKelvin, onlyIf: (p) => p.wb && p.wb.v === 0x100 },
    { key: 'nd', label: 'ND', fmt: fmtNd, mode: 'ndMode', modeNames: ND_MODE },
  ]

  function options(p) {
    if (!p) return []
    if (p.c) return p.c
    if (p.step !== undefined && typeof p.min === 'number') {
      const list = []
      for (let x = p.min; x <= p.max && list.length < 400; x += p.step || 1) list.push(x)
      return list
    }
    return []
  }

  function stepValue(p, dir) {
    const list = options(p)
    if (!list.length) return null
    const i = list.findIndex((x) => String(x) === String(p.v))
    if (i < 0) {
      // current value is not in the list (e.g. kelvin between steps): go to the next one that way
      const v = Number(p.v)
      const next = dir > 0 ? list.find((x) => Number(x) > v) : [...list].reverse().find((x) => Number(x) < v)
      return next === undefined ? null : next
    }
    const j = Math.max(0, Math.min(list.length - 1, i + dir))
    return j === i ? null : list[j]
  }

  // ---- render ----
  function current() {
    return cams.find((c) => c.id === selected) || cams[0] || null
  }

  function tallyOf(cam) {
    if (!atem || !cam.input) return ''
    if (atem.program === cam.input || (atem.inTransition && atem.preview === cam.input)) return 'pgm'
    if (atem.preview === cam.input) return 'pvw'
    return ''
  }

  function renderTabs() {
    const tabs = $('ccuTabs')
    tabs.innerHTML = ''
    for (const c of cams) {
      const b = document.createElement('button')
      b.className = 'cam-tab ' + tallyOf(c) + (c === current() ? ' sel' : '')
      b.innerHTML = '<span class="dot"></span><b></b><small></small>'
      b.querySelector('.dot').classList.add(c.status === 'connected' ? 'on' : c.status === 'connecting' || c.status === 'reconnecting' ? 'wait' : 'off')
      b.querySelector('b').textContent = c.name
      b.querySelector('small').textContent = c.input ? 'IN ' + c.input : ''
      b.addEventListener('click', () => select(c.id, true))
      tabs.appendChild(b)
    }
    const f = $('ccuFollow')
    f.classList.toggle('on', followPreview)
    f.hidden = !cams.some((c) => c.input)
  }

  function card(ctrl, cam) {
    const p = cam.props
    let key = ctrl.key, label = ctrl.label, fmt = ctrl.fmt
    // FX cameras in Cine EI show EI instead of ISO; shutter angle instead of speed when set to angle
    if (ctrl.alt && p[ctrl.alt] && (!p[key] || (ctrl.alt === 'angle' ? p.angle.v && p.angle.w : p.ei.w && !p.iso?.w))) {
      key = ctrl.alt
      label = ctrl.altLabel || label
      fmt = ctrl.altFmt
    }
    const prop = p[key]
    if (!prop || (ctrl.onlyIf && !ctrl.onlyIf(p))) return null
    const el = document.createElement('div')
    el.className = 'ccu-card' + (prop.w ? '' : ' ro')
    el.innerHTML = '<div class="ccu-label"><span></span><em></em></div><button class="ccu-value"></button><div class="ccu-steps"><button class="minus">−</button><button class="plus">+</button></div>'
    el.querySelector('.ccu-label span').textContent = label
    const modeProp = ctrl.mode && p[ctrl.mode]
    const modeEl = el.querySelector('.ccu-label em')
    if (modeProp) {
      modeEl.textContent = (ctrl.modeNames || AUTO_MANUAL)[modeProp.v] || ''
      modeEl.classList.toggle('auto', modeProp.v === 1)
      if (modeProp.w && options(modeProp).length > 1) {
        modeEl.classList.add('tap')
        modeEl.addEventListener('click', () => {
          const next = stepValue(modeProp, 1) ?? options(modeProp)[0]
          send({ cmd: 'camSet', id: cam.id, prop: ctrl.mode, value: String(next) })
        })
      }
    }
    el.querySelector('.ccu-value').textContent = fmt(prop.v)
    const set = (v) => v !== null && v !== undefined && send({ cmd: 'camSet', id: cam.id, prop: key, value: String(v) })
    el.querySelector('.minus').addEventListener('click', () => set(stepValue(prop, -1)))
    el.querySelector('.plus').addEventListener('click', () => set(stepValue(prop, 1)))
    el.querySelector('.ccu-value').addEventListener('click', () => {
      if (prop.w) openPicker(label, options(prop), prop.v, fmt, set)
    })
    return el
  }

  function renderCam() {
    const cam = current()
    const grid = $('ccuGrid')
    grid.innerHTML = ''
    const side = $('ccuSide')
    $('ccuEmpty').hidden = true
    if (!cam) {
      side.hidden = true
      $('ccuEmpty').hidden = false
      $('ccuEmpty').innerHTML = available
        ? 'No Sony cameras yet. Add them on the PC, in the <b>Sony cameras</b> box of the ATEM Switcher window.'
        : 'Sony camera control is not installed on this PC.'
      return
    }
    if (cam.status !== 'connected') {
      side.hidden = true
      $('ccuEmpty').hidden = false
      const what = cam.status === 'connecting' ? 'Connecting to ' : cam.status === 'reconnecting' ? 'Reconnecting to ' : 'Not connected to '
      $('ccuEmpty').innerHTML = '<p></p><p class="err"></p><button id="ccuRetry">Try again</button>'
      $('ccuEmpty').querySelector('p').textContent = `${what}${cam.name} (${cam.ip})…`
      $('ccuEmpty').querySelector('.err').textContent = cam.error || ''
      $('ccuRetry').addEventListener('click', () => send({ cmd: 'camReconnect', id: cam.id }))
      return
    }
    side.hidden = false
    for (const ctrl of CONTROLS) {
      const el = card(ctrl, cam)
      if (el) grid.appendChild(el)
    }
    const p = cam.props
    const rec = p.rec && p.rec.v === 1
    $('ccuRec').classList.toggle('on', rec)
    $('ccuRecText').textContent = rec ? 'STOP' : 'REC'
    $('ccuRec').onclick = () => send({ cmd: 'camRec', id: cam.id, on: !rec })
    $('ccuBattery').textContent = p.battery && p.battery.v >= 0 ? '🔋 ' + p.battery.v + '%' : ''
    const fm = p.focusMode
    $('ccuFocusMode').textContent = fm ? fmtFocus(fm.v) : '--'
    $('ccuFocusMode').onclick = () => {
      if (fm && fm.w) send({ cmd: 'camSet', id: cam.id, prop: 'focusMode', value: String(stepValue(fm, 1) ?? options(fm)[0]) })
    }
    const maxSpeed = (p.focusSpeed && p.focusSpeed.max) || 7
    for (const b of document.querySelectorAll('.focus-btn')) {
      const dir = Number(b.dataset.dir)
      const speed = Math.round((Math.abs(dir) === 2 ? maxSpeed : Math.max(1, maxSpeed / 3)) * Math.sign(dir))
      b.onpointerdown = (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); send({ cmd: 'camFocus', id: cam.id, speed }) }
      b.onpointerup = b.onpointercancel = () => send({ cmd: 'camFocus', id: cam.id, speed: 0 })
    }
  }

  function render() {
    renderTabs()
    renderCam()
  }

  function select(id, byHand) {
    selected = id
    try { localStorage.setItem('ccuCam', id) } catch {}
    if (byHand && followPreview && cams.find((c) => c.id === id)?.input) {
      // picking a camera by hand while following preview would jump back, so pause following
      followPreview = false
      try { localStorage.setItem('ccuFollow', '0') } catch {}
    }
    closePicker()
    render()
  }

  // ---- picker: all values in a grid ----
  function openPicker(label, list, cur, fmt, set) {
    if (!list.length) return
    $('pickerTitle').textContent = label
    const grid = $('pickerGrid')
    grid.innerHTML = ''
    for (const v of list) {
      const b = document.createElement('button')
      b.textContent = fmt(v)
      if (String(v) === String(cur)) b.className = 'cur'
      b.addEventListener('click', () => { set(v); closePicker() })
      grid.appendChild(b)
    }
    $('picker').hidden = false
    grid.querySelector('.cur')?.scrollIntoView({ block: 'center' })
  }
  function closePicker() { $('picker').hidden = true }

  function init(sendFn) {
    send = sendFn
    $('pickerClose').addEventListener('click', closePicker)
    $('picker').addEventListener('click', (e) => { if (e.target === $('picker')) closePicker() })
    $('ccuFollow').addEventListener('click', () => {
      followPreview = !followPreview
      try { localStorage.setItem('ccuFollow', followPreview ? '1' : '0') } catch {}
      followAtem()
      render()
    })
  }

  function followAtem() {
    if (!followPreview || !atem) return
    const cam = cams.find((c) => c.input && c.input === atem.preview)
    if (cam) selected = cam.id
  }

  return {
    init,
    onCams(msg) {
      available = msg.available
      cams = msg.cams || []
      followAtem()
      render()
    },
    onAtem(state) {
      const changed = !atem || atem.preview !== state.preview || atem.program !== state.program || atem.inTransition !== state.inTransition
      atem = state
      if (!changed) return
      followAtem()
      if (!$('ccu').hidden) render()
    },
    get count() { return cams.length },
    get available() { return available },
    // exposed for tests
    format: { fmtIris, fmtShutter, fmtIso, fmtWb, fmtKelvin, fmtNd, fmtAngle },
  }
})()
