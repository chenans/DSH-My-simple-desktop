'use strict';

const http = require('http');

http.get('http://127.0.0.1:3081/', (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    console.log('dsh running, HTML length:', d.length);

    // Look for class names that might match our selectors
    const classMatches = d.match(/class="[^"]*(?:loading|spinner|generating|thinking|streaming|abort|stop)[^"]*"/gi);
    console.log('Matching classes in static HTML:', classMatches ? classMatches.slice(0, 20) : 'none');

    // Also check for data-testid attributes with those keywords
    const testIdMatches = d.match(/data-testid="[^"]*(?:loading|spinner|generating|thinking|streaming|abort|stop)[^"]*"/gi);
    console.log('Matching data-testids:', testIdMatches ? testIdMatches.slice(0, 20) : 'none');

    // Check for aria-label with those keywords
    const ariaMatches = d.match(/aria-label="[^"]*(?:loading|spinner|generating|thinking|streaming|abort|stop)[^"]*"/gi);
    console.log('Matching aria-labels:', ariaMatches ? ariaMatches.slice(0, 20) : 'none');
  });
}).on('error', (e) => console.log('err:', e.message));
