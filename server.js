// ATEM Web Switcher
// Bridges the browser (WebSocket) to a Blackmagic ATEM switcher (UDP 9910) using atem-connection.
// http://<pc>:3000/        phone/tablet switcher (program/preview/cut/auto/t-bar)
// http://localhost:3000/admin   PC control window (ATEM status, connected phones, ATEM IP)

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const express = require('express')
const QRCode = require('qrcode')
const { WebSocketServer } = require('ws')
const { Atem } = require('atem-connection')
const { version: VERSION } = require('./package.json')

// Where the app looks for a newer version (installed .exe only)
const UPDATE_URL = 'https://raw.githubusercontent.com/eapasindu-sudo/atem-web-switcher/main/version.json'

const PORT = Number(process.env.PORT) || 3000
let IS_EXE = false
try {
	IS_EXE = require('node:sea').isSea()
} catch {}

// Installed .exe: settings and log live in %APPDATA%\ATEM Switcher (Program Files is read-only)
const DATA_DIR =
	IS_EXE && process.platform === 'win32'
		? path.join(process.env.APPDATA || path.dirname(process.execPath), 'ATEM Switcher')
		: IS_EXE
			? path.dirname(process.execPath)
			: __dirname
try {
	fs.mkdirSync(DATA_DIR, { recursive: true })
} catch {}
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const ME = 0

if (IS_EXE) {
	// the .exe runs without a console window, so keep a log file for troubleshooting
	const logFile = path.join(DATA_DIR, 'log.txt')
	try {
		if (fs.statSync(logFile).size > 1e6) fs.unlinkSync(logFile)
	} catch {}
	for (const level of ['log', 'error']) {
		const orig = console[level]
		console[level] = (...args) => {
			orig(...args)
			try {
				fs.appendFileSync(logFile, `${new Date().toISOString()} ${args.join(' ')}\n`)
			} catch {}
		}
	}
}

const MIN_INPUTS = 4
const MAX_INPUTS = 8

function loadConfig() {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
	} catch {
		return {}
	}
}

function saveConfig(cfg) {
	try {
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
	} catch (err) {
		console.error('Could not save config:', err.message)
	}
}

function lanAddresses() {
	const list = []
	for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
		for (const n of addrs || []) {
			if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) list.push({ name, address: n.address })
		}
	}
	return list
}

const config = loadConfig()
// 'auto' = number of HDMI inputs the ATEM reports, else a fixed 4..8 chosen on the PC
if (!config.inputs) config.inputs = 'auto'
let atem = null
let atemIp = null
let connected = false

const app = express()
if (global.EMBEDDED_PUBLIC) {
	// .exe build: the web page files are bundled inside the executable
	app.use((req, res, next) => {
		let file = req.path === '/' ? '/index.html' : req.path
		if (file === '/admin') file = '/admin.html'
		const body = global.EMBEDDED_PUBLIC[file]
		if (body === undefined) return next()
		res.type(path.extname(file)).send(typeof body === 'string' ? body : Buffer.from(body))
	})
} else {
	app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')))
	app.use(express.static(path.join(__dirname, 'public')))
}
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// Every open page: { role: 'controller' | 'admin', ip, device, since }
const clients = new Map()

