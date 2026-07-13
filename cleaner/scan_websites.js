const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');

const songsDir = path.join(__dirname, '..');
const files = fs.readdirSync(songsDir);
const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));

console.log(`Scanning ${mp3Files.length} files...`);

const keywords = ['masstamilan', 'starmusiq', 'isaimini', 'sensongs', 'tamilbeat', 'raaga', 'saavn', 'wynk', 'gaana'];

mp3Files.forEach(file => {
    const filePath = path.join(songsDir, file);
    const tags = NodeID3.read(filePath);
    
    const found = [];
    function checkObj(obj, path = '') {
        if (!obj) return;
        if (typeof obj === 'string') {
            keywords.forEach(kw => {
                if (obj.toLowerCase().includes(kw)) {
                    found.push(`${path}: "${obj}"`);
                }
            });
        } else if (Buffer.isBuffer(obj)) {
            // Check if buffer contains any UTF-8/UTF-16 keyword representation
            const str = obj.toString('utf8').toLowerCase();
            const str16 = obj.toString('utf16le').toLowerCase();
            keywords.forEach(kw => {
                if (str.includes(kw) || str16.includes(kw)) {
                    found.push(`${path}: [Buffer containing ${kw}]`);
                }
            });
        } else if (Array.isArray(obj)) {
            obj.forEach((val, idx) => checkObj(val, `${path}[${idx}]`));
        } else if (typeof obj === 'object') {
            for (const key in obj) {
                checkObj(obj[key], path ? `${path}.${key}` : key);
            }
        }
    }
    
    checkObj(tags);
    if (found.length > 0) {
        console.log(`\nFile: ${file}`);
        found.forEach(line => console.log(`  - ${line}`));
    }
});
