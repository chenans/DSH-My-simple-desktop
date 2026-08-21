'use strict';

/**
 * Inspect dsh web frontend DOM to find the send/stop button.
 * Connects to running dsh on port 3081 and dumps relevant DOM info.
 * 
 * Run: node scripts/inspect-dsh-dom.js
 */

const http = require('http');

// Fetch the SPA HTML and look for button-related patterns
http.get('http://127.0.0.1:3081/', (res) => {
  let html = '';
  res.on('data', (c) => (html += c));
  res.on('end', () => {
    console.log('=== dsh SPA HTML Analysis ===\n');
    console.log('HTML length:', html.length);

    // Find all button-related patterns
    const patterns = [
      /<button[^>]*>/gi,
      /data-testid="[^"]*"/gi,
      /aria-label="[^"]*"/gi,
      /class="[^"]*send[^"]*"/gi,
      /class="[^"]*submit[^"]*"/gi,
      /class="[^"]*stop[^"]*"/gi,
      /class="[^"]*abort[^"]*"/gi,
      /class="[^"]*generat[^"]*"/gi,
      /id="[^"]*send[^"]*"/gi,
      /id="[^"]*submit[^"]*"/gi,
      /id="[^"]*stop[^"]*"/gi,
      /type="submit"/gi,
    ];

    for (const pattern of patterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) {
        console.log(`\nPattern ${pattern}:`);
        matches.slice(0, 10).forEach((m) => console.log('  ', m));
      }
    }

    // Also look for SVG icons (send/stop buttons often use SVG)
    const svgMatches = html.match(/<svg[^>]*>/gi);
    if (svgMatches) {
      console.log('\nSVG icons:', svgMatches.length);
    }

    // Look for textarea or input (chat input area)
    const inputMatches = html.match(/<(textarea|input)[^>]*>/gi);
    if (inputMatches) {
      console.log('\nInput elements:');
      inputMatches.slice(0, 10).forEach((m) => console.log('  ', m));
    }

    // Look for form elements
    const formMatches = html.match(/<form[^>]*>/gi);
    if (formMatches) {
      console.log('\nForm elements:', formMatches.length);
    }
  });
}).on('error', (e) => {
  console.log('Error:', e.message);
  console.log('Make sure dsh is running on port 3081');
});
