import assert from 'node:assert';
import { iconLinks } from './favicon';

assert.deepStrictEqual(
  iconLinks(`<head>
    <link rel="stylesheet" href="/a.css">
    <link rel="apple-touch-icon" href="/touch.png">
    <link href='/logo.svg' rel='icon' type='image/svg+xml'>
    <LINK REL="shortcut icon" HREF=/fav.png>
  </head>`),
  ['/logo.svg', '/fav.png', '/touch.png'],
);
assert.deepStrictEqual(iconLinks('<p>no links</p>'), []);
console.log('favicon: ok');
