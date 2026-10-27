// CCU tab: Sony camera settings (iris, shutter, ISO, white balance, ND, looks, focus, zoom, REC),
// live picture, presets and MIDI knobs.
// Values arrive as raw Sony SDK numbers; the format* functions turn them into text.
window.CCU = (() => {
  const $ = (id) => document.getElementById(id)
  let send = () => {}
  let cams = []
  let available = false
  let selected = null
  let atem = null
  let followPreview = true
  let page = 'exposure'
  let presets = []
  let live = true
  let visible = false
  let watching = null
  try { followPreview = localStorage.getItem('ccuFollow') !== '0' } catch {}
  try { selected = localStorage.getItem('ccuCam') } catch {}
  try { page = localStorage.getItem('ccuPage') || 'exposure' } catch {}
  try { live = localStorage.getItem('ccuLive') !== '0' } catch {}

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
  const signed = (v) => (v > 0 ? '+' + v : String(v))
  function fmtPP(v) {
    if (v === 0) return 'OFF'
    if (v >= 0x41 && v <= 0x44) return 'LUT ' + (v - 0x40)
    return 'PP' + v
  }
  const LOOKS = ['', 'ST', 'PT', 'NT', 'VV', 'VV2', 'FL', 'IN', 'SH', 'BW', 'SE', 'FL2', 'FL3']
  const fmtLook = (v) => (v >= 0x100 ? 'Custom ' + (v - 0xff) : LOOKS[v] || 'Look ' + v)
  // colour tuning: 0xC0 is the middle, one step = 0.25
  const tuning = (plus, minus) => (v) => {
    const d = (v - 0xc0) / 4
    return d === 0 ? '0' : d > 0 ? plus + d : minus + -d
  }
  function fmtTime(sec) {
    if (!(sec >= 0) || sec === 0xffffffff) return ''
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`
  }
  // live view timecode, when the camera gives it as BCD HH:MM:SS:FF
  function fmtTc(tc) {
    if (!tc) return ''
    const parts = [24, 16, 8, 0].map((sh) => (tc >>> sh) & 0xff)
    if (parts.some((b) => (b & 0x0f) > 9 || b >> 4 > 9)) return ''
    return parts.map((b) => (b >> 4) + '' + (b & 0x0f)).join(':')
  }
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

  const LOOK_CONTROLS = [
    { key: 'wb', label: 'WB', fmt: fmtWb },
    { key: 'kelvin', label: 'KELVIN', fmt: fmtKelvin, onlyIf: (p) => p.wb && p.wb.v === 0x100 },
    { key: 'wbTint', label: 'TINT', fmt: signed },
    { key: 'tintAB', label: 'TINT A-B', fmt: tuning('A', 'B') },
    { key: 'tintGM', label: 'TINT G-M', fmt: tuning('G', 'M') },
    { key: 'pp', label: 'PICTURE PROFILE', fmt: fmtPP },
    { key: 'ppBlack', label: 'BLACK LEVEL', fmt: signed },
    { key: 'ppSat', label: 'PP SATURATION', fmt: signed },
    { key: 'look', label: 'CREATIVE LOOK', fmt: fmtLook },
    { key: 'lookContrast', label: 'CONTRAST', fmt: signed },
    { key: 'lookSat', label: 'SATURATION', fmt: signed },
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
      b.dataset.learn = 'cam:' + c.id
      b.addEventListener('click', () => select(c.id, true))
      tabs.appendChild(b)
    }
    const f = $('ccuFollow')
    f.classList.toggle('on', followPreview)
    f.hidden = !cams.some((c) => c.input)
    $('ccuLive').classList.toggle('on', live)
    for (const b of $('ccuPages').children) b.classList.toggle('on', b.dataset.page === page)
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
    el.dataset.learn = 'prop:' + key
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
    grid.classList.toggle('presets', page === 'presets')
    if (page === 'presets') renderPresets(cam, grid)
    else {
      for (const ctrl of page === 'look' ? LOOK_CONTROLS : CONTROLS) {
        const el = card(ctrl, cam)
        if (el) grid.appendChild(el)
      }
      if (!grid.children.length) grid.innerHTML = '<div class="ccu-empty">This camera does not give these settings.</div>'
    }
    grid.classList.toggle('dense', page !== 'presets' && grid.children.length > 8)
    const p = cam.props
    const rec = p.rec && p.rec.v === 1
    $('ccuRec').classList.toggle('on', rec)
    $('ccuRecText').textContent = rec ? 'STOP' : 'REC'
    $('ccuRec').onclick = () => send({ cmd: 'camRec', id: cam.id, on: !rec })
    const anyRec = cams.some((c) => c.status === 'connected' && c.props.rec && c.props.rec.v === 1)
    $('ccuRecAll').hidden = cams.filter((c) => c.status === 'connected').length < 2
    $('ccuRecAll').classList.toggle('on', anyRec)
    $('ccuRecAll').onclick = () => send({ cmd: 'camRecAll', on: !anyRec })
    const info = []
    if (p.battery && p.battery.v >= 0) info.push('🔋 ' + p.battery.v + '%')
    const left = p.mediaTime && fmtTime(p.mediaTime.v)
    if (left) info.push('💾 ' + left)
    $('ccuBattery').textContent = info.join('   ')
    const af = $('ccuAF')
    af.onpointerdown = (e) => { e.preventDefault(); send({ cmd: 'camAF', id: cam.id, on: true }) }
    af.onpointerup = af.onpointercancel = () => send({ cmd: 'camAF', id: cam.id, on: false })
    const zoomable = p.zoomStatus ? p.zoomStatus.v === 1 : false
    $('ccuZoom').hidden = !zoomable
    const zoomMax = (p.zoomSpeed && p.zoomSpeed.max) || 8
    for (const b of document.querySelectorAll('.zoom-btn')) {
      const speed = Math.max(1, Math.round(zoomMax * 0.6)) * Number(b.dataset.dir)
      b.onpointerdown = (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); send({ cmd: 'camZoom', id: cam.id, speed }) }
      b.onpointerup = b.onpointercancel = () => send({ cmd: 'camZoom', id: cam.id, speed: 0 })
    }
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

  function renderPresets(cam, grid) {
    const add = document.createElement('div')
    add.className = 'preset preset-new'
    add.innerHTML = '<b>Presets</b><small>Saves WB, tint, iris, shutter, ISO, ND and the look.</small><div class="preset-row"><button class="save"></button></div><div class="preset-row"><button class="match"></button></div>'
    add.querySelector('.save').textContent = `Save ${cam.name} as preset`
    add.querySelector('.match').textContent = `Match all cameras to ${cam.name}`
    add.querySelector('.save').addEventListener('click', () => {
      const name = prompt('Preset name', `Preset ${presets.length + 1}`)
      if (name !== null) send({ cmd: 'camPresetSave', id: cam.id, name })
    })
    add.querySelector('.match').addEventListener('click', () => {
      if (confirm(`Copy ${cam.name}'s colour and exposure to every other camera?`)) send({ cmd: 'camMatch', id: cam.id })
    })
    if (cams.length < 2) add.querySelector('.match').parentNode.remove()
    grid.appendChild(add)
    presets.forEach((pr, i) => {
      const el = document.createElement('div')
      el.className = 'preset'
      el.innerHTML = '<b></b><small></small><div class="preset-row"><button class="one"></button><button class="all">ALL CAMS</button><button class="del" title="Delete">✕</button></div>'
      el.querySelector('b').textContent = pr.name
      el.querySelector('small').textContent = pr.from ? 'from ' + pr.from : ''
      el.querySelector('.one').textContent = cam.name
      el.querySelector('.one').addEventListener('click', () => send({ cmd: 'camPresetRecall', preset: i, id: cam.id }))
      el.querySelector('.all').addEventListener('click', () => send({ cmd: 'camPresetRecall', preset: i, id: 'all' }))
      el.querySelector('.del').addEventListener('click', () => {
        if (confirm(`Delete preset "${pr.name}"?`)) send({ cmd: 'camPresetDelete', preset: i })
      })
      if (cams.length < 2) el.querySelector('.all').remove()
      grid.appendChild(el)
    })
  }

  // ---- live picture: only while the CCU page is open and LIVE is on ----
  function updateWatch() {
    const cam = current()
    const want = visible && live && cam && cam.status === 'connected' ? cam.id : null
    if (want !== watching) {
      $('ccuImg').removeAttribute('src')
      $('ccuTc').textContent = ''
    }
    watching = want
    $('ccuView').hidden = !want
    send({ cmd: 'camWatch', id: want })
  }

  function render() {
    renderTabs()
    renderCam()
    updateWatch()
    if (midi.learning) $('ccu').classList.add('learning')
  }

  // ---- MIDI knobs and pads (Web MIDI: works in Chrome / Edge on the PC) ----
  // learn: tap MIDI, tap a control, then turn a knob or press a key
  const midi = { map: {}, learning: false, target: null, access: null, last: {}, pending: {}, stopTimer: {} }
  try { midi.map = JSON.parse(localStorage.getItem('ccuMidi') || '{}') || {} } catch {}
  const LEARN_NAMES = { rec: 'REC', af: 'PUSH AF', focus: 'FOCUS', zoom: 'ZOOM' }
  function learnName(t) {
    if (!t) return ''
    if (t.startsWith('cam:')) return 'select ' + ((cams.find((c) => c.id === t.slice(4)) || {}).name || 'camera')
    if (t.startsWith('prop:')) {
      const k = t.slice(5)
      const c = [...CONTROLS, ...LOOK_CONTROLS].find((x) => x.key === k || x.alt === k)
      return c ? (c.alt === k && c.altLabel) || c.label : k
    }
    return LEARN_NAMES[t] || t
  }
  function renderLearn() {
    const box = $('ccuLearn')
    box.hidden = !midi.learning
    $('ccuMidi').classList.toggle('on', midi.learning || Object.keys(midi.map).length > 0)
    $('ccu').classList.toggle('learning', midi.learning)
    for (const el of document.querySelectorAll('.learn-pick')) el.classList.remove('learn-pick')
    if (!midi.learning) return
    const n = Object.keys(midi.map).length
    box.innerHTML = '<span></span><button class="clear">Clear all</button><button class="done">Done</button>'
    box.querySelector('span').textContent = midi.target
      ? `Now turn a knob or press a key for ${learnName(midi.target)}.`
      : `MIDI learn: tap a control${midi.access && !midi.access.inputs.size ? ' (no MIDI device found)' : ''}. ${n} mapped.`
    box.querySelector('.clear').onclick = () => { midi.map = {}; saveMidi(); renderLearn() }
    box.querySelector('.done').onclick = () => { midi.learning = false; midi.target = null; renderLearn() }
    if (midi.target) document.querySelector(`[data-learn="${CSS.escape(midi.target)}"]`)?.classList.add('learn-pick')
  }
  function saveMidi() { try { localStorage.setItem('ccuMidi', JSON.stringify(midi.map)) } catch {} }
  function hookMidi() {
    for (const input of midi.access.inputs.values()) input.onmidimessage = onMidi
  }
  function startMidi() {
    if (midi.access) { midi.learning = !midi.learning; midi.target = null; return renderLearn() }
    navigator.requestMIDIAccess().then((a) => {
      midi.access = a
      hookMidi()
      a.onstatechange = () => { hookMidi(); renderLearn() }
      midi.learning = true
      renderLearn()
    }, () => alert('MIDI is blocked in this browser. Use Chrome or Edge on the PC (http://localhost:3000).'))
  }
  // a knob: absolute (0..127) or relative (1 = up, 127 = down); both give +1 / -1
  function knobDir(key, v) {
    const last = midi.last[key]
    midi.last[key] = v
    const relative = v === last || ((v <= 8 || v >= 120) && (last === undefined || Math.abs(v - last) > 40))
    if (relative) return v < 64 ? 1 : -1
    if (last === undefined) return 0
    return Math.sign(v - last)
  }
  function onMidi(e) {
    const [status, d1, d2 = 0] = e.data
    const type = status & 0xf0, ch = status & 0x0f
    let key
    if (type === 0xb0) key = `cc:${ch}:${d1}`
    else if (type === 0x90 && d2 > 0) key = `n:${ch}:${d1}`
    else return
    if (midi.learning && midi.target) {
      midi.map[key] = midi.target
      midi.target = null
      midi.last[key] = d2
      saveMidi()
      return renderLearn()
    }
    const action = midi.map[key]
    const cam = current()
    if (!action || !cam) return
    const isKnob = type === 0xb0
    if (action.startsWith('cam:')) { if (d2 > 0) select(action.slice(4), true); return }
    if (cam.status !== 'connected') return
    const p = cam.props
    if (action === 'rec') { if (d2 > 0) send({ cmd: 'camRec', id: cam.id, on: !(p.rec && p.rec.v === 1) }); return }
    if (action === 'af') {
      send({ cmd: 'camAF', id: cam.id, on: true })
      setTimeout(() => send({ cmd: 'camAF', id: cam.id, on: false }), 400)
      return
    }
    const dir = isKnob ? knobDir(key, d2) : 1
    if (!dir) return
    if (action === 'focus' || action === 'zoom') {
      const cmd = action === 'focus' ? 'camFocus' : 'camZoom'
      send({ cmd, id: cam.id, speed: 3 * dir })
      clearTimeout(midi.stopTimer[action])
      midi.stopTimer[action] = setTimeout(() => send({ cmd, id: cam.id, speed: 0 }), 150)
      return
    }
    if (action.startsWith('prop:')) {
      const k = action.slice(5)
      const prop = p[k]
      if (!prop || !prop.w) return
      // fast turns: step from the value we last sent, not the one the camera reported back yet
      const pend = midi.pending[cam.id + k]
      const from = pend && Date.now() - pend.t < 700 ? pend.v : prop.v
      const next = stepValue({ ...prop, v: from }, dir)
      if (next === null || next === undefined) return
      midi.pending[cam.id + k] = { v: next, t: Date.now() }
      send({ cmd: 'camSet', id: cam.id, prop: k, value: String(next) })
    }
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
    for (const b of $('ccuPages').children) {
      b.addEventListener('click', () => {
        page = b.dataset.page
        try { localStorage.setItem('ccuPage', page) } catch {}
        render()
      })
    }
    $('ccuLive').addEventListener('click', () => {
      live = !live
      try { localStorage.setItem('ccuLive', live ? '1' : '0') } catch {}
      render()
    })
    $('ccuView').addEventListener('click', () => $('ccuView').classList.toggle('big'))
    if (navigator.requestMIDIAccess) {
      $('ccuMidi').hidden = false
      $('ccuMidi').addEventListener('click', startMidi)
      // MIDI that was set up before comes back on its own
      if (Object.keys(midi.map).length) {
        navigator.requestMIDIAccess().then((a) => { midi.access = a; hookMidi(); a.onstatechange = hookMidi; renderLearn() }, () => {})
      }
    }
    // while learning, a tap picks the control instead of using it
    const pick = (e) => {
      if (!midi.learning) return
      const el = e.target.closest('[data-learn]')
      if (!el || el.closest('#ccuLearn')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'click') { midi.target = el.dataset.learn; renderLearn() }
    }
    $('ccu').addEventListener('pointerdown', pick, true)
    $('ccu').addEventListener('click', pick, true)
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
      presets = msg.presets || []
      followAtem()
      render()
    },
    onLive(msg) {
      if (msg.id !== watching) return
      $('ccuImg').src = 'data:image/jpeg;base64,' + msg.jpg
      $('ccuTc').textContent = fmtTc(msg.tc)
    },
    setVisible(v) {
      if (visible === v) return
      visible = v
      updateWatch()
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
    format: { fmtIris, fmtShutter, fmtIso, fmtWb, fmtKelvin, fmtNd, fmtAngle, fmtPP, fmtLook, fmtTime, fmtTc },
  }
})()
