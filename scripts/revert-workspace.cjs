const fs = require('fs');
const path = require('path');

const tradeMetricsPath = path.resolve(__dirname, '../../../Trade-Metrics-main');

// 1. Revert pnpm-workspace.yaml to remove the hardcoded local path
const workspaceYamlPath = path.join(tradeMetricsPath, 'pnpm-workspace.yaml');
if (fs.existsSync(workspaceYamlPath)) {
  let workspaceYamlContent = fs.readFileSync(workspaceYamlPath, 'utf-8');
  workspaceYamlContent = workspaceYamlContent.replace(/\s*-\s*'\.\.\/MatrixCharts-Lite-master\/MatrixCharts-Lite'/g, '');
  fs.writeFileSync(workspaceYamlPath, workspaceYamlContent, 'utf-8');
  console.log('Removed local path from pnpm-workspace.yaml');
}

// 2. Update package.json to point to GitHub instead of workspace
const packageJsonPath = path.join(tradeMetricsPath, 'package.json');
if (fs.existsSync(packageJsonPath)) {
  let packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
  packageJsonContent = packageJsonContent.replace(
    /"@matrixcharts\/lite":\s*"workspace:\*"/,
    `"@matrixcharts/lite": "github:matrixcharts/MatrixCharts-Lite"`
  );
  fs.writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');
  console.log('Updated package.json to fetch from GitHub');
}
