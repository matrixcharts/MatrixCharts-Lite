const fs = require('fs');
const path = require('path');

const tradeMetricsPath = path.resolve(__dirname, '../../../Trade-Metrics-main');

// Update package.json to just workspace:*
const packageJsonPath = path.join(tradeMetricsPath, 'package.json');
let packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
// Replace previous failed alias or github link with simple workspace:*
packageJsonContent = packageJsonContent.replace(
  /"matrixcharts":\s*".*?"/,
  `"matrixcharts": "workspace:*"`
);
fs.writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');
console.log('Updated package.json for simple workspace reference');
