global.EMBEDDED_PUBLIC = {
  '/index.html': require('../public/index.html'),
  '/style.css': require('../public/style.css'),
  '/app.js': require('../public/app.js.txt'),
  '/ccu.js': require('../public/ccu.js.txt'),
  '/admin.html': require('../public/admin.html'),
  '/admin.css': require('../public/admin.css'),
  '/admin.js': require('../public/admin.js.txt'),
  '/manifest.json': require('../public/manifest.json.txt'),
  '/icon.png': require('../public/icon.png'),
}
require('../server.js')
