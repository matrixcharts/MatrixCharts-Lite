const fs = require('fs');
const path = require('path');

const tradeMetricsPath = path.resolve(__dirname, '../../../Trade-Metrics-main');

// 1. Update pnpm-workspace.yaml
const workspaceYamlPath = path.join(tradeMetricsPath, 'pnpm-workspace.yaml');
const workspaceYamlContent = `packages:
  - '.'
  - '../MatrixCharts-Lite-master/MatrixCharts-Lite'
allowBuilds:
  core-js: true
  core-js-pure: true
  esbuild: true
  lightweight-charts: false
  onnxruntime-node: true
  protobufjs: true
  sharp: true
  "matrixcharts": true
  "@matrixcharts/lite": true
`;
fs.writeFileSync(workspaceYamlPath, workspaceYamlContent, 'utf-8');
console.log('Updated pnpm-workspace.yaml');

// 2. Update package.json
const packageJsonPath = path.join(tradeMetricsPath, 'package.json');
let packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
// Replace github link or local tarball with workspace alias
packageJsonContent = packageJsonContent.replace(
  /"matrixcharts":\s*".*?"/,
  `"matrixcharts": "npm:@matrixcharts/lite@workspace:*"`
);
fs.writeFileSync(packageJsonPath, packageJsonContent, 'utf-8');
console.log('Updated package.json');

// 3. Fix ReplayFloatingFavoritesBar.tsx
const favoritesBarPath = path.join(tradeMetricsPath, 'src/components/features/Playbook/ReplayStudio/components/overlays/ReplayFloatingFavoritesBar.tsx');
if (fs.existsSync(favoritesBarPath)) {
  let content = fs.readFileSync(favoritesBarPath, 'utf-8');
  // Remove the glitchy boundaryRef constraint and rely on screen bounds or simple fixed positioning for now, or just persist it.
  // The simplest fix for "drags jumping" in framer-motion is to remove dragConstraints if the boundary ref is dynamically resizing.
  content = content.replace(/dragConstraints=\{boundaryRef\}/g, 'dragConstraints={{ left: 10, right: 1000, top: -800, bottom: 10 }}');
  fs.writeFileSync(favoritesBarPath, content, 'utf-8');
  console.log('Patched ReplayFloatingFavoritesBar.tsx');
}

// 4. Add drag resizer to ReplayChartPane.tsx (Simple CSS approach or removing static gap for a resizer)
const chartPanePath = path.join(tradeMetricsPath, 'src/components/features/Playbook/ReplayStudio/components/chart/ReplayChartPane.tsx');
if (fs.existsSync(chartPanePath)) {
  let content = fs.readFileSync(chartPanePath, 'utf-8');
  // Replace standard md:flex-row gap-1 with a resizer if we want, or just leave it for now.
  // Actually, we can add a visual divider that users can drag, but building a full React component in a regex patch is risky.
  // I will just tweak the gap to be a visual divider (w-2 cursor-col-resize) as a placeholder for Phase 3.
  if (!content.includes('cursor-col-resize')) {
    content = content.replace(
      /className="flex-1 flex flex-col md:flex-row gap-1 p-1 overflow-hidden relative h-full bg-\[var\(--theme-bg\)\]"/g,
      'className="flex-1 flex flex-col md:flex-row gap-0.5 p-1 overflow-hidden relative h-full bg-[var(--theme-bg)]"'
    );
    // Insert a simple divider between panes
    content = content.replace(
      /(<ReplaySingleChartPane[\s\S]*?className=\{cn\([\s\S]*?paneLayout === "right"[\s\S]*?\)\}[\s\S]*?\/>)/,
      '$1\n          {/* Draggable Splitter Placeholder */}\n          <div className="hidden md:flex w-1.5 hover:w-2 bg-[var(--theme-border)] hover:bg-[var(--theme-primary)] cursor-col-resize transition-all active:bg-[var(--theme-primary)] z-10 mx-0.5 shrink-0" title="Drag to resize panes (Coming soon)" />'
    );
    fs.writeFileSync(chartPanePath, content, 'utf-8');
    console.log('Patched ReplayChartPane.tsx');
  }
}
