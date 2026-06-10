// save as fix-entities.js
import sqlite3 from 'sqlite3';

function decodeHtmlEntities(text) {
    if (!text) return '';
    
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&#038;': '&',
        '&#8217;': "'",
        '&#8220;': '"',
        '&#8221;': '"',
        '&#8216;': "'",
        '&#8211;': '-',
        '&#8212;': '--',
        '&#8230;': '...',
        '&nbsp;': ' '
    };
    
    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.split(entity).join(char);
    }
    
    decoded = decoded.replace(/&#(\d+);/g, (match, num) => {
        return String.fromCharCode(parseInt(num, 10));
    });
    
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    
    return decoded;
}

const db = new sqlite3.Database('./circuits.db');

db.all("SELECT id, effect_name FROM circuits WHERE effect_name LIKE '%&%' OR effect_name LIKE '%&#%'", (err, rows) => {
    if (err) {
        console.error("Error:", err.message);
        db.close();
        return;
    }
    
    console.log(`Found ${rows.length} circuits with HTML entities`);
    
    let updated = 0;
    for (const row of rows) {
        const decoded = decodeHtmlEntities(row.effect_name);
        if (decoded !== row.effect_name) {
            db.run("UPDATE circuits SET effect_name = ? WHERE id = ?", [decoded, row.id], (err) => {
                if (!err) {
                    updated++;
                    console.log(`  Fixed: ${row.effect_name} -> ${decoded}`);
                }
            });
        }
    }
    
    setTimeout(() => {
        console.log(`\n✅ Updated ${updated} circuits`);
        db.close();
    }, 1000);
});