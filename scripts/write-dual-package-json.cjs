const fs = require('node:fs');
const path = require('node:path');

function writePackage(directory, type) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'package.json'),
        `${JSON.stringify({ type }, null, 4)}\n`,
    );
}

writePackage(path.join('dist', 'esm'), 'module');
writePackage(path.join('dist', 'cjs'), 'commonjs');
if (fs.existsSync('.test-build')) {
    writePackage('.test-build', 'commonjs');
}
