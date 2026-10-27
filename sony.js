// Sony camera control (CCU) through sony-bridge.exe, which uses the Sony Camera Remote SDK.
// The bridge speaks JSON lines on stdin/stdout (see build/sony-bridge/sony_bridge.cpp).
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

const MODELS = [
	['ILME-FX3', 'FX3'],
	['ILME-FX3A', 'FX3 (A)'],
	['ILME-FX30', 'FX30'],
	['ILME-FX6', 'FX6'],
	['ILME-FX2', 'FX2'],
	['ILCE-7M4', 'A7 IV'],
	['ILCE-7M5', 'A7 V'],
	['ILCE-7SM3', 'A7S III'],
	['ILCE-7CM2', 'A7C II'],
	['ILCE-7CR', 'A7CR'],
	['ILCE-7RM5', 'A7R V'],
	['ILCE-1', 'A1'],
	['ILCE-1M2', 'A1 II'],
	['ILCE-9M3', 'A9 III'],
	['ILCE-6700', 'A6700'],
	['ZV-E1', 'ZV-E1'],
]

// What the SDK error codes mean, in words a camera operator understands
const ERRORS = {
	0x8202: 'Camera not found at this IP address.',
	0x8207: 'Camera disconnected.',
	0x8208: 'Camera did not answer (time out). Check Wi-Fi and the IP address.',
	0x8209: 'Lost the camera and could not reconnect.',
	0x820a: 'Camera refused the connection. Turn on PC Remote on the camera.',
	0x820b: 'Camera is busy (another app may be connected).',
	0x8210: 'Camera is already connected to another app.',
	0x8212: 'This camera needs Access Authentication turned on.',
	0x8214: 'Could not reach the camera.',
	0x8215: 'Camera security check failed.',
	0x8216: 'Wrong user name or password (camera menu: Access Authen. Info).',
	0x20019: 'Camera is already connected to another app (Creators\' App, Imaging Edge or another PC). Close that app, or turn the camera off and on. Trying again…',
	0x2001a: 'Camera has too many remote connections. Turn the camera off and on.',
	0x8218: 'Could not reach the camera. Check the IP address, and that Access Authen. is On in the camera menu.',
}

function errorText(code) {
	const n = parseInt(code, 16)
	return ERRORS[n] || (code ? `Camera error ${code}` : '')
}

// settings a preset stores, in the order they are put back (white balance mode before Kelvin)
const PRESET_KEYS = ['wb', 'kelvin', 'wbTint', 'tintAB', 'tintGM', 'iris', 'shutter', 'angle', 'iso', 'ei', 'nd', 'pp', 'ppBlack', 'ppSat', 'look', 'lookContrast', 'lookSat']

// all the values a setting can take: the camera's list, or every step of its range
function optionsOf(p) {
	if (!p) return []
	if (p.c) return p.c
	if (typeof p.min === 'number' && typeof p.step === 'number') {
		const list = []
		for (let x = p.min; x <= p.max && list.length < 400; x += p.step || 1) list.push(x)
		return list
	}
	return []
}

// the next value up or down from the current one
function stepOf(p, dir) {
	const list = optionsOf(p)
	if (!list.length) return null
	const i = list.findIndex((x) => String(x) === String(p.v))
	if (i < 0) {
		const v = Number(p.v)
		const next = dir > 0 ? list.find((x) => Number(x) > v) : [...list].reverse().find((x) => Number(x) < v)
		return next === undefined ? null : next
	}
	const j = Math.max(0, Math.min(list.length - 1, i + dir))
	return j === i ? null : list[j]
}

