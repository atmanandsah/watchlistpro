#!/usr/bin/env node
/**
 * Downloads Upstox instrument master data and generates instruments-upstox.json
 * Run: node build-instruments.js
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const URLS = {
  NSE: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz'
};

function fetchGzip(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return fetchGzip(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => zlib.gunzip(Buffer.concat(chunks), (err, buf) => err ? reject(err) : resolve(buf.toString())));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Upstox Instrument Builder ===\n');
  const mapping = {};
  let total = 0;

  for (const [exchange, url] of Object.entries(URLS)) {
    try {
      console.log(`  Fetching ${exchange}...`);
      const data = JSON.parse(await fetchGzip(url));
      console.log(`  ${exchange}: ${data.length} raw instruments`);

      for (const item of data) {
        const seg = item.segment;
        if (seg === 'NSE_EQ' && !['EQ', 'SM'].includes(item.instrument_type)) continue;
        if (seg === 'BSE_EQ' && !['A', 'B', 'T', 'X', 'XT', 'E'].includes(item.instrument_type)) continue;
        if (seg !== 'NSE_EQ' && seg !== 'BSE_EQ') continue;

        const sym = item.trading_symbol;
        const isin = item.isin;
        if (!sym || !isin) continue;

        const exch = seg === 'BSE_EQ' ? 'BSE' : 'NSE';
        // Now saving 'i' for ISIN instead of 't' for token
        mapping[`${exch}:${sym}`] = { i: isin, n: item.name || '', s: item.short_name || '' };
        total++;
      }
    } catch (e) {
      console.error(`  ERROR ${exchange}: ${e.message}`);
    }
  }

  const outPath = path.join(__dirname, 'instruments-upstox.json');
  fs.writeFileSync(outPath, JSON.stringify(mapping));
  console.log(`\n  Kept: ${total} instruments`);
  console.log(`  Size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
  console.log('\n=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
