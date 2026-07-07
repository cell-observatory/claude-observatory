// tiny helper: overwrite one 0-based line of a file (simulates a Claude edit)
const [file, idx, ...rest] = process.argv.slice(2);
const fs = require('fs');
const lines = fs.readFileSync(file, 'utf8').split('\n');
lines[parseInt(idx, 10)] = rest.join(' ');
fs.writeFileSync(file, lines.join('\n'));
