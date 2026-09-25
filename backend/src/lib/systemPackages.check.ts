/** Self-check: npx tsx src/lib/systemPackages.check.ts */
import assert from 'assert';
import { detectSystemPackages, readSystemPackages } from './systemPackages';

assert.deepStrictEqual(detectSystemPackages({ LIBREOFFICE_PATH: '/usr/bin' }), [{ key: 'libreoffice', from: 'LIBREOFFICE_PATH' }]);
assert.deepStrictEqual(detectSystemPackages({ CONVERTER_BIN: '/usr/bin/soffice' }), [{ key: 'libreoffice', from: 'CONVERTER_BIN' }]);
assert.deepStrictEqual(detectSystemPackages({ DATABASE_URL: 'postgres://x', OFFICE_NAME: 'Kantor' }), []);
assert.deepStrictEqual(readSystemPackages(['libreoffice', 'libreoffice']), ['libreoffice']);
assert.strictEqual(readSystemPackages(['curl']), null);
console.log('systemPackages: ok');
