const fs = require('fs');
const path = 'meeting-app/index.html';
let s = fs.readFileSync(path, 'utf8');
// Replace favicon SVG content
s = s.replace(/<link rel="icon" href="data:image\/svg\+xml,[\s\S]*?<\/svg>" \/>/, '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'80\'>🎙️</text></svg>" />');
// Replace header logo content
s = s.replace(/<div class="logo" aria-hidden="true">[\s\S]*?<\/div>/, '<div class="logo" aria-hidden="true">MR</div>');
// Switch to new client script
s = s.replace('<script src="app.js"></script>', '<script src="app.client.js"></script>');
fs.writeFileSync(path, s);
console.log('patched index.html');
