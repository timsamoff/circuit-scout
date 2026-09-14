import sqlite3 from 'sqlite3';
import { decodeHtmlEntities } from './decode-html-entities.js';

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