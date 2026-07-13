const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');
const { Jimp } = require('jimp');

const songsDir = path.join(__dirname, '..');
const backupDir = path.join(__dirname, 'backup');

// Create backup directory if it doesn't exist
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
}

// RESTORE FROM BACKUP FIRST (to recover from any previous double-cropping runs)
console.log('Checking for backups to restore...');
const backupFiles = fs.readdirSync(backupDir).filter(f => f.toLowerCase().endsWith('.mp3'));
backupFiles.forEach(file => {
    const backupPath = path.join(backupDir, file);
    const destPath = path.join(songsDir, file);
    fs.copyFileSync(backupPath, destPath);
});
if (backupFiles.length > 0) {
    console.log(`Restored ${backupFiles.length} original files from backup to ensure clean starting state.`);
}

const files = fs.readdirSync(songsDir);
const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));

console.log(`\nStarting metadata clean-up for ${mp3Files.length} MP3 songs in the root directory...`);

function cleanText(text) {
    if (!text) return text;
    let cleaned = text;

    // Pattern to remove: optionally spaces/hyphens/bars followed by a known promotional site name with optional .com/etc.
    // Case-insensitive matches for common site promotions
    const promoRegex = /\s*[-–—|]*\s*(?:masstamilan|starmusiq|isaimini|sensongsmp3|sensongs|tamilbeat)(?:\.com|\.co\.in|\.co|\.in|\.net)?\s*/gi;
    cleaned = cleaned.replace(promoRegex, '');

    // If it mentions download patterns or audio formats as advertising, clear it fully
    if (/(download|songs for free|320kbps|128kbps)/i.test(cleaned)) {
        cleaned = '';
    }

    // Clean up empty brackets remaining, e.g. "Song Title []" -> "Song Title"
    cleaned = cleaned.replace(/\s*[\[{(]\s*[\])}]\s*/g, ' ');
    // Collapse extra spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
}

function stripID3v1(filePath) {
    const fd = fs.openSync(filePath, 'r+');
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;
    let stripped = false;
    if (fileSize > 128) {
        const id3v1Buf = Buffer.alloc(128);
        fs.readSync(fd, id3v1Buf, 0, 128, fileSize - 128);
        if (id3v1Buf.toString('ascii', 0, 3) === 'TAG') {
            fs.ftruncateSync(fd, fileSize - 128);
            stripped = true;
        }
    }
    fs.closeSync(fd);
    return stripped;
}