function isLocal(ip) {
	return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function deviceName(ua = '') {
	if (/iPad/.test(ua)) return 'iPad'
	if (/iPhone/.test(ua)) return 'iPhone'
	if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
	if (/Windows/.test(ua)) return 'Windows PC'
	if (/Macintosh/.test(ua)) return 'Mac'
	return 'Browser'
}

// HDMI inputs the connected ATEM has (Mini/Pro: 4, Extreme: 8)
function detectedInputs() {
	const inputs = atem && connected && atem.state && atem.state.inputs
	if (!inputs) return null
	const count = Object.values(inputs).filter((i) => i && i.internalPortType === 0 && i.inputId >= 1 && i.inputId <= 40).length
	return count || null
}

function inputCount() {
	const n = config.inputs === 'auto' ? detectedInputs() || MAX_INPUTS : Number(config.inputs)
	return Math.max(MIN_INPUTS, Math.min(MAX_INPUTS, n || MAX_INPUTS))
}

function snapshot() {
	const state = atem && atem.state
	const me = state && state.video && state.video.mixEffects[ME]
	const sources = []
	for (let id = 1; id <= inputCount(); id++) {
		const info = state && state.inputs && state.inputs[id]
		sources.push({ id, label: (info && info.shortName) || 'CAM ' + id, longName: info ? info.longName : 'Camera ' + id })
	}
	return {
		type: 'state',
		version: VERSION,
		ip: atemIp,
		connected,
		model: state && state.info && state.info.productIdentifier,
		program: me ? me.programInput : null,
		preview: me ? me.previewInput : null,
		inTransition: me ? me.transitionPosition.inTransition : false,
		position: me ? me.transitionPosition.handlePosition : 0,
		sources,
	}
}

let qrCache = {}
async function adminInfo() {
	const urls = []
	for (const a of lanAddresses()) {
		const url = `http://${a.address}:${PORT}`
		if (!qrCache[url]) qrCache[url] = await QRCode.toDataURL(url, { margin: 1, width: 360 })
		urls.push({ url, network: a.name, qr: qrCache[url] })
	}
	const controllers = []
	for (const c of clients.values()) {
		if (c.role === 'controller') controllers.push({ ip: isLocal(c.ip) ? 'this PC' : c.ip.replace(/^::ffff:/, ''), device: c.device, since: c.since })
	}
	return {
		type: 'admin',
		urls,
		port: PORT,
		controllers,
		dataDir: DATA_DIR,
		version: VERSION,
		inputsSetting: config.inputs,
		inputsDetected: detectedInputs(),
		update,
		canUpdate: IS_EXE && process.platform === 'win32',
	}
}

function broadcast() {
	const msg = JSON.stringify(snapshot())
	for (const client of wss.clients) {
		if (client.readyState === 1) client.send(msg)
	}
}

async function broadcastAdmin() {
	const msg = JSON.stringify(await adminInfo())
	for (const [ws, c] of clients) {
		if (c.role === 'admin' && ws.readyState === 1) ws.send(msg)
	}
}

async function connectAtem(ip) {
	if (atem) {
		const old = atem
		atem = null
		old.removeAllListeners()
		try {
			await old.disconnect()
			await old.destroy()
		} catch {}
	}
	connected = false
	atemIp = ip
	config.ip = ip
	saveConfig(config)
	if (!ip) return broadcast()

	// worker threads can't load from inside the .exe bundle, so run the socket in-process there
	const a = new Atem({ disableMultithreaded: IS_EXE })
	atem = a
	a.on('error', (e) => console.error('ATEM error:', e))
	a.on('connected', () => {
		connected = true
		console.log(`Connected to ATEM at ${ip} (${a.state.info.productIdentifier || 'unknown model'})`)
		broadcast()
		broadcastAdmin().catch(() => {})
	})
	a.on('disconnected', () => {
		connected = false
		console.log('ATEM disconnected, retrying...')
		broadcast()
	})
	a.on('stateChanged', () => broadcast())
	console.log(`Connecting to ATEM at ${ip} ...`)
	a.connect(ip).catch((e) => console.error('Connect failed:', e.message))
	broadcast()
}

async function handleCommand(ws, msg) {
	const client = clients.get(ws)
	if (msg.cmd === 'hello') {
		client.role = msg.role === 'admin' ? 'admin' : 'controller'
		if (client.role === 'admin') ws.send(JSON.stringify(await adminInfo()))
		return broadcastAdmin()
	}
	if (msg.cmd === 'connect') return connectAtem(String(msg.ip || '').trim())
	if (msg.cmd === 'inputs') {
		const v = msg.value === 'auto' ? 'auto' : Math.max(MIN_INPUTS, Math.min(MAX_INPUTS, Number(msg.value) || MAX_INPUTS))
		config.inputs = v
		saveConfig(config)
		broadcast()
		return broadcastAdmin()
	}
	if (msg.cmd === 'checkUpdate' && client.role === 'admin') return checkForUpdate(true)
	if (msg.cmd === 'installUpdate' && client.role === 'admin' && isLocal(client.ip)) return installUpdate()
	if (msg.cmd === 'shutdown') {
		if (client.role !== 'admin' || !isLocal(client.ip)) return
		console.log('Stopped from the control window')
		for (const c of wss.clients) c.close()
		setTimeout(() => process.exit(0), 300)
		return
	}
	if (!atem || !connected) return
	switch (msg.cmd) {
		case 'program':
			return atem.changeProgramInput(Number(msg.input), ME)
		case 'preview':
			return atem.changePreviewInput(Number(msg.input), ME)
		case 'cut':
			return atem.cut(ME)
		case 'auto':
			return atem.autoTransition(ME)
		case 'tbar': {
			const pos = Math.max(0, Math.min(10000, Math.round(Number(msg.position))))
			return atem.setTransitionPosition(pos, ME)
		}
	}
}

wss.on('connection', (ws, req) => {
	clients.set(ws, {
		role: 'controller',
		ip: req.socket.remoteAddress || '',
		device: deviceName(req.headers['user-agent']),
		since: Date.now(),
	})
	ws.send(JSON.stringify(snapshot()))
	ws.on('message', (data) => {
		let msg
		try {
			msg = JSON.parse(data)
		} catch {
			return
		}
		Promise.resolve(handleCommand(ws, msg)).catch((e) => console.error('Command failed:', e.message))
	})
	ws.on('close', () => {
		clients.delete(ws)
		broadcastAdmin().catch(() => {})
	})
})

// ---- Auto-update (installed Windows app) ----
// update = { state: 'idle'|'checking'|'latest'|'available'|'downloading'|'installing'|'error', latest, message }
let update = { state: 'idle' }

function newer(a, b) {
	const pa = String(a).split('.').map(Number)
	const pb = String(b).split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
	}
	return false
}

