// In-process replacement for threadedclass, used only in the .exe build.
const { AtemSocketChild } = require('atem-connection/dist/lib/atemSocketChild')
const classes = { './atemSocketChild:AtemSocketChild': AtemSocketChild }
async function threadedClass(modulePath, exportName, args) {
	const Cls = classes[modulePath + ':' + exportName]
	if (!Cls) throw new Error('threadedclass stub: unknown class ' + exportName)
	return new Cls(...args)
}
const ThreadedClassManager = {
	onEvent() { return { stop() {} } },
	async destroy(instance) { if (instance && instance.disconnect) await instance.disconnect() },
}
module.exports = { threadedClass, ThreadedClassManager }
