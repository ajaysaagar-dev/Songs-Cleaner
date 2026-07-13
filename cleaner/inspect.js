const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');

const songsDir = path.join(__dirname, '..');
const files = fs.readdirSync(songsDir);
const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));

console.log(`Found ${mp3Files.length} MP3 files in ${songsDir}`);

function searchBuffer(buffer, query) {
    const results = [];
    const queryLower = query.toLowerCase();
    const len = queryLower.length;
    
    // Search ASCII/UTF-8
    for (let i = 0; i <= buffer.length - len; i++) {
        let match = true;
        for (let j = 0; j < len; j++) {
            const charCode = buffer[i + j];
            const char = String.fromCharCode(charCode).toLowerCase();
            if (char !== queryLower[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            results.push({ offset: i, type: 'ASCII/UTF-8' });
        }
    }

    // Search UTF-16 LE (2 bytes per character)
    const len16 = len * 2;
    for (let i = 0; i <= buffer.length - len16; i += 2) {
        let match = true;
        for (let j = 0; j < len; j++) {
            const lowByte = buffer[i + j * 2];
            const highByte = buffer[i + j * 2 + 1];
            if (highByte !== 0) {
                match = false;
                break;
            }
            const char = String.fromCharCode(lowByte).toLowerCase();
            if (char !== queryLower[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            results.push({ offset: i, type: 'UTF-16LE' });
        }
    }

    // Search UTF-16 BE
    for (let i = 0; i <= buffer.length - len16; i += 2) {
        let match = true;
        for (let j = 0; j < len; j++) {
            const highByte = buffer[i + j * 2];
            const lowByte = buffer[i + j * 2 + 1];
            if (highByte !== 0) {
                match = false;
                break;
            }
            const char = String.fromCharCode(lowByte).toLowerCase();
            if (char !== queryLower[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            results.push({ offset: i, type: 'UTF-16BE' });
        }
    }

    return results;
}

mp3Files.forEach(file => {
    const filePath = path.join(songsDir, file);
    console.log(`\n==========================================`);
    console.log(`File: ${file}`);
    
    // Read tags
    const tags = NodeID3.read(filePath);
    console.log(`Tags keys found:`, Object.keys(tags));
    
    // Check fields for masstamilan
    const fieldsWithQuery = [];
    function checkObj(obj, path = '') {
        if (!obj) return;
        if (typeof obj === 'string') {
            if (obj.toLowerCase().includes('masstamilan')) {
                fieldsWithQuery.push({ path, value: obj });
            }
        } else if (Array.isArray(obj)) {
            obj.forEach((val, idx) => checkObj(val, `${path}[${idx}]`));
        } else if (typeof obj === 'object') {
            for (const key in obj) {
                checkObj(obj[key], path ? `${path}.${key}` : key);
            }
        }
    }
    checkObj(tags);
    if (fieldsWithQuery.length > 0) {
        console.log(`Found "masstamilan" in ID3v2 tags:`);
        fieldsWithQuery.forEach(f => console.log(`  - ${f.path}: "${f.value}"`));
    } else {
        console.log(`No "masstamilan" in ID3v2 tags.`);
    }

    // Check ID3v1 tag
    const fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;
    if (fileSize > 128) {
        const id3v1Buf = Buffer.alloc(128);
        fs.readSync(fd, id3v1Buf, 0, 128, fileSize - 128);
        if (id3v1Buf.toString('ascii', 0, 3) === 'TAG') {
            console.log(`ID3v1 tag found at the end of the file!`);
            const title = id3v1Buf.toString('utf8', 3, 33).trim();
            const artist = id3v1Buf.toString('utf8', 33, 63).trim();
            const album = id3v1Buf.toString('utf8', 63, 93).trim();
            const year = id3v1Buf.toString('utf8', 93, 97).trim();
            const comment = id3v1Buf.toString('utf8', 97, 127).trim();
            console.log(`  - ID3v1 title: "${title}"`);
            console.log(`  - ID3v1 artist: "${artist}"`);
            console.log(`  - ID3v1 album: "${album}"`);
            console.log(`  - ID3v1 year: "${year}"`);
            console.log(`  - ID3v1 comment: "${comment}"`);
        } else {
            console.log(`No ID3v1 tag found.`);
        }
    }
    fs.closeSync(fd);

    // Search raw buffer
    const buf = fs.readFileSync(filePath);
    const searchRes = searchBuffer(buf, 'masstamilan');
    if (searchRes.length > 0) {
        console.log(`Found raw occurrences of "masstamilan" in file (${searchRes.length} times):`);
        searchRes.forEach(r => {
            const start = Math.max(0, r.offset - 20);
            const end = Math.min(buf.length, r.offset + 40);
            const context = buf.toString('binary', start, end).replace(/[\x00-\x1F\x7F-\xFF]/g, '.');
            console.log(`  - At offset ${r.offset} (${r.type}): "...${context}..."`);
        });
    } else {
        console.log(`No raw occurrences of "masstamilan" found in the entire file buffer.`);
    }
});