function setUpdate(u) {
	update = u
	broadcastAdmin().catch(() => {})
}

async function checkForUpdate(manual) {
	if (update.state === 'downloading' || update.state === 'installing') return
	setUpdate({ state: 'checking' })
	try {
		const res = await fetch(UPDATE_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(15000) })
		if (!res.ok) throw new Error('HTTP ' + res.status)
		const info = await res.json()
		if (newer(info.version, VERSION)) {
			console.log(`Update available: ${info.version}`)
			setUpdate({ state: 'available', latest: info.version, url: info.url, notes: info.notes || '' })
		} else {
			setUpdate({ state: 'latest', latest: info.version })
		}
	} catch (e) {
		console.error('Update check failed:', e.message)
		setUpdate({ state: manual ? 'error' : 'idle', message: 'No internet, or the update server could not be reached.' })
	}
}

async function installUpdate() {
	if (update.state !== 'available' || !update.url) return
	setUpdate({ ...update, state: 'downloading' })
	try {
		const res = await fetch(update.url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
		if (!res.ok) throw new Error('HTTP ' + res.status)
		const file = path.join(os.tmpdir(), `ATEM-Switcher-Setup-${update.latest}.exe`)
		fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
		setUpdate({ ...update, state: 'installing' })
		console.log('Running installer', file)
		// silent install; the installer closes this app, replaces it and starts the new version
		const { spawn } = require('child_process')
		spawn(file, ['/S'], { detached: true, stdio: 'ignore' }).unref()
	} catch (e) {
		console.error('Update download failed:', e.message)
		setUpdate({ ...update, state: 'available', message: 'Download failed. Check the internet and try again.' })
	}
}

// Opens the control window: Edge/Chrome "app" window on Windows, else the default browser
function openControlWindow() {
	const url = `http://localhost:${PORT}/admin`
	const { exec } = require('child_process')
	if (process.platform === 'win32') {
		const opts = { windowsHide: true }
		exec(`start "" msedge --app=${url} --window-size=900,760`, opts, (err) => {
			if (err) exec(`start "" ${url}`, opts)
		})
	} else if (process.platform === 'darwin') exec(`open ${url}`)
	else exec(`xdg-open ${url}`, () => {})
}

server.listen(PORT, () => {
	console.log(`ATEM Web Switcher running:`)
	console.log(`  http://localhost:${PORT}/admin  (control window)`)
	for (const a of lanAddresses()) console.log(`  http://${a.address}:${PORT}  (phones/tablets on the same Wi-Fi)`)
	if (config.ip) connectAtem(config.ip)
	if (IS_EXE && !process.argv.includes('--no-window')) openControlWindow()
	if (IS_EXE) {
		setTimeout(() => checkForUpdate(false), 5000)
		setInterval(() => checkForUpdate(false), 6 * 60 * 60 * 1000)
	}
})

server.on('error', (err) => {
	if (err.code === 'EADDRINUSE') {
		// already running: just bring up the control window again
		console.error(`Port ${PORT} is already in use, opening the running switcher instead.`)
		if (IS_EXE) openControlWindow()
		setTimeout(() => process.exit(0), 1500)
	} else {
		console.error(err)
		if (IS_EXE) setTimeout(() => process.exit(1), 1500)
	}
})