// the candidate closest to target, measured by measure(candidate) on a log scale
function nearest(list, target, measure) {
	let best = null, bestD = Infinity
	for (const x of list) {
		const m = measure(x)
		if (!(m > 0)) continue
		const d = Math.abs(Math.log(m / target))
		if (d < bestD) { bestD = d; best = x }
	}
	return best
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const shutterSeconds = (v) => { const num = Math.floor(v / 65536), den = v % 65536; return v && v !== 0xffffffff && den ? num / den : 0 }
const isoValue = (v) => ((v >>> 24) === 0 && (v & 0xffffff) !== 0xffffff ? v & 0xffffff : 0)
const irisF = (v) => (v > 0 && v < 0xfffd ? v / 100 : 0)
function ndStops(v) {
	try {
		const n = BigInt(v), num = Number(n >> 32n), den = Number(n & 0xffffffffn)
		return num && den && n !== 0xffffffffffffffffn ? Math.log2(den / num) : -1
	} catch { return -1 }
}

function findBridge(isExe) {
	const candidates = []
	if (process.env.SONY_BRIDGE) candidates.push(process.env.SONY_BRIDGE)
	if (isExe) candidates.push(path.join(path.dirname(process.execPath), 'sony', 'sony-bridge.exe'))
	else {
		candidates.push(path.join(__dirname, 'build', 'sony-bridge', 'out', 'sony-bridge.exe'))
		candidates.push(path.join(__dirname, 'build', 'sony-bridge', 'mock', 'sony-bridge-mock'))
	}
	return candidates.find((p) => {
		try {
			return fs.statSync(p).isFile()
		} catch {
			return false
		}
	})
}

class Sony extends EventEmitter {
	// config.cameras = [{ id, name, model, ip, user, pass, input }]
	constructor(config, save, isExe) {
		super()
		this.config = config
		this.save = save
		if (!Array.isArray(config.cameras)) config.cameras = []
		this.live = {} // id -> { status, error, props }
		this.retry = {} // id -> reconnect timer
		this.scan = { state: 'idle', cams: [] }
		this.bridgePath = findBridge(isExe)
		this.proc = null
		this.ready = false
		this.restarts = 0
		this.queue = []
		this.watchers = {} // id -> number of screens showing its live view
		this.lastTally = {} // id -> 'pgm' | 'pvw' | ''
		this.cc = { last: {}, readyAt: Infinity } // ATEM camera control values seen
		if (!Array.isArray(config.presets)) config.presets = []
		config.ccu = Object.assign({ atemControl: true, tally: true, recWithAtem: false }, config.ccu || {})
		if (this.bridgePath) this.start()
	}

	get available() {
		return !!this.bridgePath
	}

	start() {
		console.log('Starting Sony bridge:', this.bridgePath)
		this.ready = false
		const proc = spawn(this.bridgePath, [], { cwd: path.dirname(this.bridgePath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
		this.proc = proc
		let buf = ''
		proc.stdout.on('data', (d) => {
			buf += d
			let i
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i).trim()
				buf = buf.slice(i + 1)
				if (line) this.onLine(line)
			}
		})
		proc.stderr.on('data', (d) => console.error('Sony bridge:', String(d).trim()))
		proc.on('error', (e) => console.error('Sony bridge failed to start:', e.message))
		proc.on('exit', (code) => {
			if (this.proc !== proc) return
			this.proc = null
			this.ready = false
			for (const id of Object.keys(this.live)) this.live[id] = { status: 'off', props: {} }
			this.emit('change')
			if (this.stopping) return
			// 0xC0000135: a DLL is missing, almost always the Microsoft Visual C++ runtime
			if (code === 3221225781 || code === -1073741515) {
				this.problem = 'vcruntime'
				console.error('Sony bridge cannot start: Microsoft Visual C++ runtime is missing')
				this.emit('admin')
				return
			}
			const wait = Math.min(30000, 1000 * 2 ** this.restarts++)
			console.error(`Sony bridge stopped (code ${code}), restarting in ${wait / 1000}s`)
			setTimeout(() => this.start(), wait)
		})
	}

	stop() {
		this.stopping = true
		if (this.proc) this.send({ cmd: 'quit' })
	}

	send(obj) {
		if (!this.proc) return
		if (!this.ready && obj.cmd !== 'quit') return this.queue.push(obj)
		this.proc.stdin.write(JSON.stringify(obj) + '\n')
	}

	onLine(line) {
		let ev
		try {
			ev = JSON.parse(line)
		} catch {
			return console.log('Sony bridge:', line)
		}
		if (ev.ev === 'ready') {
			this.ready = true
			this.problem = null
			this.restarts = 0
			for (const cam of this.config.cameras) this.connect(cam)
			const q = this.queue
			this.queue = []
			for (const c of q) this.send(c)
		} else if (ev.ev === 'status') {
			const live = this.live[ev.id] || (this.live[ev.id] = { props: {} })
			live.status = ev.state
			live.error = ev.state === 'error' || ev.state === 'disconnected' ? errorText(ev.error) : ''
			if (ev.state !== 'connected') live.props = {}
			// keep trying cameras that dropped or are not on yet; the camera may also still hold our old session
			clearTimeout(this.retry[ev.id])
			if (ev.state === 'error' || (ev.state === 'disconnected' && ev.error)) {
				const wait = parseInt(ev.error, 16) === 0x20019 ? 8000 : 15000
				this.retry[ev.id] = setTimeout(() => {
					const cam = this.config.cameras.find((c) => c.id === ev.id)
					if (cam && this.live[ev.id] && this.live[ev.id].status !== 'connected') this.connect(cam)
				}, wait)
			}
			if (ev.state === 'connected') {
				if (this.watchers[ev.id] > 0) this.send({ cmd: 'lv', id: ev.id, on: 1 })
				delete this.lastTally[ev.id]
				setTimeout(() => this.applyTally(), 1500)
			}
			console.log(`Sony ${ev.id}: ${ev.state}${ev.error ? ' ' + ev.error : ''}`)
			this.emit('change')
		} else if (ev.ev === 'props') {
			const live = this.live[ev.id] || (this.live[ev.id] = { status: 'connected' })
			const json = JSON.stringify(ev.props)
			if (live.propsJson === json) return
			live.propsJson = json
			live.props = ev.props
			this.emit('change')
		} else if (ev.ev === 'lv') {
			this.emit('lv', ev.id, ev.jpg, ev.tc)
		} else if (ev.ev === 'scan') {
			this.scan = { state: 'done', cams: ev.cams || [] }
			this.emit('admin')
		} else if (ev.ev === 'log') console.log('Sony bridge:', ev.msg)
		else if (ev.ev === 'fatal') {
			this.problem = 'sdk'
			console.error('Sony bridge:', ev.msg)
			this.emit('admin')
		}
	}

	connect(cam) {
		if (!cam.ip || !cam.model) return
		clearTimeout(this.retry[cam.id])
		const was = this.live[cam.id]
		// keep the last error on screen while trying again
		this.live[cam.id] = { status: 'connecting', props: {}, error: was && was.error }
		this.send({ cmd: 'connect', id: cam.id, ip: cam.ip, model: cam.model, user: cam.user || 'admin', pass: cam.pass || '' })
		this.emit('change')
	}

	// ---- from the PC control window ----
	startScan() {
		this.scan = { state: 'scanning', cams: this.scan.cams }
		this.send({ cmd: 'scan' })
		this.emit('admin')
	}

	saveCamera(c) {
		let cam = this.config.cameras.find((x) => x.id === c.id)
		if (!cam) {
			let n = 1
			while (this.config.cameras.some((x) => x.id === 'cam' + n)) n++
			cam = { id: 'cam' + n }
			this.config.cameras.push(cam)
		}
		cam.name = String(c.name || '').trim().slice(0, 12) || 'CAM ' + cam.id.slice(3)
		cam.model = MODELS.some((m) => m[0] === c.model) ? c.model : 'ILME-FX3'
		cam.ip = String(c.ip || '').trim()
		cam.user = String(c.user || 'admin').trim() || 'admin'
		// an empty password field keeps the saved one
		if (c.pass) cam.pass = String(c.pass)
		if (c.clearPass) cam.pass = ''
		cam.input = Number(c.input) || 0
		this.save()
		this.connect(cam)
	}

	removeCamera(id) {
		this.config.cameras = this.config.cameras.filter((x) => x.id !== id)
		this.save()
		this.send({ cmd: 'disconnect', id })
		clearTimeout(this.retry[id])
		delete this.live[id]
		this.emit('change')
	}

	// ---- from phones ----
	command(msg) {
		if (msg.cmd === 'camRecAll') return this.recAll(!!msg.on)
		if (msg.cmd === 'camPresetSave') return this.savePreset(String(msg.id || ''), msg.name)
		if (msg.cmd === 'camPresetRecall') return this.recallPreset(Number(msg.preset), msg.id === 'all' ? 'all' : String(msg.id || ''))
		if (msg.cmd === 'camPresetDelete') return this.deletePreset(Number(msg.preset))
		if (msg.cmd === 'camMatch') return this.match(String(msg.id || ''))
		const id = String(msg.id || '')
		if (!this.config.cameras.some((c) => c.id === id)) return
		const speed = (v, max = 8) => clamp(Math.round(Number(v) || 0), -max, max)
		if (msg.cmd === 'camSet') this.set(id, String(msg.prop), msg.value)
		else if (msg.cmd === 'camStep') this.step(id, String(msg.prop), Number(msg.dir) > 0 ? 1 : -1)
		else if (msg.cmd === 'camRec') this.send({ cmd: 'rec', id, on: msg.on ? 1 : 0 })
		else if (msg.cmd === 'camFocus') this.send({ cmd: 'focus', id, speed: speed(msg.speed, 7) })
		else if (msg.cmd === 'camZoom') this.send({ cmd: 'zoom', id, speed: speed(msg.speed) })
		else if (msg.cmd === 'camAF') this.send({ cmd: 'af', id, on: msg.on ? 1 : 0 })
		else if (msg.cmd === 'camReconnect') {
			const cam = this.config.cameras.find((c) => c.id === id)
			if (cam) this.connect(cam)
		}
	}

	props(id) {
		return (this.live[id] && this.live[id].status === 'connected' && this.live[id].props) || null
	}

	set(id, key, value) {
		if (value === null || value === undefined) return
		this.send({ cmd: 'set', id, prop: key, value: String(value) })
	}

	step(id, key, dir) {
		const p = this.props(id)
		if (p && p[key] && p[key].w) this.set(id, key, stepOf(p[key], dir))
	}

	pulse(id, what, speed, ms) {
		this.send({ cmd: 'pulse', id, what, speed: clamp(Math.round(speed), -8, 8), ms: Math.round(ms) })
	}

	recAll(on) {
		for (const c of this.config.cameras) if (this.props(c.id)) this.send({ cmd: 'rec', id: c.id, on: on ? 1 : 0 })
	}

	// ---- Stream Deck / Companion: GET /api/sony/<cam>/<action>/<value> ----
	// cam = 1, 2, 3 (order in the PC window), the camera's name, or "all"
	http(cam, action, value) {
		const list = this.config.cameras
		const ids = cam === 'all' ? list.map((c) => c.id)
			: [(list[Number(cam) - 1] || list.find((c) => c.name.toLowerCase() === String(cam).toLowerCase()) || {}).id].filter(Boolean)
		if (!ids.length) return 'no such camera'
		const v = String(value || '').toLowerCase()
		for (const id of ids) {
			const p = this.props(id)
			if (!p) continue
			if (action === 'rec') {
				const on = v === 'toggle' || v === '' ? !(p.rec && p.rec.v === 1) : v === 'start' || v === 'on' || v === '1'
				this.send({ cmd: 'rec', id, on: on ? 1 : 0 })
			} else if (action === 'focus') this.pulse(id, 'focus', v === 'near' ? -3 : 3, 250)
			else if (action === 'zoom') this.pulse(id, 'zoom', v === 'out' || v === 'wide' ? -4 : 4, 300)
			else if (action === 'af') this.send({ cmd: 'af', id, on: 1 }), setTimeout(() => this.send({ cmd: 'af', id, on: 0 }), 600)
			else if (action === 'preset') this.recallPreset(Number(value) - 1, id)
			else if (action === 'match') this.match(id)
			else if (p[action]) {
				if (v === 'up' || v === 'down') this.step(id, action, v === 'up' ? 1 : -1)
				else this.set(id, action, value)
			} else return 'unknown action'
		}
		return 'ok'
	}

	// ---- live view: only for cameras someone is looking at ----
	watch(id, delta) {
		if (!id) return
		const before = this.watchers[id] || 0
		const now = Math.max(0, before + delta)
		this.watchers[id] = now
		if (!before && now) this.send({ cmd: 'lv', id, on: 1 })
		if (before && !now) this.send({ cmd: 'lv', id, on: 0 })
	}

	// ---- presets and matching ----
	snapshot(id) {
		const p = this.props(id)
		if (!p) return null
		const values = {}
		for (const k of PRESET_KEYS) if (p[k] && p[k].w) values[k] = p[k].v
		return values
	}

	// puts the values back one after another (the camera needs the WB mode before the Kelvin)
	apply(id, values) {
		const p = this.props(id)
		if (!p || !values) return
		const keys = PRESET_KEYS.filter((k) => values[k] !== undefined && p[k] && p[k].w && String(p[k].v) !== String(values[k]))
		keys.forEach((k, i) => setTimeout(() => this.set(id, k, values[k]), i * 150))
	}

	savePreset(id, name) {
		const values = this.snapshot(id)
		if (!values) return
		const cam = this.config.cameras.find((c) => c.id === id)
		this.config.presets.push({ name: String(name || '').trim().slice(0, 20) || `Preset ${this.config.presets.length + 1}`, from: cam ? cam.name : '', values })
		this.save()
		this.emit('change')
	}

	recallPreset(index, target) {
		const preset = this.config.presets[index]
		if (!preset) return
		const ids = target === 'all' ? this.config.cameras.map((c) => c.id) : [target]
		for (const id of ids) this.apply(id, preset.values)
	}

	deletePreset(index) {
		if (!this.config.presets[index]) return
		this.config.presets.splice(index, 1)
		this.save()
		this.emit('change')
	}

	// copy one camera's look and exposure to every other camera
	match(fromId) {
		const values = this.snapshot(fromId)
		if (!values) return
		for (const c of this.config.cameras) if (c.id !== fromId) this.apply(c.id, values)
	}

	// ---- settings from the PC window ----
	setOptions(o) {
		for (const k of ['atemControl', 'tally', 'recWithAtem']) if (typeof o[k] === 'boolean') this.config.ccu[k] = o[k]
		this.save()
		if (!this.config.ccu.tally) this.lastTally = {}
		this.applyTally()
		this.emit('admin')
	}

	// ---- ATEM: tally lamps and recording ----
	atemState(state) {
		this.atem = state
		this.applyTally()
	}

	applyTally() {
		const a = this.atem
		if (!a || !this.config.ccu.tally) return
		for (const c of this.config.cameras) {
			const p = this.props(c.id)
			if (!p || !c.input) continue
			const t = a.program === c.input || (a.inTransition && a.preview === c.input) ? 'pgm' : a.preview === c.input ? 'pvw' : ''
			if (this.lastTally[c.id] === t) continue
			this.lastTally[c.id] = t
			if (p.tallyRed && p.tallyRed.w) this.set(c.id, 'tallyRed', t === 'pgm' ? 2 : 1)
			if (p.tallyGreen && p.tallyGreen.w) this.set(c.id, 'tallyGreen', t === 'pvw' ? 2 : 1)
		}
	}

	atemRecording(on) {
		if (this.config.ccu.recWithAtem) this.recAll(on)
	}

	// ---- ATEM camera control (ATEM Software Control's Camera page, camera control panels) ----
	// The ATEM sends every change as a "CCdP" command. Camera number = ATEM input = the Sony camera
	// linked to that input. Parameters follow the Blackmagic camera control protocol.
	atemConnected() {
		// right after connecting the ATEM sends every value it has: don't apply those to the cameras
		this.cc = { last: {}, readyAt: Date.now() + 2500 }
	}

	atemCameraControl(source, category, parameter, data) {
		const key = `${source}.${category}.${parameter}`
		const prev = this.cc.last[key]
		this.cc.last[key] = data
		if (Date.now() < this.cc.readyAt || !this.config.ccu.atemControl) return
		if (prev && prev.length === data.length && prev.every((v, i) => v === data[i])) return
		const cam = this.config.cameras.find((c) => c.input && c.input === source)
		if (!cam) return
		const p = this.props(cam.id)
		if (!p) return
		const id = cam.id
		const n = data[0]
		const cc = `${category}.${parameter}`
		const ranged = (k, value) => { if (p[k] && p[k].w && typeof p[k].min === 'number') this.set(id, k, clamp(Math.round(value / (p[k].step || 1)) * (p[k].step || 1), p[k].min, p[k].max)) }
		switch (cc) {
			case '0.0': { // focus 0 (near) .. 1 (far): move by the change
				const d = n - (prev ? prev[0] : n)
				if (d) this.pulse(id, 'focus', Math.sign(d) * 3, Math.min(800, Math.abs(d) * 4000))
				break
			}
			case '0.1': // instant auto focus
				this.send({ cmd: 'af', id, on: 1 })
				setTimeout(() => this.send({ cmd: 'af', id, on: 0 }), 800)
				break
			case '0.2': // aperture as f-stop (AV number)
				if (p.iris && p.iris.w) this.set(id, 'iris', nearest(optionsOf(p.iris), Math.sqrt(2 ** n), irisF))
				break
			case '0.3': { // aperture 0 (closed) .. 1 (open)
				if (!p.iris || !p.iris.w) break
				const list = optionsOf(p.iris).filter((v) => irisF(v)).sort((a, b) => a - b)
				if (list.length) this.set(id, 'iris', list[Math.round((1 - clamp(n, 0, 1)) * (list.length - 1))])
				break
			}
			case '0.8': { // zoom 0 (wide) .. 1 (tele): move by the change
				const d = n - (prev ? prev[0] : n)
				if (d) this.pulse(id, 'zoom', Math.sign(d) * 3, Math.min(800, Math.abs(d) * 4000))
				break
			}
			case '0.9': { // zoom speed -1 .. 1
				const max = (p.zoomSpeed && p.zoomSpeed.max) || 1
				this.send({ cmd: 'zoom', id, speed: Math.round(clamp(n, -1, 1) * max) })
				break
			}
			case '1.1': // gain as a multiplier (older ATEMs): 1, 2, 4, 8, 16
				this.gain(id, p, 6 * Math.log2(Math.max(1, n)))
				break
			case '1.13': // gain in dB
				this.gain(id, p, n)
				break
			case '1.14': // ISO
				if (p.iso && p.iso.w) this.set(id, 'iso', nearest(optionsOf(p.iso), n, isoValue))
				break
			case '1.2': { // white balance: Kelvin, tint
				const kelvin = data[0], tint = data[1] || 0
				const doKelvin = () => ranged('kelvin', kelvin)
				if (p.wb && p.wb.w && p.wb.v !== 0x100 && optionsOf(p.wb).includes(0x100)) {
					this.set(id, 'wb', 0x100)
					setTimeout(() => { const q = this.props(id); if (q) ranged('kelvin', kelvin) }, 400)
				} else doKelvin()
				if (p.wbTint && p.wbTint.w) ranged('wbTint', (tint / 50) * p.wbTint.max)
				else if (p.tintGM && p.tintGM.w) ranged('tintGM', 0xc0 + Math.round((tint / 50) * 36))
				break
			}
			case '1.5': // exposure time in microseconds
				if (p.shutter && p.shutter.w) this.set(id, 'shutter', nearest(optionsOf(p.shutter), n / 1e6, shutterSeconds))
				break
			case '1.12': // shutter speed 1/x
				if (p.shutter && p.shutter.w && n > 0) this.set(id, 'shutter', nearest(optionsOf(p.shutter), 1 / n, shutterSeconds))
				break
			case '1.8': // shutter angle x100
				if (p.angle && p.angle.w) this.set(id, 'angle', nearest(optionsOf(p.angle), n * 10, (v) => v))
				break
			case '1.16': // ND in stops
				if (p.nd && p.nd.w) {
					let best = null, bestD = Infinity
					for (const v of optionsOf(p.nd)) {
						const s = ndStops(v)
						if (s >= 0 && Math.abs(s - n) < bestD) { bestD = Math.abs(s - n); best = v }
					}
					this.set(id, 'nd', best)
				}
				break
			case '8.0': // lift: black level from the luma part
				if (data.length >= 4) ranged('ppBlack', data[3] * (p.ppBlack ? p.ppBlack.max : 0) * 2)
				break
			case '8.4': // contrast: [pivot, adjust 0..2]
				ranged('lookContrast', ((data[1] ?? 1) - 1) * (p.lookContrast ? p.lookContrast.max : 0))
				break
			case '8.6': { // [hue, saturation 0..2]
				const sat = (data[1] ?? 1) - 1
				if (p.lookSat && p.lookSat.w) ranged('lookSat', sat * p.lookSat.max)
				else ranged('ppSat', sat * (p.ppSat ? p.ppSat.max : 0))
				break
			}
			case '10.1': // transport: [mode, ...]; mode 2 = record
				this.send({ cmd: 'rec', id, on: n === 2 ? 1 : 0 })
				break
		}
	}

	// ATEM gain (dB) to the camera's ISO: 0 dB = its lowest ISO, +6 dB = double
	gain(id, p, dB) {
		if (!p.iso || !p.iso.w) return
		const list = optionsOf(p.iso).filter(isoValue)
		if (!list.length) return
		const base = Math.min(...list.map(isoValue))
		this.set(id, 'iso', nearest(list, base * 2 ** (dB / 6), isoValue))
	}

	// what phones see (no passwords)
	cams() {
		return this.config.cameras.map((c) => {
			const live = this.live[c.id] || {}
			return { id: c.id, name: c.name, model: c.model, ip: c.ip, input: c.input || 0, status: live.status || 'off', error: live.error || '', props: live.props || {} }
		})
	}

	presets() {
		return this.config.presets.map((p) => ({ name: p.name, from: p.from || '' }))
	}

	// what the PC window sees
	adminCams() {
		return this.config.cameras.map((c) => {
			const live = this.live[c.id] || {}
			return { id: c.id, name: c.name, model: c.model, ip: c.ip, user: c.user || 'admin', hasPass: !!c.pass, input: c.input || 0, status: live.status || 'off', error: live.error || '' }
		})
	}
}

module.exports = { Sony, MODELS, optionsOf, stepOf }
