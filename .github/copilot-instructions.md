# MatrixCharts Architecture Rules
- This is a strict zero-dependency TypeScript library.
- Do NOT suggest importing external packages (e.g., gl-matrix, d3, lodash).
- All vector/matrix math must be written natively.
- Use strict TypeScript typing for all methods and returns.