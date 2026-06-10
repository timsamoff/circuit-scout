import sqlite3 from 'sqlite3';
import fs from 'fs';

// Comprehensive HTML entity decoder
function decodeHtmlEntities(text) {
    if (!text) return '';
    
    let decoded = text;
    
    // Common named entities
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&#038;': '&',
        '&nbsp;': ' ',
        '&#160;': ' ',
        '&copy;': '©',
        '&reg;': '®',
        '&trade;': '™',
        '&mdash;': '—',
        '&ndash;': '–',
        '&hellip;': '…',
        '&#8211;': '–',
        '&#8212;': '—',
        '&#8216;': "'",
        '&#8217;': "'",      // This is the one you're seeing
        '&#8218;': '‚',
        '&#8220;': '"',
        '&#8221;': '"',
        '&#8222;': '„',
        '&#8230;': '…',
        '&#8242;': "'",
        '&#8243;': '"',
        '&#8250;': '›',
        '&#8249;': '‹',
        '&#8260;': '/',
        '&#8482;': '™',
        '&#8710;': '∆',
        '&#8734;': '∞',
        '&#8592;': '←',
        '&#8593;': '↑',
        '&#8594;': '→',
        '&#8595;': '↓'
    };
    
    // Replace named entities
    for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.split(entity).join(char);
    }
    
    // Handle ALL numeric entities like &#123; or &#x7B;
    // This will catch &#8217; and convert it to '
    decoded = decoded.replace(/&#(\d+);/g, (match, num) => {
        const code = parseInt(num, 10);
        return String.fromCharCode(code);
    });
    
    // Handle hex entities like &#x3C;
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Also handle decimal entities without semicolon (malformed)
    decoded = decoded.replace(/&#(\d+)(?!;)/g, (match, num) => {
        return String.fromCharCode(parseInt(num, 10));
    });
    
    return decoded;
}

const db = new sqlite3.Database('./circuits.db');

console.log("🔍 Finding circuits with HTML entities in descriptions...\n");

// Find ALL circuits that might have entities (broader search)
db.all("SELECT id, effect_name, description FROM circuits WHERE description IS NOT NULL AND description != ''", (err, rows) => {
    if (err) {
        console.error("Error:", err.message);
        db.close();
        return;
    }
    
    console.log(`Checking ${rows.length} circuits...\n`);
    
    let updated = 0;
    let problems = [];
    
    for (const row of rows) {
        const originalDesc = row.description;
        const decoded = decodeHtmlEntities(originalDesc);
        
        if (decoded !== originalDesc) {
            db.run("UPDATE circuits SET description = ? WHERE id = ?", [decoded, row.id], (err) => {
                if (err) {
                    console.error(`  ❌ Failed to update: ${row.effect_name}`);
                    problems.push(row.effect_name);
                } else {
                    updated++;
                    console.log(`  ✅ Fixed: ${row.effect_name}`);
                    // Show the fix
                    if (originalDesc.includes('&#8217;')) {
                        console.log(`     ${originalDesc.substring(0, 100)}...`);
                        console.log(`     ${decoded.substring(0, 100)}...\n`);
                    }
                }
            });
        }
    }
    
    setTimeout(() => {
        console.log(`\n📊 Summary:`);
        console.log(`   ✅ Updated: ${updated} circuits`);
        if (problems.length > 0) {
            console.log(`   ❌ Failed: ${problems.length}`);
        }
        
        // Also fix the JSON file
        console.log("\n📦 Updating circuits.json...");
        try {
            const jsonData = fs.readFileSync('./data/circuits.json', 'utf8');
            let circuits = JSON.parse(jsonData);
            
            let jsonUpdated = 0;
            for (const circuit of circuits) {
                if (circuit.description) {
                    const originalDesc = circuit.description;
                    circuit.description = decodeHtmlEntities(circuit.description);
                    if (originalDesc !== circuit.description) {
                        jsonUpdated++;
                    }
                }
            }
            
            fs.writeFileSync('./data/circuits.json', JSON.stringify(circuits, null, 2));
            console.log(`   ✅ Fixed ${jsonUpdated} descriptions in circuits.json`);
            
        } catch (jsonErr) {
            console.error("   ❌ Failed to update JSON:", jsonErr.message);
        }
        
        db.close();
    }, 3000);
});