async function cleanFile(file) {
    const filePath = path.join(songsDir, file);
    const backupPath = path.join(backupDir, file);

    // 1. Back up original file (if backup doesn't already exist)
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(filePath, backupPath);
        console.log(`\nBacked up and processing: ${file}`);
    } else {
        console.log(`\nProcessing: ${file}`);
    }

    const originalTags = NodeID3.read(filePath);
    
    // Check if we have already cleaned this file in a previous run
    let alreadyCleaned = false;
    if (Array.isArray(originalTags.userDefinedText)) {
        alreadyCleaned = originalTags.userDefinedText.some(
            item => item.description === 'MetadataCleaned' && item.value === 'true'
        );
    }

    if (alreadyCleaned) {
        console.log(`  -> Already cleaned in a previous run. Skipping.`);
        return;
    }

    const cleanedTags = JSON.parse(JSON.stringify(originalTags)); // deep copy clone for manipulation

    // Keep image buffer (since JSON stringify drops buffer)
    if (originalTags.image) {
        cleanedTags.image = originalTags.image;
    }

    // 2. Clean Text Fields
    const textKeys = [
        'title', 'artist', 'album', 'composer', 'textWriter', 'subtitle',
        'originalTextwriter', 'originalArtist', 'performerInfo', 'internetRadioName',
        'bpm', 'year'
    ];

    textKeys.forEach(key => {
        if (cleanedTags[key]) {
            if (typeof cleanedTags[key] === 'string') {
                const cleaned = cleanText(cleanedTags[key]);
                if (cleaned) {
                    cleanedTags[key] = cleaned;
                } else {
                    delete cleanedTags[key];
                }
            }
        }
    });

    // 3. Clean Comment and Lyrics
    if (cleanedTags.comment) {
        const text = cleanText(cleanedTags.comment.text);
        if (text) {
            cleanedTags.comment.text = text;
            cleanedTags.comment.language = cleanedTags.comment.language || 'eng';
        } else {
            delete cleanedTags.comment;
        }
    }
    if (cleanedTags.unsynchronisedLyrics) {
        const text = cleanText(cleanedTags.unsynchronisedLyrics.text);
        if (text) {
            cleanedTags.unsynchronisedLyrics.text = text;
            cleanedTags.unsynchronisedLyrics.language = cleanedTags.unsynchronisedLyrics.language || 'eng';
        } else {
            delete cleanedTags.unsynchronisedLyrics;
        }
    }

    // 4. Clean URLs
    const urlKeys = ['commercialUrl', 'artistUrl', 'userDefinedUrl'];
    urlKeys.forEach(key => {
        if (Array.isArray(cleanedTags[key])) {
            cleanedTags[key] = cleanedTags[key].filter(item => {
                if (typeof item === 'string') {
                    const lower = item.toLowerCase();
                    return !lower.includes('starmusiq') && !lower.includes('masstamilan') && !lower.includes('isaimini');
                } else if (item && typeof item === 'object') {
                    const url = item.url || '';
                    const desc = item.description || '';
                    const lowerUrl = url.toLowerCase();
                    const lowerDesc = desc.toLowerCase();
                    const isPromo = lowerUrl.includes('starmusiq') || lowerUrl.includes('masstamilan') || lowerUrl.includes('isaimini') ||
                                    lowerDesc.includes('starmusiq') || lowerDesc.includes('masstamilan') || lowerDesc.includes('isaimini');
                    return !isPromo;
                }
                return true;
            });
            if (cleanedTags[key].length === 0) {
                delete cleanedTags[key];
            }
        }
    });

    const singleUrlKeys = ['fileUrl', 'audioSourceUrl', 'radioStationUrl'];
    singleUrlKeys.forEach(key => {
        if (cleanedTags[key] && typeof cleanedTags[key] === 'string') {
            const lower = cleanedTags[key].toLowerCase();
            if (lower.includes('starmusiq') || lower.includes('masstamilan') || lower.includes('isaimini')) {
                delete cleanedTags[key];
            }
        }
    });

    // 5. Clean Private Frames (PRIV)
    if (Array.isArray(cleanedTags.private)) {
        cleanedTags.private = cleanedTags.private.filter(item => {
            if (!item) return false;
            const owner = item.ownerIdentifier || '';
            let dataStr = '';
            let dataStr16 = '';
            if (item.data) {
                if (Buffer.isBuffer(item.data)) {
                    dataStr = item.data.toString('utf8').toLowerCase();
                    dataStr16 = item.data.toString('utf16le').toLowerCase();
                } else if (item.data.data) { // Handle serialised buffer object
                    const buf = Buffer.from(item.data.data);
                    dataStr = buf.toString('utf8').toLowerCase();
                    dataStr16 = buf.toString('utf16le').toLowerCase();
                }
            }
            const isPromo = owner.toLowerCase().includes('starmusiq') || owner.toLowerCase().includes('masstamilan') ||
                            dataStr.includes('starmusiq') || dataStr.includes('masstamilan') ||
                            dataStr16.includes('starmusiq') || dataStr16.includes('masstamilan');
            return !isPromo;
        });
        if (cleanedTags.private.length === 0) {
            delete cleanedTags.private;
        }
    }

    // 6. Crop Album Art Image to remove bottom watermark bar (10%)
    if (cleanedTags.image && cleanedTags.image.imageBuffer) {
        try {
            const image = await Jimp.read(cleanedTags.image.imageBuffer);
            const originalWidth = image.width;
            const originalHeight = image.height;
            const newHeight = Math.round(originalHeight * 0.9);
            
            image.crop({ x: 0, y: 0, w: originalWidth, h: newHeight });
            
            const croppedBuffer = await image.getBuffer(cleanedTags.image.mime || 'image/jpeg');
            cleanedTags.image.imageBuffer = croppedBuffer;
            console.log(`  -> Cropped cover art from ${originalWidth}x${originalHeight} to ${image.width}x${image.height}`);
        } catch (imgErr) {
            console.log(`  -> Skipping cover art crop (already cropped or invalid format): ${imgErr.message}`);
        }
    }

    // Remove raw tag definitions to let NodeID3 re-serialise cleanly
    delete cleanedTags.raw;

    // 7. Strip ID3v1 tags from the file structure (at the end of the file)
    const id3v1Stripped = stripID3v1(filePath);
    if (id3v1Stripped) {
        console.log(`  -> Stripped legacy ID3v1 tag from the end of the file.`);
    }

    // 8. Mark as Cleaned to prevent double-cropping on future script runs
    if (!cleanedTags.userDefinedText) {
        cleanedTags.userDefinedText = [];
    }
    cleanedTags.userDefinedText.push({
        description: 'MetadataCleaned',
        value: 'true'
    });

    // 9. Write cleaned ID3v2 tags back
    const success = NodeID3.write(cleanedTags, filePath);
    if (success) {
        console.log(`  -> Cleaned tags written successfully!`);
    } else {
        console.error(`  -> Failed to write cleaned tags to ${file}`);
    }
}

async function run() {
    for (const file of mp3Files) {
        try {
            await cleanFile(file);
        } catch (err) {
            console.error(`Error cleaning file ${file}:`, err);
        }
    }
    console.log('\n==========================================');
    console.log('Done! All songs in the root directory have been cleaned and cropped.');
}

run();
