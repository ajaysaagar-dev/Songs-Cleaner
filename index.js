const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const NodeID3 = require('node-id3');

// Attempt to load Jimp for artwork watermarks cropping
let Jimp;
try {
    const jimpModule = require('jimp');
    Jimp = jimpModule.Jimp;
    console.log('Jimp successfully loaded. Cover art watermark cropping (bottom 10%) is active.');
} catch (e) {
    console.warn('Jimp is not loaded or could not be initialized. Album artwork cropping will be skipped.', e.message);
}

// Port to run server
const PORT = 3000;

// Directories
const rootDir = __dirname;
const uncleanDir = path.join(rootDir, 'unclean');
const cleanDir = path.join(rootDir, 'clean');

// Ensure directories exist
if (!fs.existsSync(uncleanDir)) {
    fs.mkdirSync(uncleanDir, { recursive: true });
}
if (!fs.existsSync(cleanDir)) {
    fs.mkdirSync(cleanDir, { recursive: true });
}

// Clean promo text function
function cleanText(text, tagsList = []) {
    if (!text) return text;
    let cleaned = text;

    // Expand tagsList to include base tag variants (e.g. "masstamilan" for "masstamilan.com")
    const expandedTags = [];
    tagsList.forEach(tag => {
        if (!tag) return;
        expandedTags.push(tag);
        const dotIndex = tag.lastIndexOf('.');
        if (dotIndex > 0) {
            const baseTag = tag.substring(0, dotIndex);
            if (baseTag && !expandedTags.includes(baseTag)) {
                expandedTags.push(baseTag);
            }
        }
    });

    // Sort tags by length descending to ensure longer patterns are replaced before shorter ones
    expandedTags.sort((a, b) => b.length - a.length);

    // For each tag, remove it case-insensitively, along with any leading/trailing hyphens or extra whitespace
    expandedTags.forEach(tag => {
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\s*[-–—|]*\\s*${escapedTag}\\s*`, 'gi');
        cleaned = cleaned.replace(regex, ' ');
    });

    // Clean up empty brackets remaining, e.g. "Song Title []" -> "Song Title"
    cleaned = cleaned.replace(/\s*[\[{(]\s*[\])}]\s*/g, ' ');
    // Collapse extra spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
}

// Strip ID3v1 tags from file on disk
function stripID3v1(filePath) {
    try {
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
    } catch (e) {
        console.error(`Error stripping ID3v1 from ${filePath}:`, e.message);
        return false;
    }
}

// Process single file on disk (copy, strip ID3v1, clean ID3v2 tags, crop image)
async function cleanFile(sourcePath, destPath, tagsList = []) {
    // Expand tagsList to include base tag variants (e.g. "masstamilan" for "masstamilan.com")
    const expandedTags = [];
    tagsList.forEach(tag => {
        if (!tag) return;
        expandedTags.push(tag);
        const dotIndex = tag.lastIndexOf('.');
        if (dotIndex > 0) {
            const baseTag = tag.substring(0, dotIndex);
            if (baseTag && !expandedTags.includes(baseTag)) {
                expandedTags.push(baseTag);
            }
        }
    });
    expandedTags.sort((a, b) => b.length - a.length);

    const destDir = path.dirname(destPath);
    const originalFilename = path.basename(destPath);
    
    const ext = path.extname(originalFilename);
    const base = path.basename(originalFilename, ext);
    let cleanedBase = cleanText(base, expandedTags);
    if (!cleanedBase) {
        cleanedBase = base;
    }
    const cleanedFilename = cleanedBase + ext;
    let finalDestPath = path.join(destDir, cleanedFilename);

    const changes = [];
    const before = {};
    const after = {};
    if (cleanedFilename !== originalFilename) {
        let counter = 1;
        const nameWithoutExt = cleanedBase;
        while (fs.existsSync(finalDestPath)) {
            const newFilename = `${nameWithoutExt} (${counter})${ext}`;
            finalDestPath = path.join(destDir, newFilename);
            counter++;
        }
        changes.push(`Renamed file: "${originalFilename}" -> "${path.basename(finalDestPath)}"`);
    } else {
        let counter = 1;
        const nameWithoutExt = cleanedBase;
        while (fs.existsSync(finalDestPath) && (sourcePath ? finalDestPath !== sourcePath : true)) {
            const newFilename = `${nameWithoutExt} (${counter})${ext}`;
            finalDestPath = path.join(destDir, newFilename);
            counter++;
        }
        if (finalDestPath !== path.join(destDir, originalFilename)) {
            changes.push(`Renamed file: "${originalFilename}" -> "${path.basename(finalDestPath)}"`);
        }
    }

    if (sourcePath) {
        fs.copyFileSync(sourcePath, finalDestPath);
    } else {
        if (destPath !== finalDestPath) {
            fs.renameSync(destPath, finalDestPath);
        }
    }

    destPath = finalDestPath;

    // 1. Strip ID3v1
    const id3v1Stripped = stripID3v1(destPath);
    if (id3v1Stripped) {
        changes.push('Stripped legacy ID3v1 tag from the end of the file.');
    }

    // 2. Read ID3v2 tags
    let originalTags = {};
    try {
        originalTags = NodeID3.read(destPath);
    } catch (readErr) {
        console.error('Error reading tags:', readErr.message);
    }

    if (originalTags && Object.keys(originalTags).length > 0) {
        const cleanedTags = JSON.parse(JSON.stringify(originalTags));
        if (originalTags.image) {
            cleanedTags.image = originalTags.image;
        }

        // Clean Text Fields
        const textKeys = [
            'title', 'artist', 'album', 'composer', 'textWriter', 'subtitle',
            'originalTextwriter', 'originalArtist', 'performerInfo', 'internetRadioName',
            'bpm', 'year'
        ];

        textKeys.forEach(key => {
            if (originalTags[key]) {
                before[key] = originalTags[key];
                const cleaned = cleanText(originalTags[key], tagsList);
                if (cleaned !== originalTags[key]) {
                    if (cleaned) {
                        cleanedTags[key] = cleaned;
                        after[key] = cleaned;
                        changes.push(`Updated ${key}: "${originalTags[key]}" -> "${cleaned}"`);
                    } else {
                        delete cleanedTags[key];
                        after[key] = '[REMOVED]';
                        changes.push(`Removed promo-only field ${key}: "${originalTags[key]}"`);
                    }
                } else {
                    after[key] = originalTags[key];
                }
            }
        });

        // Clean Comment and Lyrics
        if (originalTags.comment) {
            before.comment = originalTags.comment.text;
            const cleaned = cleanText(originalTags.comment.text, tagsList);
            if (cleaned !== originalTags.comment.text) {
                if (cleaned) {
                    cleanedTags.comment = {
                        text: cleaned,
                        language: originalTags.comment.language || 'eng'
                    };
                    after.comment = cleaned;
                    changes.push(`Updated comment: "${originalTags.comment.text}" -> "${cleaned}"`);
                } else {
                    delete cleanedTags.comment;
                    after.comment = '[REMOVED]';
                    changes.push(`Removed promo-only comment: "${originalTags.comment.text}"`);
                }
            } else {
                after.comment = originalTags.comment.text;
                cleanedTags.comment.language = originalTags.comment.language || 'eng';
            }
        }
        
        if (originalTags.unsynchronisedLyrics) {
            before.lyrics = originalTags.unsynchronisedLyrics.text;
            const cleaned = cleanText(originalTags.unsynchronisedLyrics.text, tagsList);
            if (cleaned !== originalTags.unsynchronisedLyrics.text) {
                if (cleaned) {
                    cleanedTags.unsynchronisedLyrics = {
                        text: cleaned,
                        language: originalTags.unsynchronisedLyrics.language || 'eng'
                    };
                    after.lyrics = cleaned;
                    changes.push(`Updated lyrics: "${originalTags.unsynchronisedLyrics.text}" -> "${cleaned}"`);
                } else {
                    delete cleanedTags.unsynchronisedLyrics;
                    after.lyrics = '[REMOVED]';
                    changes.push(`Removed promo-only lyrics`);
                }
            } else {
                after.lyrics = originalTags.unsynchronisedLyrics.text;
                cleanedTags.unsynchronisedLyrics.language = originalTags.unsynchronisedLyrics.language || 'eng';
            }
        }

        // Clean URLs
        const urlKeys = ['commercialUrl', 'artistUrl', 'userDefinedUrl'];
        urlKeys.forEach(key => {
            if (Array.isArray(originalTags[key])) {
                const filtered = originalTags[key].filter(item => {
                    let urlVal = '';
                    let descVal = '';
                    if (typeof item === 'string') {
                        urlVal = item;
                    } else if (item && typeof item === 'object') {
                        urlVal = item.url || '';
                        descVal = item.description || '';
                    }
                    const lowerUrl = urlVal.toLowerCase();
                    const lowerDesc = descVal.toLowerCase();
                    const isPromo = expandedTags.some(tag => {
                        const t = tag.toLowerCase();
                        return lowerUrl.includes(t) || lowerDesc.includes(t);
                    });
                    return !isPromo;
                });
                if (filtered.length !== originalTags[key].length) {
                    changes.push(`Cleaned URL list ${key}`);
                    if (filtered.length === 0) {
                        delete cleanedTags[key];
                    } else {
                        cleanedTags[key] = filtered;
                    }
                }
            }
        });

        const singleUrlKeys = ['fileUrl', 'audioSourceUrl', 'radioStationUrl'];
        singleUrlKeys.forEach(key => {
            if (originalTags[key] && typeof originalTags[key] === 'string') {
                const lower = originalTags[key].toLowerCase();
                const isPromo = expandedTags.some(tag => lower.includes(tag.toLowerCase()));
                if (isPromo) {
                    delete cleanedTags[key];
                    changes.push(`Removed promo URL in ${key}: "${originalTags[key]}"`);
                }
            }
        });

        // Clean Private Frames (PRIV)
        if (Array.isArray(originalTags.private)) {
            const filteredPrivate = originalTags.private.filter(item => {
                if (!item) return false;
                const owner = item.ownerIdentifier || '';
                let dataStr = '';
                let dataStr16 = '';
                if (item.data) {
                    if (Buffer.isBuffer(item.data)) {
                        dataStr = item.data.toString('utf8').toLowerCase();
                        dataStr16 = item.data.toString('utf16le').toLowerCase();
                    } else if (item.data.data) {
                        const buf = Buffer.from(item.data.data);
                        dataStr = buf.toString('utf8').toLowerCase();
                        dataStr16 = buf.toString('utf16le').toLowerCase();
                    }
                }
                const ownerLower = owner.toLowerCase();
                const isPromo = expandedTags.some(tag => {
                    const t = tag.toLowerCase();
                    return ownerLower.includes(t) || dataStr.includes(t) || dataStr16.includes(t);
                });
                return !isPromo;
            });
            if (filteredPrivate.length !== originalTags.private.length) {
                changes.push(`Removed promotional private (PRIV) tags`);
                if (filteredPrivate.length === 0) {
                    delete cleanedTags.private;
                } else {
                    cleanedTags.private = filteredPrivate;
                }
            }
        }

        // Crop Album Art (Jimp)
        if (Jimp && cleanedTags.image && cleanedTags.image.imageBuffer) {
            try {
                const img = await Jimp.read(cleanedTags.image.imageBuffer);
                const originalWidth = img.width;
                const originalHeight = img.height;
                const newHeight = Math.round(originalHeight * 0.9);

                img.crop({ x: 0, y: 0, w: originalWidth, h: newHeight });

                const croppedBuffer = await img.getBuffer(cleanedTags.image.mime || 'image/jpeg');
                cleanedTags.image.imageBuffer = croppedBuffer;
                changes.push(`Cropped cover art from ${originalWidth}x${originalHeight} to ${img.width}x${img.height}`);
            } catch (imgErr) {
                changes.push(`Skipped cover art crop: ${imgErr.message}`);
            }
        }

        delete cleanedTags.raw;

        // Mark as cleaned
        if (!cleanedTags.userDefinedText) {
            cleanedTags.userDefinedText = [];
        }
        cleanedTags.userDefinedText = cleanedTags.userDefinedText.filter(
            item => item.description !== 'MetadataCleaned'
        );
        cleanedTags.userDefinedText.push({
            description: 'MetadataCleaned',
            value: 'true'
        });

        // Write tags back
        const writeSuccess = NodeID3.write(cleanedTags, destPath);
        if (!writeSuccess) {
            throw new Error('NodeID3 failed to write cleaned tags.');
        }
    } else {
        changes.push('No ID3v2 tags existed. Saved with stripped ID3v1.');
    }

    return { changes, before, after, cleanedFilename };
}

// Check if file is already cleaned
function isFileCleaned(filePath) {
    try {
        const tags = NodeID3.read(filePath);
        if (tags && Array.isArray(tags.userDefinedText)) {
            return tags.userDefinedText.some(
                item => item.description === 'MetadataCleaned' && item.value === 'true'
            );
        }
    } catch (e) {}
    return false;
}

// Read Title
function getFileTitle(filePath) {
    try {
        const tags = NodeID3.read(filePath);
        return tags ? tags.title || '' : '';
    } catch (e) {
        return '';
    }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // Helper for JSON response
    const jsonRes = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };

    // UI Serving
    if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = path.join(rootDir, 'public', 'index.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(htmlPath));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('UI html file not found.');
        }
    }
    
    // GET: List files in unclean folder
    else if (pathname === '/api/unclean-songs' && req.method === 'GET') {
        try {
            const files = fs.readdirSync(uncleanDir);
            const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
            const data = mp3Files.map(file => {
                const filePath = path.join(uncleanDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    cleaned: isFileCleaned(filePath),
                    title: getFileTitle(filePath)
                };
            });
            jsonRes(200, data);
        } catch (err) {
            jsonRes(500, { error: err.message });
        }
    }

    // POST: Clean unclean folder songs
    else if (pathname === '/api/clean-unclean' && req.method === 'POST') {
        try {
            let bodyStr = '';
            req.on('data', chunk => bodyStr += chunk);
            req.on('end', async () => {
                try {
                    let tagsList = [];
                    if (bodyStr) {
                        const body = JSON.parse(bodyStr);
                        tagsList = body.tags || [];
                    }
                    const files = fs.readdirSync(uncleanDir);
                    const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
                    const results = [];

                    for (const file of mp3Files) {
                        const srcPath = path.join(uncleanDir, file);
                        const destPath = path.join(cleanDir, file);
                        try {
                            const details = await cleanFile(srcPath, destPath, tagsList);
                            results.push({ file, cleanedFile: details.cleanedFilename, success: true, details });
                        } catch (err) {
                            results.push({ file, success: false, error: err.message });
                        }
                    }
                    jsonRes(200, results);
                } catch (err) {
                    jsonRes(500, { error: err.message });
                }
            });
        } catch (err) {
            jsonRes(500, { error: err.message });
        }
    }

    // POST: Clean a single song in unclean folder
    else if (pathname === '/api/clean-file' && req.method === 'POST') {
        try {
            let bodyStr = '';
            req.on('data', chunk => bodyStr += chunk);
            req.on('end', async () => {
                try {
                    let tagsList = [];
                    let file = '';
                    if (bodyStr) {
                        const body = JSON.parse(bodyStr);
                        tagsList = body.tags || [];
                        file = body.file;
                    }
                    if (!file) {
                        return jsonRes(400, { error: 'Missing file name' });
                    }
                    const srcPath = path.join(uncleanDir, file);
                    const destPath = path.join(cleanDir, file);
                    if (!fs.existsSync(srcPath)) {
                        return jsonRes(404, { error: 'File not found' });
                    }
                    const details = await cleanFile(srcPath, destPath, tagsList);
                    jsonRes(200, { file, cleanedFile: details.cleanedFilename, success: true, details });
                } catch (err) {
                    jsonRes(500, { error: err.message });
                }
            });
        } catch (err) {
            jsonRes(500, { error: err.message });
        }
    }

    // POST: Clean dropped file (binary body)
    else if (pathname === '/api/clean-dropped' && req.method === 'POST') {
        try {
            const filename = decodeURIComponent(req.headers['x-filename'] || 'uploaded_song.mp3');
            
            // Extract tags from X-Tags header
            let tagsList = [];
            if (req.headers['x-tags']) {
                try {
                    tagsList = JSON.parse(decodeURIComponent(req.headers['x-tags']));
                } catch (e) {
                    console.error('Failed to parse X-Tags header:', e.message);
                }
            }

            const destPath = path.join(cleanDir, filename);

            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', async () => {
                try {
                    const fileBuffer = Buffer.concat(chunks);
                    // Write original buffer to dest
                    fs.writeFileSync(destPath, fileBuffer);
                    // Process the written file
                    const details = await cleanFile(null, destPath, tagsList);
                    jsonRes(200, { success: true, file: details.cleanedFilename || filename, details });
                } catch (err) {
                    jsonRes(500, { error: err.message });
                }
            });
        } catch (err) {
            jsonRes(500, { error: err.message });
        }
    }

    // POST: Open Explorer Folder
    else if (pathname === '/api/open-folder' && req.method === 'POST') {
        try {
            let bodyStr = '';
            req.on('data', chunk => bodyStr += chunk);
            req.on('end', () => {
                try {
                    const body = JSON.parse(bodyStr);
                    const folder = body.folder === 'clean' ? cleanDir : uncleanDir;
                    
                    // Windows specific Explorer opening
                    exec(`explorer.exe "${folder}"`, (err) => {
                        if (err) {
                            jsonRes(500, { error: err.message });
                        } else {
                            jsonRes(200, { success: true });
                        }
                    });
                } catch (jsonErr) {
                    jsonRes(400, { error: 'Invalid JSON body' });
                }
            });
        } catch (err) {
            jsonRes(500, { error: err.message });
        }
    }

    // Default 404
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Start listening and launch browser
server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n==========================================`);
    console.log(`Songs Cleaner running at: ${url}`);
    console.log(`Unclean Folder: ${uncleanDir}`);
    console.log(`Clean Folder: ${cleanDir}`);
    console.log(`==========================================\n`);

    // Auto open browser in Windows
    exec(`start ${url}`, (err) => {
        if (err) {
            console.log(`Please open your browser and navigate to: ${url}`);
        } else {
            console.log('Opened Web UI automatically in your default browser.');
        }
    });
});
