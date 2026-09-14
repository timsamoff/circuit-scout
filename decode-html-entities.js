// Shared HTML entity decoder — used by server.js, fix-titles.js, and
// fix-descriptions.js. Previously duplicated independently in each with
// drifting entity coverage; this is the consolidated, most complete version.
export function decodeHtmlEntities(text) {
    if (!text) return '';

    let decoded = text;

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
        '&#8217;': "'",
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

    for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.split(entity).join(char);
    }

    // All numeric entities like &#123; or &#x7B;
    decoded = decoded.replace(/&#(\d+);/g, (match, num) => {
        return String.fromCharCode(parseInt(num, 10));
    });

    // Hex entities like &#x3C;
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });

    // Decimal entities without a semicolon (malformed)
    decoded = decoded.replace(/&#(\d+)(?!;)/g, (match, num) => {
        return String.fromCharCode(parseInt(num, 10));
    });

    return decoded;
}
