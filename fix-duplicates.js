// Save as fix-duplicates.js and run with: node fix-duplicates.js
import sqlite3 from 'sqlite3';
import fs from 'fs/promises';

const db = new sqlite3.Database('./circuits.db');

async function fixDuplicates() {
    console.log("🔧 Fixing HTTP/HTTPS duplicates...");
    
    // Get all circuits
    const circuits = await new Promise((resolve) => {
        db.all("SELECT id, url FROM circuits ORDER BY id", (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    // Group by normalized URL
    const groups = new Map();
    for (const circuit of circuits) {
        let normalized = circuit.url;
        if (normalized.startsWith('http://')) {
            normalized = 'https://' + normalized.substring(7);
        }
        if (!groups.has(normalized)) {
            groups.set(normalized, []);
        }
        groups.get(normalized).push(circuit);
    }
    
    // Delete duplicates
    let deleted = 0;
    for (const [normalized, items] of groups) {
        if (items.length > 1) {
            // Keep the https version if exists, otherwise keep the first
            const httpsItem = items.find(i => i.url.startsWith('https'));
            const keepItem = httpsItem || items[0];
            const deleteItems = items.filter(i => i.id !== keepItem.id);
            
            for (const del of deleteItems) {
                await new Promise((resolve) => {
                    db.run("DELETE FROM circuits WHERE id = ?", [del.id], (err) => {
                        if (!err) {
                            deleted++;
                            console.log(`Deleted: ${del.url} (kept: ${keepItem.url})`);
                        }
                        resolve();
                    });
                });
            }
        }
    }
    
    console.log(`\n✅ Fixed ${deleted} duplicate entries`);
    
    // Export clean JSON
    const remaining = await new Promise((resolve) => {
        db.all("SELECT * FROM circuits", (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    const exportData = remaining.map(row => ({
        url: row.url,
        effect_name: row.effect_name,
        type: row.type,
        parts_count: row.parts_count,
        difficulty: row.difficulty,
        tags: row.tags ? JSON.parse(row.tags) : [],
        image_url: row.image_url,
        components: row.components ? JSON.parse(row.components) : {},
        description: row.description,
        verified: row.verified === 1,
        category: row.category || 'circuit'
    }));
    
    await fs.writeFile('./data/circuits.json', JSON.stringify(exportData, null, 2));
    console.log(`📦 Exported ${exportData.length} clean circuits to JSON`);
    
    db.close();
}

fixDuplicates().catch(console.error);