const fs = require('fs');
const path = 'meeting-app/style.css';
let s = fs.readFileSync(path, 'utf8');
// Remove stray brace after .sr-only block
s = s.replace(/\n}\r?\n\r?\n\/\* Enhanced Header \*\//, '\n\n/* Enhanced Header */');
// Fix logo text
s = s.replace(/(\.brand \.logo::before\s*\{[\s\S]*?content:\s*')[^']*(')/, `$1MR$2`);
fs.writeFileSync(path, s);
console.log('patched style.css');
