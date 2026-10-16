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
			console.log(`Sony ${ev.id}: ${ev.state}${ev.error ? ' ' + ev.error : ''}`)
			this.emit('change')
		} else if (ev.ev === 'props') {
			const live = this.live[ev.id] || (this.live[ev.id] = { status: 'connected' })
			const json = JSON.stringify(ev.props)
			if (live.propsJson === json) return
			live.propsJson = json
			live.props = ev.props
			this.emit('change')
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
		const id = String(msg.id || '')
		if (!this.config.cameras.some((c) => c.id === id)) return
		if (msg.cmd === 'camSet') this.send({ cmd: 'set', id, prop: String(msg.prop), value: String(msg.value) })
		else if (msg.cmd === 'camRec') this.send({ cmd: 'rec', id, on: msg.on ? 1 : 0 })
		else if (msg.cmd === 'camFocus') this.send({ cmd: 'focus', id, speed: Math.max(-7, Math.min(7, Math.round(Number(msg.speed) || 0))) })
		else if (msg.cmd === 'camReconnect') {
			const cam = this.config.cameras.find((c) => c.id === id)
			if (cam) this.connect(cam)
		}
	}

	// what phones see (no passwords)
	cams() {
		return this.config.cameras.map((c) => {
			const live = this.live[c.id] || {}
			return { id: c.id, name: c.name, model: c.model, ip: c.ip, input: c.input || 0, status: live.status || 'off', error: live.error || '', props: live.props || {} }
		})
	}

	// what the PC window sees
	adminCams() {
		return this.config.cameras.map((c) => {
			const live = this.live[c.id] || {}
			return { id: c.id, name: c.name, model: c.model, ip: c.ip, user: c.user || 'admin', hasPass: !!c.pass, input: c.input || 0, status: live.status || 'off', error: live.error || '' }
		})
	}
}

module.exports = { Sony, MODELS }
