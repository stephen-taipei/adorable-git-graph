export * from './scene/LogGraphScene';
export * from './scene/geometry';
export * from './viewer/GitGraphCanvas';
export * from './viewer/GitGraphViewer';
export * from './viewer/useStableLayout';
export * from './viewer/ErrorBoundary';
export * from './viewer/Mascot';
export * from './themes/config';
export * from './i18n';
import viewerCss from './viewer/viewer.css?inline';

/**
 * viewer 結構樣式字串：Shadow DOM 注入用。一般頁面可 `import '@adorable/graph-ui/viewer.css'`。
 * 顏色與字型由主題樣式提供（`@adorable/graph-ui/themes/<id>.css`），只載入目前的主題。
 */
export { viewerCss };
