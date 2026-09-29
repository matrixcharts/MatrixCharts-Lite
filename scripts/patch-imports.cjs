const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const tradeMetricsPath = path.resolve(__dirname, '../../../Trade-Metrics-main');

// 1. Update package.json
const packageJsonPath = path.join(tradeMetricsPath, 'package.json');
let packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
packageJsonContent = packageJsonContent.replace(
  /"matrixcharts":\s*".*?"/,
  `"@matrixcharts/lite": "workspace:*"`
);
fs.writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');
console.log('Updated package.json to use @matrixcharts/lite');

// 2. Find and replace imports in Trade-Metrics
function replaceInDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      replaceInDir(fullPath);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.js') || fullPath.endsWith('.jsx')) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes('from "matrixcharts"') || content.includes("from 'matrixcharts'")) {
        content = content.replace(/from "matrixcharts"/g, 'from "@matrixcharts/lite"');
        content = content.replace(/from 'matrixcharts'/g, "from '@matrixcharts/lite'");
        fs.writeFileSync(fullPath, content, 'utf-8');
        console.log(`Updated imports in ${file}`);
      }
    }
  }
}

replaceInDir(path.join(tradeMetricsPath, 'src'));

console.log('Patch complete. Running pnpm install...');
try {
  execSync('pnpm install', { cwd: tradeMetricsPath, stdio: 'inherit' });
} catch (e) {
  console.error('pnpm install failed', e);
}
