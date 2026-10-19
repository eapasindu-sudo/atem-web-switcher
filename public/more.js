// MORE page: transition style and rate, fade to black, upstream keys (+ picture-in-picture),
// downstream keys, audio mixer and macros. Only what the connected ATEM has is shown; the
// buttons light up from the ATEM's own state, never just because they were pressed.
window.MORE = (() => {
  const $ = (id) => document.getElementById(id)
  const STYLE = ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']
  const KEYTYPE = ['Luma', 'Chroma', 'Pattern', 'DVE']
  const SIZES = [['S', 250], ['M', 330], ['L', 450]]
  let send = () => {}
  let ex = null
  let built = ''
  let errTimer = null

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const db = (v) => (v == null ? '--' : v <= -60 ? '-∞' : (v > 0 ? '+' : '') + v.toFixed(1))

  function section(title, body) {
    return `<div class="more-card"><div class="ccu-label"><span>${title}</span></div>${body || '<div class="more-none">Not on this ATEM</div>'}</div>`
  }

  // the layout only changes with the ATEM's capabilities; values are updated in place
  function layoutKey(e) {
    return JSON.stringify([e.styles, e.ftb != null, e.usk.map((k) => [k.id, k.canFly]), e.dsk.map((k) => k.id),
      e.audio && [e.audio.kind, e.audio.channels.map((c) => [c.id, c.label, c.options])], e.macros])
  }

  function build(e) {
    const trans = `<div class="more-row">${e.styles.map((s) => `<button class="mbtn" data-style="${s}">${STYLE[s]}</button>`).join('')}</div>
      <div class="more-row"><span class="more-lbl">RATE</span><button class="mbtn sm" data-rate="-5">−</button><b id="mRate" class="more-val"></b><button class="mbtn sm" data-rate="5">+</button></div>
      ${e.ftb ? '<div class="more-row"><button id="mFtb" class="mbtn wide">FTB</button></div>' : ''}`
    const usk = e.usk.length ? e.usk.map((k) => `<div class="more-key">
      <div class="more-row"><button class="mbtn" data-usk="${k.id}">KEY ${k.id + 1}</button><small id="mUskInfo${k.id}"></small></div>
      ${k.canFly ? `<div class="more-row"><span class="more-lbl">PiP</span>${['tl', 'tr', 'bl', 'br'].map((c) => `<button class="mbtn sm" data-pip="${k.id}" data-corner="${c}">${{ tl: '◤', tr: '◥', bl: '◣', br: '◢' }[c]}</button>`).join('')}
        ${SIZES.map(([n, s]) => `<button class="mbtn sm" data-pipsize="${k.id}" data-size="${s}">${n}</button>`).join('')}</div>` : ''}</div>`).join('') : ''
    const dsk = e.dsk.length ? e.dsk.map((k) => `<div class="more-row"><button class="mbtn" data-dsk="${k.id}">DSK ${k.id + 1}</button>
      <button class="mbtn sm" data-dskauto="${k.id}">AUTO</button><button class="mbtn sm" data-dsktie="${k.id}">TIE</button><small id="mDskInfo${k.id}"></small></div>`).join('') : ''
    const a = e.audio
    const audio = a ? `<div class="more-audio">${a.channels.map((c) => `<div class="more-ch">
        <b>${esc(c.label)}</b><span id="mGain${c.id}" class="more-val"></span>
        <div class="more-row"><button class="mbtn sm" data-gain="${c.id}" data-step="-3">−</button><button class="mbtn sm" data-gain="${c.id}" data-step="3">+</button></div>
        <div class="more-row">${c.options.map((o) => `<button class="mbtn sm" data-mix="${c.id}" data-opt="${o}">${o.toUpperCase()}</button>`).join('')}</div></div>`).join('')}
        <div class="more-ch"><b>MASTER</b><span id="mMaster" class="more-val"></span>
        <div class="more-row"><button class="mbtn sm" data-master="-3">−</button><button class="mbtn sm" data-master="3">+</button></div></div></div>` : ''
    const macros = e.macros.length ? `<div class="more-row wrap">${e.macros.map((m) => `<button class="mbtn" data-macro="${m.id}">${esc(m.name)}</button>`).join('')}
      <button class="mbtn sm" id="mMacroStop">STOP</button></div>` : ''
    $('moreGrid').innerHTML = section('TRANSITION', trans) + section('UPSTREAM KEYS', usk) + section('DOWNSTREAM KEYS', dsk) +
      section('AUDIO', audio) + section('MACROS', macros)
  }

  function update(e) {
    const q = (sel) => document.querySelectorAll(`#moreGrid ${sel}`)
    q('[data-style]').forEach((b) => b.classList.toggle('on', Number(b.dataset.style) === e.style))
    $('mRate').textContent = e.rate == null ? '--' : `${e.rate} fr`
    if ($('mFtb')) {
      $('mFtb').classList.toggle('black', !!e.ftb.black)
      $('mFtb').classList.toggle('running', !!e.ftb.inTransition)
      $('mFtb').textContent = e.ftb.black ? 'FTB: BLACK' : 'FTB'
    }
    for (const k of e.usk) {
      q(`[data-usk="${k.id}"]`).forEach((b) => b.classList.toggle('air', k.onAir))
      $('mUskInfo' + k.id).textContent = `${KEYTYPE[k.type] || ''} · ${k.fillLabel}`
      q(`[data-pipsize="${k.id}"]`).forEach((b) => b.classList.toggle('on', k.dve && Math.abs(k.dve.size - Number(b.dataset.size)) < 15))
    }
    for (const k of e.dsk) {
      q(`[data-dsk="${k.id}"]`).forEach((b) => { b.classList.toggle('air', k.onAir); b.classList.toggle('running', k.inTransition) })
      q(`[data-dsktie="${k.id}"]`).forEach((b) => b.classList.toggle('on', k.tie))
      $('mDskInfo' + k.id).textContent = k.fill
    }
    if (e.audio) {
      for (const c of e.audio.channels) {
        $('mGain' + c.id).textContent = db(c.gain) + ' dB'
        q(`[data-mix="${c.id}"]`).forEach((b) => b.classList.toggle(b.dataset.opt === 'off' ? 'on' : 'air', b.dataset.opt === c.mix))
      }
      $('mMaster').textContent = db(e.audio.master) + ' dB'
    }
    q('[data-macro]').forEach((b) => b.classList.toggle('air', Number(b.dataset.macro) === e.macroRunning))
  }

  function onClick(ev) {
    const b = ev.target.closest('button')
    if (!b || !ex) return
    const d = b.dataset
    if (d.style !== undefined) send({ cmd: 'style', style: Number(d.style) })
    else if (d.rate !== undefined && ex.rate != null) send({ cmd: 'rate', rate: ex.rate + Number(d.rate) })
    else if (b.id === 'mFtb') send({ cmd: 'ftb' })
    else if (d.usk !== undefined) send({ cmd: 'usk', key: Number(d.usk), onAir: !ex.usk.find((k) => k.id === Number(d.usk)).onAir })
    else if (d.pip !== undefined) send({ cmd: 'pip', key: Number(d.pip), corner: d.corner })
    else if (d.pipsize !== undefined) {
      const k = ex.usk.find((x) => x.id === Number(d.pipsize))
      const corner = k.dve ? (k.dve.x < 0 ? 'l' : 'r') : 'r'
      send({ cmd: 'pip', key: k.id, corner: (k.dve && k.dve.y < 0 ? 'b' : 't') + corner, size: Number(d.size) })
    } else if (d.dsk !== undefined) send({ cmd: 'dsk', key: Number(d.dsk), onAir: !ex.dsk.find((k) => k.id === Number(d.dsk)).onAir })
    else if (d.dskauto !== undefined) send({ cmd: 'dskAuto', key: Number(d.dskauto) })
    else if (d.dsktie !== undefined) send({ cmd: 'dskTie', key: Number(d.dsktie), tie: !ex.dsk.find((k) => k.id === Number(d.dsktie)).tie })
    else if (d.gain !== undefined) {
      const c = ex.audio.channels.find((x) => x.id === Number(d.gain))
      send({ cmd: 'audio', id: c.id, gain: Math.max(-60, (c.gain <= -60 ? -63 : c.gain) + Number(d.step)) })
    } else if (d.mix !== undefined) send({ cmd: 'audio', id: Number(d.mix), mix: d.opt })
    else if (d.master !== undefined) send({ cmd: 'audioMaster', gain: Math.max(-60, (ex.audio.master <= -60 ? -63 : ex.audio.master) + Number(d.master)) })
    else if (d.macro !== undefined) send({ cmd: 'macro', index: Number(d.macro) })
    else if (b.id === 'mMacroStop') send({ cmd: 'macroStop' })
  }

  return {
    init(sendFn) {
      send = sendFn
      $('moreGrid').addEventListener('click', onClick)
    },
    onState(msg) {
      ex = msg.extras
      $('moreEmpty').hidden = !!ex
      $('moreGrid').hidden = !ex
      if (!ex) return
      const k = layoutKey(ex)
      if (k !== built) { build(ex); built = k }
      update(ex)
    },
    onError(msg) {
      $('moreErr').textContent = msg.message
      $('moreErr').hidden = false
      clearTimeout(errTimer)
      errTimer = setTimeout(() => { $('moreErr').hidden = true }, 4000)
    },
  }
})()
