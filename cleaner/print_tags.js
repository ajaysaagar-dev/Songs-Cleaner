const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');

const filePath = path.join(__dirname, '..', 'Aathadi-Aathadi.mp3');
const tags = NodeID3.read(filePath);

console.log('Tags keys and values:');
for (const key in tags) {
    if (key === 'image' || key === 'raw') {
        console.log(`- ${key}: [binary data, size: ${tags[key] ? (tags[key].imageBuffer ? tags[key].imageBuffer.length : tags[key].length || 'unknown') : 'null'}]`);
    } else {
        console.log(`- ${key}:`, JSON.stringify(tags[key], null, 2));
    }
}
