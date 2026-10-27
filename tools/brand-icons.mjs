import sharp from 'sharp';
const root = new URL('../public/', import.meta.url).pathname;
const mark = (stroke, bg, size, pad = 0) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${100 + 2 * pad} ${100 + 2 * pad}">
<rect x="${-pad}" y="${-pad}" width="${100 + 2 * pad}" height="${100 + 2 * pad}" fill="${bg}"/>
<g fill="none" stroke="${stroke}" stroke-width="5.4"><path d="M50 21.5 78.5 50 50 78.5 21.5 50Z"/><path d="M28.2 28.2 71.8 71.8M71.8 28.2 28.2 71.8"/></g></svg>`);
await sharp(mark('#e6e6e6', '#1d1d1d', 32, -12)).png().toFile(root + 'favicon-32.png');
await sharp(mark('#e6e6e6', '#1d1d1d', 180, -6)).png().toFile(root + 'apple-touch-icon.png');
await sharp(mark('#e6e6e6', '#1d1d1d', 192, -6)).png().toFile(root + 'icon-192.png');
await sharp(mark('#e6e6e6', '#1d1d1d', 512, -6)).png().toFile(root + 'icon-512.png');
// Open Graph card 1200x630: mark + name.
const og = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="g" cx="0.3" cy="0.5" r="0.8"><stop offset="0" stop-color="#14252a"/><stop offset="1" stop-color="#07090d"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<g transform="translate(60 185) scale(2.6)" fill="none" stroke="#e6e6e6" stroke-width="5.4"><path d="M50 21.5 78.5 50 50 78.5 21.5 50Z"/><path d="M28.2 28.2 71.8 71.8M71.8 28.2 28.2 71.8"/></g>
<text x="380" y="300" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="86" letter-spacing="9" fill="#eef3f5">NORTH ECHO</text>
<text x="384" y="362" font-family="Helvetica, Arial, sans-serif" font-size="30" letter-spacing="3" fill="#3fd6c8">ТАКТИЧЕСКИЙ ШУТЕР В БРАУЗЕРЕ</text>
<text x="384" y="418" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#9aa8b2">Свет и тени · кооператив · рейтинговые бои</text>
</svg>`);
await sharp(og).png().toFile(root + 'og.png');
console.log('ok');
